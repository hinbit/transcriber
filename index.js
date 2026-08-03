"use strict";

const fsp = require("fs/promises");
const path = require("path");

const { loadEnv, env, envInt, envBool } = require("./lib/env");
const { mapLimit } = require("./lib/shell");
const {
  probeDurationSec,
  probeMedia,
  convertToMp3IfNeeded,
  splitWithOverlap,
} = require("./lib/ffmpeg");
const {
  parseYouTubeUrl,
  isYoutubeUrl,
  youtubeEmbedUrl,
  youtubeThumbUrl,
  getYoutubeMetadata,
  downloadYoutubeAsMp3,
} = require("./lib/youtube");
const {
  getAsrProvider,
  getLlmProvider,
  assertTimingSupported,
  listProviders,
  assertConfigured,
} = require("./lib/providers/registry");
const { summarizeText, enrichSegments, chooseTier } = require("./lib/llm");
const {
  dedupeOverlap,
  mergeWordsToSentences,
  sentencesFromAsrSegments,
  distributeSentencesOverWindow,
  toSegments,
  toVTT,
  toSRT,
  timecode,
} = require("./lib/segments");
const { TranscriptCache, fileSha256 } = require("./lib/cache");

loadEnv();

/**
 * Fallback tolerances. The real value comes from the selected ASR provider —
 * Gemini's segment timings are coarser than whisper's, and the result must say
 * so rather than quoting a number it cannot deliver.
 */
const TIMING_TOLERANCE_SEC = {
  word: 0.1,
  segment: 0.5,
  proportional: 15,
};

/* ------------------------------------------------------------------ */
/*  Source resolution                                                  */
/* ------------------------------------------------------------------ */

/**
 * Accepts a YouTube URL (or bare 11-char id) or a local file path and returns
 * a normalized descriptor plus a local mp3. This is the single entry point that
 * makes "paste a link" and "upload a file" interchangeable everywhere else.
 */
async function resolveSource(source, options = {}) {
  const workDir = path.resolve(options.workDir || env("TRANSCRIBER_WORK_DIR", "storage/work"));
  const audioDir = path.join(workDir, "audio");
  const report = options.onProgress || (() => {});

  const youtube = parseYouTubeUrl(source);

  if (youtube) {
    report({ stage: "metadata", done: 0, total: 1 });
    let metadata = null;
    try {
      metadata = await getYoutubeMetadata(youtube.originalUrl);
    } catch (error) {
      // Metadata is a nice-to-have; a private-but-downloadable video still works.
      if (options.strictMetadata) throw error;
    }
    report({ stage: "metadata", done: 1, total: 1 });

    if (metadata?.isLive) {
      throw new Error("Live streams cannot be transcribed. Wait for the VOD.");
    }

    report({ stage: "download", done: 0, total: 1 });
    const mp3Path = await downloadYoutubeAsMp3(youtube.originalUrl, audioDir, {
      cookiesFile: options.cookiesFile || env("YTDLP_COOKIES_FILE"),
      proxy: options.proxy || env("YTDLP_PROXY"),
      verbose: options.verbose,
    });
    report({ stage: "download", done: 1, total: 1 });

    return {
      sourceType: "youtube",
      videoId: youtube.videoId,
      url: youtube.originalUrl,
      embedUrl: metadata?.embedUrl || youtubeEmbedUrl(youtube.videoId, { startSec: youtube.startSec }),
      startSec: youtube.startSec,
      title: metadata?.title || youtube.videoId,
      thumbnail: metadata?.thumbnail || youtubeThumbUrl(youtube.videoId),
      // Trust yt-dlp's reported duration over the downloaded mp3: they can
      // differ when YouTube serves a different rendition.
      durationSec: metadata?.durationSec || (await probeDurationSec(mp3Path)),
      width: metadata?.width ?? null,
      height: metadata?.height ?? null,
      fps: metadata?.fps ?? null,
      mp3Path,
    };
  }

  report({ stage: "convert", done: 0, total: 1 });
  const absolute = path.resolve(source);
  const media = await probeMedia(absolute).catch(() => null);
  const mp3Path = await convertToMp3IfNeeded(absolute, { outputDir: audioDir });
  report({ stage: "convert", done: 1, total: 1 });

  return {
    sourceType: "local",
    videoId: null,
    inputPath: absolute,
    title: path.basename(absolute, path.extname(absolute)),
    durationSec: media?.durationSec || (await probeDurationSec(mp3Path)),
    width: media?.width ?? null,
    height: media?.height ?? null,
    fps: media?.fps ?? null,
    aspect: media?.aspect ?? null,
    mp3Path,
  };
}

/* ------------------------------------------------------------------ */
/*  Main pipeline                                                      */
/* ------------------------------------------------------------------ */

/**
 * The function this whole version exists for: transcription that returns
 * sentences with usable timestamps.
 *
 * modes:
 *   "word"         whisper-1 verbose_json word timings. ±0.1s. Default.
 *   "segment"      whisper-1 segment timings only. ±0.5s. Slightly cheaper.
 *   "proportional" gpt-4o-transcribe text + character interpolation. ±15s.
 */
async function transcribeToSegments(source, options = {}) {
  const mode = options.timingMode || env("TRANSCRIBER_TIMING_MODE", "word");

  // Resolve and validate providers BEFORE downloading anything. Discovering
  // that Gemini cannot do word-level timing after a 40-minute yt-dlp run is a
  // bad way to find out.
  const asr = getAsrProvider(options.asrProvider);
  const capability = assertTimingSupported(asr, mode);
  const apiKey = asr.resolveKey(options.apiKey);
  const language = options.language || env("TRANSCRIBER_LANGUAGE", "he");
  const workDir = path.resolve(options.workDir || env("TRANSCRIBER_WORK_DIR", "storage/work"));
  const report = options.onProgress || (() => {});
  const concurrency = options.concurrency || envInt("TRANSCRIBER_CONCURRENCY", 3);

  const resolved = await resolveSource(source, { ...options, workDir, onProgress: report });

  const audioSha256 = await fileSha256(resolved.mp3Path);
  const cache = new TranscriptCache(options.cacheDir || path.join(workDir, ".cache"));
  cache.enabled = options.cache !== false && envBool("TRANSCRIBER_CACHE", true);

  report({ stage: "split", done: 0, total: 1 });
  const { chunks, chunkSeconds, overlapSec } = await splitWithOverlap(resolved.mp3Path, {
    chunkDir: path.join(workDir, "chunks"),
    durationSec: resolved.durationSec,
    chunkSeconds: options.chunkSeconds,
    overlapSec: options.overlapSec,
  });
  report({ stage: "split", done: 1, total: 1 });

  const timestamped = mode !== "proportional";
  const model = options.model || asr.models[mode];

  let completed = 0;
  const results = await mapLimit(chunks, concurrency, async (chunk) => {
    // The provider id is part of the cache key: the same audio transcribed by
    // OpenAI and by Gemini are different results and must not collide.
    const cacheKey = await cache.key(chunk.file, {
      provider: asr.id, model, language, mode,
      prompt: options.prompt || null,
      vocabulary: options.vocabulary || null,
    });

    let payload = await cache.get(cacheKey);
    if (!payload) {
      payload = await asr.transcribeChunk(chunk.file, {
        apiKey, language, model,
        timingMode: mode,
        startSec: chunk.startSec,
        chunkDurationSec: chunkSeconds + overlapSec,
        prompt: buildAsrPrompt(options),
      });
      await cache.set(cacheKey, payload);
    }

    report({ stage: "transcribe", done: ++completed, total: chunks.length });
    return { chunk, payload };
  });

  // Build sentence drafts according to the mode.
  let drafts;
  if (mode === "word") {
    const words = dedupeOverlap(results.flatMap((r) => r.payload.words || []));
    if (words.length === 0) {
      throw new Error(
        `No word timestamps were returned by ${asr.label} (model ${model}). ` +
        "For OpenAI, confirm the model is whisper-1 — the gpt-4o-transcribe " +
        "family cannot produce timestamps at all."
      );
    }
    drafts = mergeWordsToSentences(words, options.segmentation);
  } else if (mode === "segment") {
    const asrSegments = results
      .flatMap((r) => r.payload.segments || [])
      .sort((a, b) => a.start - b.start);
    drafts = dedupeSegments(sentencesFromAsrSegments(asrSegments));
  } else {
    drafts = results.flatMap(({ chunk, payload }) =>
      distributeSentencesOverWindow(
        payload.text,
        chunk.startSec,
        Math.min(chunk.startSec + chunkSeconds, resolved.durationSec)
      ).map((d) => ({ ...d, sourceChunk: chunk.index }))
    );
  }

  let segments = toSegments(drafts, { timingMode: mode, segmentation: options.segmentation });

  // Optional LLM pass: batched, and only over segments that survived the
  // heuristic filter, so it never sees the third that was free to reject.
  if (options.enrich !== false && envBool("TRANSCRIBER_ENRICH", true)) {
    report({ stage: "enrich", done: 0, total: 1 });
    const candidates = segments.filter((s) => s.meaningful);
    const enriched = await enrichSegments(candidates, {
      provider: options.llmProvider,
      language,
      model: options.enrichModel,
    });
    const byId = new Map(enriched.map((s) => [s.id, s]));
    segments = segments.map((s) => byId.get(s.id) || s);
    report({ stage: "enrich", done: 1, total: 1 });
  }

  const text = results.map((r) => r.payload.text).filter(Boolean).join("\n");
  const meaningfulCount = segments.filter((s) => s.meaningful).length;

  return {
    sourceType: resolved.sourceType,
    videoId: resolved.videoId,
    url: resolved.url || null,
    embedUrl: resolved.embedUrl || null,
    inputPath: resolved.inputPath || null,
    title: resolved.title,
    thumbnail: resolved.thumbnail || null,
    mp3Path: resolved.mp3Path,
    durationSec: resolved.durationSec,
    width: resolved.width,
    height: resolved.height,
    fps: resolved.fps,
    audioSha256,
    language,
    engine: model,
    providers: {
      asr: asr.id,
      llm: options.enrich === false ? null : getLlmProvider(options.llmProvider).id,
    },
    timing: {
      mode,
      // Provider-declared, not a global constant: the same mode name means
      // different accuracy on different engines.
      toleranceSec: capability.toleranceSec ?? TIMING_TOLERANCE_SEC[mode],
      chunkSeconds,
      overlapSec,
      note: timingNote(mode, asr, capability),
    },
    stats: {
      segmentsTotal: segments.length,
      segmentsMeaningful: meaningfulCount,
      avgConfidence: segments.length
        ? Number((segments.reduce((sum, s) => sum + s.confidence, 0) / segments.length).toFixed(3))
        : 0,
    },
    text,
    segments,
  };
}

const DEFAULT_ASR_PROMPT =
  "Transcribe verbatim in the source language. Preserve punctuation, proper nouns, " +
  "product names, numbers and quotations. Do not translate and do not summarize.";

function buildAsrPrompt(options = {}) {
  if (options.prompt) return options.prompt;
  if (Array.isArray(options.vocabulary) && options.vocabulary.length > 0) {
    return `${DEFAULT_ASR_PROMPT} Expected terms: ${options.vocabulary.join(", ")}.`;
  }
  return DEFAULT_ASR_PROMPT;
}

function timingNote(mode, asr, capability) {
  if (mode === "proportional") {
    return "Timings were interpolated by character count, not measured. Correct them before publishing.";
  }
  if (asr.id === "gemini") {
    return `${asr.label} reports MM:SS timestamps (±${capability.toleranceSec}s) and is a generative ` +
      "model, not a dedicated ASR engine. Segments with implausible timings were dropped. " +
      "Use ASR_PROVIDER=openai with timingMode=word for frame-accurate annotation.";
  }
  return null;
}

/** Whisper segment lists from overlapping chunks repeat; keep the first copy. */
function dedupeSegments(segments) {
  const out = [];
  let lastEnd = -Infinity;
  for (const segment of segments) {
    if (segment.start < lastEnd - 0.25) continue;
    out.push(segment);
    lastEnd = segment.end;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  File writers                                                       */
/* ------------------------------------------------------------------ */

async function writeOutputs(result, options = {}) {
  const outputDir = path.resolve(options.outputDir || env("TRANSCRIBER_OUTPUT_DIR", "output_text"));
  await fsp.mkdir(outputDir, { recursive: true });

  const base = options.baseName || result.videoId || slugify(result.title) || "transcript";
  const files = {};

  const transcriptJson = {
    schemaVersion: "1.0",
    kind: "transcript",
    projectId: options.projectId || base,
    videoId: result.videoId || base,
    language: result.language,
    dir: options.dir || (result.language === "he" ? "rtl" : "ltr"),
    durationSec: result.durationSec,
    asr: {
      engine: result.engine,
      provider: "@hinbit/transcriber@2",
      chunkSeconds: result.timing.chunkSeconds,
      audioSha256: result.audioSha256,
      generatedAt: new Date().toISOString(),
    },
    timing: result.timing,
    stats: result.stats,
    segments: result.segments,
  };

  files.transcriptJson = path.join(outputDir, `${base}.transcript.json`);
  await fsp.writeFile(files.transcriptJson, JSON.stringify(transcriptJson, null, 2), "utf8");

  files.vtt = path.join(outputDir, `${base}.vtt`);
  await fsp.writeFile(
    files.vtt,
    toVTT(result.segments, {
      language: result.language,
      note: result.timing.note,
    }),
    "utf8"
  );

  if (options.srt !== false) {
    files.srt = path.join(outputDir, `${base}.srt`);
    await fsp.writeFile(files.srt, toSRT(result.segments), "utf8");
  }

  files.txt = path.join(outputDir, `${base}.txt`);
  await fsp.writeFile(files.txt, result.text, "utf8");

  return files;
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\w\u0590-\u05FF-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/* ------------------------------------------------------------------ */
/*  v1-compatible surface                                              */
/* ------------------------------------------------------------------ */

/**
 * Kept so existing v1 callers keep working. These return the old flat
 * `transcriptText` shape and carry NO timing information — new code should
 * call transcribeToSegments() instead.
 */
async function transcribe(source, options = {}) {
  const result = await transcribeToSegments(source, {
    ...options,
    timingMode: options.timingMode || "word",
  });
  const files = await writeOutputs(result, options);

  return {
    sourceType: result.sourceType,
    url: result.url,
    inputPath: result.inputPath,
    mp3Path: result.mp3Path,
    transcriptText: result.text,
    transcriptFile: files.txt,
    segments: result.segments,
    timing: result.timing,
  };
}

const transcribeYoutube = (url, options = {}) => {
  if (!isYoutubeUrl(url)) throw new Error("A valid YouTube URL is required.");
  return transcribe(url, options);
};

const transcribeLocalFile = (inputPath, options = {}) => transcribe(inputPath, options);

module.exports = {
  // primary
  transcribeToSegments,
  resolveSource,
  writeOutputs,

  // youtube
  parseYouTubeUrl,
  isYoutubeUrl,
  youtubeEmbedUrl,
  youtubeThumbUrl,
  getYoutubeMetadata,
  downloadYoutubeAsMp3,

  // media
  probeMedia,
  probeDurationSec,
  convertToMp3IfNeeded,
  splitWithOverlap,

  // providers
  listProviders,
  assertConfigured,
  getAsrProvider,
  getLlmProvider,

  // text
  summarizeText,
  enrichSegments,
  chooseTier,

  // configuration
  loadEnv,

  // pure helpers (re-exported for consumers and tests)
  dedupeOverlap,
  mergeWordsToSentences,
  distributeSentencesOverWindow,
  toSegments,
  toVTT,
  toSRT,
  timecode,

  // compat
  transcribe,
  transcribeYoutube,
  transcribeLocalFile,

  TIMING_TOLERANCE_SEC,
};
