"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseYouTubeUrl,
  isYoutubeUrl,
  youtubeEmbedUrl,
  dedupeOverlap,
  mergeWordsToSentences,
  distributeSentencesOverWindow,
  toSegments,
  toVTT,
  toSRT,
  timecode,
  TIMING_TOLERANCE_SEC,
} = require("../index.js");

/* ---------------------------------------------------------------- */
/*  YouTube                                                          */
/* ---------------------------------------------------------------- */

test("parseYouTubeUrl accepts every shape users actually paste", () => {
  const shapes = [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtu.be/dQw4w9WgXcQ",
    "https://m.youtube.com/watch?v=dQw4w9WgXcQ&feature=share",
    "https://www.youtube.com/shorts/dQw4w9WgXcQ",
    "https://www.youtube.com/embed/dQw4w9WgXcQ",
    "https://www.youtube.com/live/dQw4w9WgXcQ",
    "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    "youtube.com/watch?v=dQw4w9WgXcQ",
    "dQw4w9WgXcQ",
  ];
  for (const shape of shapes) {
    assert.equal(parseYouTubeUrl(shape)?.videoId, "dQw4w9WgXcQ", `failed on ${shape}`);
  }
});

test("parseYouTubeUrl rejects lookalike hosts that v1's regex accepted", () => {
  assert.equal(parseYouTubeUrl("https://youtube.com.attacker.example/watch?v=dQw4w9WgXcQ"), null);
  assert.equal(parseYouTubeUrl("https://notyoutu.be/dQw4w9WgXcQ"), null);
  assert.equal(parseYouTubeUrl("https://vimeo.com/12345"), null);
  assert.equal(parseYouTubeUrl(""), null);
  assert.equal(parseYouTubeUrl(null), null);
  assert.equal(isYoutubeUrl("https://youtube.com.attacker.example/x"), false);
});

test("parseYouTubeUrl reads both timestamp formats", () => {
  assert.equal(parseYouTubeUrl("https://youtu.be/dQw4w9WgXcQ?t=90").startSec, 90);
  assert.equal(parseYouTubeUrl("https://youtu.be/dQw4w9WgXcQ?t=90s").startSec, 90);
  assert.equal(parseYouTubeUrl("https://youtu.be/dQw4w9WgXcQ?t=1h2m10s").startSec, 3730);
  assert.equal(parseYouTubeUrl("https://youtu.be/dQw4w9WgXcQ?start=45").startSec, 45);
  assert.equal(parseYouTubeUrl("https://youtu.be/dQw4w9WgXcQ").startSec, null);
});

test("youtubeEmbedUrl sets the flags the IFrame clock needs", () => {
  const url = youtubeEmbedUrl("dQw4w9WgXcQ", { origin: "https://app.example", startSec: 30 });
  assert.ok(url.startsWith("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"));
  assert.ok(url.includes("enablejsapi=1"));
  assert.ok(url.includes("origin=https%3A%2F%2Fapp.example"));
  assert.ok(url.includes("start=30"));
  assert.ok(url.includes("playsinline=1"));
});

/* ---------------------------------------------------------------- */
/*  Overlap handling — the reason v2 exists                          */
/* ---------------------------------------------------------------- */

test("dedupeOverlap drops words repeated by the chunk overlap", () => {
  // chunk 0 ends at 300.5; chunk 1 starts 1.5s early and repeats two words
  const words = [
    { w: "לפני", s: 298.0, e: 298.4 },
    { w: "הסוף", s: 298.4, e: 299.0 },
    { w: "ואז", s: 299.2, e: 299.6 },
    { w: "ואז", s: 299.2, e: 299.6 },   // duplicate from chunk 1
    { w: "ממשיכים", s: 299.6, e: 300.4 },
    { w: "ממשיכים", s: 299.6, e: 300.4 }, // duplicate
    { w: "הלאה", s: 300.5, e: 301.0 },
  ];
  const out = dedupeOverlap(words);
  assert.equal(out.length, 5);
  assert.deepEqual(out.map((w) => w.w), ["לפני", "הסוף", "ואז", "ממשיכים", "הלאה"]);
});

test("dedupeOverlap keeps legitimately repeated words that are far apart", () => {
  const words = [
    { w: "כן", s: 1.0, e: 1.3 },
    { w: "כן", s: 5.0, e: 5.3 },
  ];
  assert.equal(dedupeOverlap(words).length, 2);
});

/* ---------------------------------------------------------------- */
/*  Segmentation                                                     */
/* ---------------------------------------------------------------- */

test("mergeWordsToSentences breaks on punctuation and on silence", () => {
  const words = [
    { w: "המערכת", s: 0.0, e: 0.4 },
    { w: "מזהה", s: 0.4, e: 0.8 },
    { w: "את", s: 0.8, e: 0.9 },
    { w: "המטופל.", s: 0.9, e: 1.4 },
    { w: "לאחר", s: 3.0, e: 3.3 },
    { w: "מכן", s: 3.3, e: 3.6 },
    { w: "נשלחת", s: 3.6, e: 4.0 },
    { w: "התראה.", s: 4.0, e: 4.5 },
  ];
  const segments = mergeWordsToSentences(words);
  assert.equal(segments.length, 2);
  assert.equal(segments[0].start, 0);
  assert.equal(segments[0].end, 1.4);
  assert.equal(segments[1].start, 3.0);
  assert.ok(segments[0].text.endsWith("המטופל."));
});

test("mergeWordsToSentences caps a monologue with no punctuation", () => {
  const words = Array.from({ length: 80 }, (_, i) => ({
    w: `מילה${i}`, s: i * 0.3, e: i * 0.3 + 0.28,
  }));
  const segments = mergeWordsToSentences(words);
  assert.ok(segments.length >= 3, "should split on the duration/word caps");
  for (const s of segments) {
    assert.ok(s.end - s.start <= 12.5, "no segment may exceed maxDurationSec");
  }
});

test("proportional distribution stays in its window and weights by length", () => {
  const drafts = distributeSentencesOverWindow(
    "קצר. משפט שני שהוא ארוך משמעותית מהראשון ולכן אמור לקבל נתח זמן גדול יותר.",
    300, 600
  );
  assert.equal(drafts.length, 2);
  assert.equal(drafts[0].start, 300);
  assert.ok(drafts[1].end <= 600);
  assert.ok((drafts[1].end - drafts[1].start) > (drafts[0].end - drafts[0].start));
});

test("proportional segments are flagged approximate", () => {
  const drafts = distributeSentencesOverWindow("משפט ראשון כאן. משפט שני כאן.", 0, 300);
  const segments = toSegments(drafts, { timingMode: "proportional" });
  assert.ok(segments.every((s) => s.approximate === true));
  assert.equal(TIMING_TOLERANCE_SEC.proportional, 15);
  assert.equal(TIMING_TOLERANCE_SEC.word, 0.1);
});

test("filler-only speech is rejected before it ever reaches the LLM", () => {
  const words = [
    { w: "אה", s: 0, e: 0.3 },
    { w: "אמ", s: 0.3, e: 0.6 },
    { w: "כאילו", s: 0.6, e: 0.9 },
    { w: "יעני", s: 0.9, e: 1.2 },
  ];
  const segments = toSegments(mergeWordsToSentences(words), { timingMode: "word" });
  assert.equal(segments[0].meaningful, false);
});

test("a real sentence survives the heuristic filter", () => {
  const words = [
    { w: "המערכת", s: 0.0, e: 0.5 },
    { w: "מזהה", s: 0.5, e: 0.9 },
    { w: "את", s: 0.9, e: 1.0 },
    { w: "המטופל", s: 1.0, e: 1.5 },
    { w: "לפי", s: 1.5, e: 1.8 },
    { w: "תעודת", s: 1.8, e: 2.2 },
    { w: "זהות.", s: 2.2, e: 2.8 },
  ];
  const segments = toSegments(mergeWordsToSentences(words), { timingMode: "word" });
  assert.equal(segments[0].meaningful, true);
  assert.equal(segments[0].approximate, false);
  assert.equal(segments[0].id, "seg_001");
});

/* ---------------------------------------------------------------- */
/*  Subtitle export                                                  */
/* ---------------------------------------------------------------- */

const SAMPLE = [
  { id: "seg_001", index: 0, start: 12.4, end: 17.85, text: "משפט ראשון בעל משמעות.",
    shortTitle: null, speaker: null, confidence: 0.94, meaningful: true, score: 0.88,
    keywords: [], words: [], approximate: false, sourceChunk: null },
  { id: "seg_002", index: 1, start: 18.1, end: 19.02, text: "אה רגע.",
    shortTitle: null, speaker: null, confidence: 0.61, meaningful: false, score: 0.05,
    keywords: [], words: [], approximate: false, sourceChunk: null },
];

test("timecode formats hours, minutes and milliseconds", () => {
  assert.equal(timecode(0), "00:00:00.000");
  assert.equal(timecode(12.4), "00:00:12.400");
  assert.equal(timecode(3661.5), "01:01:01.500");
  assert.equal(timecode(3661.5, false), "01:01:01");
});

test("toVTT emits only meaningful cues and keeps segment ids", () => {
  const vtt = toVTT(SAMPLE, { language: "he" });
  assert.ok(vtt.startsWith("WEBVTT"));
  assert.ok(vtt.includes("Language: he"));
  assert.ok(vtt.includes("seg_001"));
  assert.ok(!vtt.includes("seg_002"));
  assert.ok(vtt.includes("00:00:12.400 --> 00:00:17.850"));
});

test("toVTT carries the accuracy warning into the file", () => {
  const vtt = toVTT(SAMPLE, { note: "Timings were interpolated." });
  assert.ok(vtt.includes("NOTE"));
  assert.ok(vtt.includes("interpolated"));
});

test("toSRT uses comma decimals and sequential numbering", () => {
  const srt = toSRT(SAMPLE);
  assert.ok(srt.startsWith("1\n"));
  assert.ok(srt.includes("00:00:12,400 --> 00:00:17,850"));
  assert.ok(!srt.includes("אה רגע"));
});

/* ---------------------------------------------------------------- */
/*  Provider registry                                                */
/* ---------------------------------------------------------------- */

const {
  listProviders,
  getAsrProvider,
  getLlmProvider,
} = require("../index.js");
const { parseTimestamp, sanitizeSegments } = require("../lib/providers/asr.gemini.js");

test("both ASR providers and all three LLM providers are registered", () => {
  const registry = listProviders();
  assert.deepEqual(registry.asr.map((p) => p.id).sort(), ["gemini", "openai"]);
  assert.deepEqual(registry.llm.map((p) => p.id).sort(), ["anthropic", "gemini", "openai"]);
});

test("ASR_PROVIDER=anthropic fails with an explanation, not a generic error", () => {
  assert.throws(() => getAsrProvider("anthropic"), (error) => {
    assert.match(error.message, /speech-to-text/i);
    assert.match(error.message, /LLM_PROVIDER/);
    return true;
  });
});

test("anthropic IS available as an LLM provider", () => {
  const provider = getLlmProvider("anthropic");
  assert.equal(provider.id, "anthropic");
  assert.equal(provider.keyEnv, "ANTHROPIC_API_KEY");
  assert.ok(provider.defaultModel().startsWith("claude-"));
});

test("unknown providers list the valid options", () => {
  assert.throws(() => getAsrProvider("whisper-local"), /Available: openai, gemini/);
  assert.throws(() => getLlmProvider("llama"), /Available: openai, anthropic, gemini/);
});

test("gemini declares word mode unsupported with a reason and an alternative", () => {
  const gemini = listProviders().asr.find((p) => p.id === "gemini");
  assert.equal(gemini.timingModes.word.supported, false);
  assert.match(gemini.timingModes.word.reason, /MM:SS/);
  assert.equal(gemini.timingModes.segment.supported, true);
});

test("tolerance differs per provider for the same mode name", () => {
  const registry = listProviders();
  const openai = registry.asr.find((p) => p.id === "openai");
  const gemini = registry.asr.find((p) => p.id === "gemini");
  assert.equal(openai.timingModes.segment.toleranceSec, 0.5);
  assert.equal(gemini.timingModes.segment.toleranceSec, 1.5);
});

/* ---------------------------------------------------------------- */
/*  Gemini timestamp handling                                        */
/* ---------------------------------------------------------------- */

test("parseTimestamp handles MM:SS, HH:MM:SS and bare seconds", () => {
  assert.equal(parseTimestamp("00:12"), 12);
  assert.equal(parseTimestamp("02:30"), 150);
  assert.equal(parseTimestamp("01:02:03"), 3723);
  assert.equal(parseTimestamp("83.5"), 83.5);
  assert.equal(parseTimestamp(42), 42);
  assert.equal(parseTimestamp("not a time"), null);
  assert.equal(parseTimestamp(null), null);
});

test("sanitizeSegments drops hallucinated timings and applies the chunk offset", () => {
  const raw = [
    { start: "00:05", end: "00:09", text: "משפט תקין" },
    { start: "00:20", end: "00:15", text: "סוף לפני התחלה" },   // inverted
    { start: "00:02", end: "00:04", text: "קפיצה אחורה" },      // non-monotonic
    { start: "99:00", end: "99:10", text: "מעבר לאורך הקטע" },  // out of range
    { start: "00:12", end: "00:18", text: "" },                 // empty
    { start: "00:14", end: "00:19", text: "עוד משפט תקין" },
  ];
  const out = sanitizeSegments(raw, 300, 310);

  assert.equal(out.length, 2);
  assert.deepEqual(out.map((s) => s.text), ["משפט תקין", "עוד משפט תקין"]);
  assert.equal(out[0].start, 305); // chunk offset applied
  assert.equal(out[0].end, 309);
  assert.ok(out.every((s) => s.confidence === 0.85));
});

test("sanitizeSegments clamps an end that runs past the clip", () => {
  const out = sanitizeSegments([{ start: "00:05", end: "00:59", text: "ארוך מדי" }], 0, 30);
  assert.equal(out[0].end, 30);
});

/* ---------------------------------------------------------------- */
/*  Environment discovery                                            */
/* ---------------------------------------------------------------- */

const fs = require("node:fs");
const os = require("node:os");
const nodePath = require("node:path");
const { loadEnv, findEnvFile } = require("../lib/env.js");

/** Run a body with specific env vars set, restoring whatever was there. */
function withEnv(vars, body) {
  const saved = new Map(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return body();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("findEnvFile walks up to the repo root instead of only checking the cwd", () => {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "hinbit-env-"));
  const nested = nodePath.join(root, "packages", "server", "src");
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(nodePath.join(root, ".env"), "FOO=bar\n");

  // The case that motivated this: a workspace process started from a package
  // directory, with the .env three levels above it.
  assert.equal(findEnvFile(nested), nodePath.join(root, ".env"));
  fs.rmSync(root, { recursive: true, force: true });
});

test("findEnvFile prefers the nearest .env when several are in the chain", () => {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "hinbit-env-"));
  const pkg = nodePath.join(root, "packages", "server");
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(nodePath.join(root, ".env"), "FOO=root\n");
  fs.writeFileSync(nodePath.join(pkg, ".env"), "FOO=package\n");

  assert.equal(findEnvFile(pkg), nodePath.join(pkg, ".env"));
  fs.rmSync(root, { recursive: true, force: true });
});

test("loadEnv trims values and never overwrites an already-set variable", () => {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "hinbit-env-"));
  const file = nodePath.join(dir, ".env");
  fs.writeFileSync(file, 'PADDED_KEY=  sk-spaced  \nQUOTED_KEY="quoted"\nALREADY_SET=from-file\n');

  withEnv({ ALREADY_SET: "from-shell", PADDED_KEY: undefined, QUOTED_KEY: undefined }, () => {
    delete process.env.PADDED_KEY;
    delete process.env.QUOTED_KEY;
    loadEnv(file);

    // A trailing space on an API key produces a 401 indistinguishable from a
    // wrong key — this is the whole reason the loader exists.
    assert.equal(process.env.PADDED_KEY, "sk-spaced");
    assert.equal(process.env.QUOTED_KEY, "quoted");
    assert.equal(process.env.ALREADY_SET, "from-shell");
    delete process.env.PADDED_KEY;
    delete process.env.QUOTED_KEY;
  });

  fs.rmSync(dir, { recursive: true, force: true });
});

/* ---------------------------------------------------------------- */
/*  Model tiers and escalation                                       */
/* ---------------------------------------------------------------- */

const { chooseTier, isComplexInput } = require("../lib/llm.js");
const { modelFor, REASONING_MODEL, openaiLlm, anthropicLlm, geminiLlm } =
  require("../lib/providers/llm.js");

test("auto escalation keeps ordinary work on the fast model", () => {
  withEnv({ TRANSCRIBER_LLM_ESCALATE: "auto" }, () => {
    assert.equal(chooseTier({}), "fast");
    assert.equal(chooseTier({ complex: false }), "fast");
  });
});

test("auto escalation jumps to heavy for complex input and for retries", () => {
  withEnv({ TRANSCRIBER_LLM_ESCALATE: "auto" }, () => {
    assert.equal(chooseTier({ complex: true }), "heavy");
    assert.equal(chooseTier({ retry: true }), "heavy");
  });
});

test("escalation can be pinned off for a hard cost ceiling, or on as a baseline", () => {
  withEnv({ TRANSCRIBER_LLM_ESCALATE: "never" }, () => {
    assert.equal(chooseTier({ complex: true, retry: true }), "fast");
  });
  withEnv({ TRANSCRIBER_LLM_ESCALATE: "always" }, () => {
    assert.equal(chooseTier({}), "heavy");
  });
});

test("input length crosses into complex at the configured threshold", () => {
  withEnv({ TRANSCRIBER_LLM_HEAVY_CHARS: "100" }, () => {
    assert.equal(isComplexInput("x".repeat(100)), false);
    assert.equal(isComplexInput("x".repeat(101)), true);
  });
});

test("every LLM provider offers both tiers", () => {
  for (const provider of [openaiLlm, anthropicLlm, geminiLlm]) {
    assert.equal(typeof provider.defaultModel(), "string");
    assert.equal(typeof provider.heavyModel(), "string");
    assert.ok(provider.defaultModel().length > 0, `${provider.id} fast model`);
    assert.ok(provider.heavyModel().length > 0, `${provider.id} heavy model`);
  }
});

test("an explicit model beats the tier, and the tier beats the default", () => {
  withEnv({ OPENAI_LLM_MODEL: "fast-model", OPENAI_LLM_MODEL_HEAVY: "heavy-model" }, () => {
    assert.equal(modelFor(openaiLlm, { model: "pinned", tier: "heavy" }), "pinned");
    assert.equal(modelFor(openaiLlm, { tier: "heavy" }), "heavy-model");
    assert.equal(modelFor(openaiLlm, { tier: "fast" }), "fast-model");
    assert.equal(modelFor(openaiLlm, {}), "fast-model");
  });
});

test("a provider with no heavy model configured stays on the fast one", () => {
  withEnv({ OPENAI_LLM_MODEL: "only-model", OPENAI_LLM_MODEL_HEAVY: "" }, () => {
    // Escalating must never fail a run — worst case it is a no-op.
    assert.equal(modelFor(openaiLlm, { tier: "heavy" }), "only-model");
  });
});

test("reasoning parameters go only to models that accept them", () => {
  for (const model of ["gpt-5", "gpt-5-mini", "gpt-5.4-mini", "o3-mini", "o4-mini"]) {
    assert.ok(REASONING_MODEL.test(model), `${model} should be treated as reasoning`);
  }
  for (const model of ["gpt-4o", "gpt-4o-mini", "gpt-4.1-mini", "whisper-1"]) {
    assert.equal(REASONING_MODEL.test(model), false, `${model} would 400 on reasoning`);
  }
});

test("the provider registry reports both tiers and the escalation mode", () => {
  withEnv({ TRANSCRIBER_LLM_ESCALATE: "auto" }, () => {
    const registry = listProviders();
    assert.equal(registry.escalate, "auto");
    for (const provider of registry.llm) {
      assert.equal(typeof provider.defaultModel, "string");
      assert.equal(typeof provider.heavyModel, "string");
    }
  });
});

/* ---------------------------------------------------------------- */
/*  Enrichment contract with the provider                            */
/* ---------------------------------------------------------------- */

const { enrichSegments } = require("../lib/llm.js");
const { providerError } = require("../lib/providers/llm.js");

/** Stand in for a provider so the enrichment path is testable without network. */
function fakeProvider(handler) {
  const calls = [];
  return {
    calls,
    provider: {
      id: "fake",
      label: "Fake",
      keyEnv: "FAKE_KEY",
      defaultModel: () => "fake-fast",
      heavyModel: () => "fake-heavy",
      async complete(input) {
        calls.push(input);
        return handler(input, calls.length);
      },
    },
  };
}

test("the enrichment prompt says 'json' — OpenAI 400s on a json_object request without it", async () => {
  const { provider, calls } = fakeProvider(() => JSON.stringify({ items: [] }));
  await enrichSegments([{ id: "a", text: "שלום" }], { provider });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].json, true);
  assert.match(calls[0].system, /json/i);
});

test("a batch the fast model mangles is retried on the heavy model", async () => {
  const { provider, calls } = fakeProvider((_input, n) =>
    n === 1
      ? "not json at all"
      : JSON.stringify({ items: [{ i: 0, meaningful: true, score: 0.9, shortTitle: "טופס 17", keywords: ["טופס"] }] })
  );

  const out = await withEnv({ TRANSCRIBER_LLM_ESCALATE: "auto" }, () =>
    enrichSegments([{ id: "a", text: "טופס 17 מונפק על ידי הקופה." }], { provider })
  );

  assert.deepEqual(calls.map((c) => c.tier), ["fast", "heavy"]);
  assert.equal(out[0].meaningful, true);
  assert.equal(out[0].shortTitle, "טופס 17");
});

test("a rejected request is not re-sent to the heavy model", async () => {
  const { provider, calls } = fakeProvider(() => {
    throw providerError("Fake", 400, "Bad Request", { error: "bad prompt" });
  });

  const out = await withEnv({ TRANSCRIBER_LLM_ESCALATE: "auto" }, () =>
    enrichSegments([{ id: "a", text: "שלום", score: 0.4 }], { provider })
  );

  assert.equal(calls.length, 1, "a 400 fails identically on any model");
  // Enrichment is an enhancement, never a gate: the segment survives unenriched.
  assert.equal(out.length, 1);
  assert.equal(out[0].score, 0.4);
});

test("throttling and server errors stay escalatable", () => {
  assert.equal(providerError("X", 429, "Too Many Requests", {}).deterministic, false);
  assert.equal(providerError("X", 500, "Server Error", {}).deterministic, false);
  assert.equal(providerError("X", 400, "Bad Request", {}).deterministic, true);
  assert.equal(providerError("X", 401, "Unauthorized", {}).deterministic, true);
});

test("escalation off means a failed batch degrades instead of retrying", async () => {
  const { provider, calls } = fakeProvider(() => "still not json");

  const out = await withEnv({ TRANSCRIBER_LLM_ESCALATE: "never" }, () =>
    enrichSegments([{ id: "a", text: "שלום", score: 0.4 }], { provider })
  );

  assert.equal(calls.length, 1);
  assert.equal(out[0].score, 0.4);
});

/* ---------------------------------------------------------------- */
/*  Placeholder keys                                                 */
/* ---------------------------------------------------------------- */

const { isPlaceholder, hasKey, requireKey } = require("../lib/env.js");
const { assertConfigured } = require("../index.js");

test("the values shipped in .env.example do not count as configured keys", () => {
  for (const value of [
    "sk-proj-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "sk-ant-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "AIzaxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "your-key-here",
    "changeme",
    "<paste key>",
    "",
    "   ",
  ]) {
    assert.equal(isPlaceholder(value), true, `${value || "(empty)"} should read as unset`);
  }
});

test("a real-looking key is not mistaken for a placeholder", () => {
  // Shaped like the real thing, deliberately too short to be one — a false
  // positive here would lock someone out of their own correctly configured key.
  for (const value of [
    "sk-proj-N0tAReaLKey",
    "AIzaSyD-N0tAReaLKey",
    "sk-ant-api03-N0tAReaLKey",
  ]) {
    assert.equal(isPlaceholder(value), false, `${value} is a plausible key`);
  }
});

test("assertConfigured rejects a placeholder instead of failing mid-pipeline", () => {
  withEnv({ ASR_PROVIDER: "openai", LLM_PROVIDER: "openai", OPENAI_API_KEY: "sk-proj-xxxxxxxxxxxx" }, () => {
    assert.equal(hasKey("OPENAI_API_KEY"), false);
    // The whole point of the startup check: fail here, not after a 40-minute download.
    assert.throws(() => assertConfigured(), /OPENAI_API_KEY/);
    assert.throws(
      () => requireKey(null, "OPENAI_API_KEY", "OpenAI"),
      /placeholder/,
      "the message should name the actual problem"
    );
  });
});
