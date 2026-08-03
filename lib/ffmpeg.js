"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { run, resolveBinary } = require("./shell");
const { envInt } = require("./env");

const FFMPEG_CANDIDATES = [
  "/usr/bin/ffmpeg",
  "/usr/local/bin/ffmpeg",
  "/opt/homebrew/bin/ffmpeg",
];
const FFPROBE_CANDIDATES = [
  "/usr/bin/ffprobe",
  "/usr/local/bin/ffprobe",
  "/opt/homebrew/bin/ffprobe",
];

const ffmpegBin = () => resolveBinary("ffmpeg", FFMPEG_CANDIDATES);
const ffprobeBin = () => resolveBinary("ffprobe", FFPROBE_CANDIDATES);

async function probeDurationSec(filePath) {
  const ffprobe = await ffprobeBin();
  const out = await run(ffprobe, [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath,
  ]);
  const duration = Number.parseFloat(out);
  if (!Number.isFinite(duration)) {
    throw new Error(`Could not determine duration for ${filePath}`);
  }
  return duration;
}

/** Full media info — needed by the annotator to compute the overlay aspect. */
async function probeMedia(filePath) {
  const ffprobe = await ffprobeBin();
  const raw = await run(ffprobe, [
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    filePath,
  ]);

  const parsed = JSON.parse(raw);
  const video = (parsed.streams || []).find((s) => s.codec_type === "video");
  const audio = (parsed.streams || []).find((s) => s.codec_type === "audio");

  let fps = null;
  if (video && video.r_frame_rate && video.r_frame_rate !== "0/0") {
    const [num, den] = video.r_frame_rate.split("/").map(Number);
    if (den) fps = Number((num / den).toFixed(3));
  }

  const width = video ? Number(video.width) : null;
  const height = video ? Number(video.height) : null;

  return {
    durationSec: Number.parseFloat(parsed.format?.duration ?? "0") || 0,
    sizeBytes: Number.parseInt(parsed.format?.size ?? "0", 10) || 0,
    width,
    height,
    aspect: width && height ? Number((width / height).toFixed(6)) : null,
    fps,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
  };
}

async function convertToMp3IfNeeded(inputPath, options = {}) {
  const absoluteInput = path.resolve(inputPath);
  if (!fs.existsSync(absoluteInput)) {
    throw new Error(`Input file not found: ${absoluteInput}`);
  }
  if (path.extname(absoluteInput).toLowerCase() === ".mp3") {
    return absoluteInput;
  }

  const outputDir = path.resolve(options.outputDir || "output");
  await fsp.mkdir(outputDir, { recursive: true });

  const base = path.basename(absoluteInput, path.extname(absoluteInput));
  const outputPath = path.join(outputDir, `${base}.mp3`);

  const ffmpeg = await ffmpegBin();
  await run(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", absoluteInput,
    "-vn",
    "-ac", "1",
    "-ar", String(options.sampleRate || 16000),
    "-b:a", options.bitrate || "64k",
    outputPath,
  ]);

  return outputPath;
}

/**
 * Split audio into API-sized chunks WITH OVERLAP.
 *
 * v1 used `-f segment -c copy`, which cuts on MP3 frame boundaries and reliably
 * clips the first syllable after every cut — a lost word every 5 minutes. Here
 * each chunk starts `overlapSec` early and we re-encode, so nothing is lost;
 * the duplicated words are removed later by `dedupeOverlap()` using timestamps.
 *
 * Re-encoding to mono 16kHz also keeps every chunk far below the 25MB API cap.
 */
async function splitWithOverlap(mp3Path, options = {}) {
  const chunkSeconds = options.chunkSeconds || envInt("TRANSCRIBER_CHUNK_SECONDS", 300);
  const overlapSec = options.overlapSec ?? Number(envInt("TRANSCRIBER_OVERLAP_MS", 1500)) / 1000;
  const chunkDir = path.resolve(options.chunkDir || path.join("output", "chunks"));

  await fsp.mkdir(chunkDir, { recursive: true });

  const durationSec = options.durationSec || (await probeDurationSec(mp3Path));
  const base = path.basename(mp3Path, path.extname(mp3Path)).replace(/[^\w-]+/g, "_");
  const ffmpeg = await ffmpegBin();
  const chunks = [];

  for (let i = 0, position = 0; position < durationSec; i++, position += chunkSeconds) {
    const from = i === 0 ? 0 : position - overlapSec;
    const length = chunkSeconds + (i === 0 ? 0 : overlapSec);
    const file = path.join(chunkDir, `${base}-${String(i).padStart(3, "0")}.mp3`);

    await run(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-ss", String(from),
      "-t", String(length),
      "-i", mp3Path,
      "-vn",
      "-ac", "1",
      "-ar", "16000",
      "-b:a", "64k",
      file,
    ]);

    const stat = await fsp.stat(file);
    if (stat.size === 0) {
      await fsp.unlink(file).catch(() => {});
      break;
    }

    chunks.push({ index: i, file, startSec: from, sizeBytes: stat.size });
  }

  if (chunks.length === 0) {
    throw new Error("ffmpeg produced no chunks. Is the audio track empty?");
  }

  return { chunks, durationSec, chunkSeconds, overlapSec };
}

module.exports = {
  probeDurationSec,
  probeMedia,
  convertToMp3IfNeeded,
  splitWithOverlap,
  ffmpegBin,
  ffprobeBin,
};
