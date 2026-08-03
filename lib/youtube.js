"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { run, commandExists, resolveBinary } = require("./shell");

const ID_RE = /^[A-Za-z0-9_-]{11}$/;

/**
 * v1 used /(?:youtube\.com|youtu\.be)/i — which happily matches
 * "https://youtube.com.attacker.example/x". Parse the URL properly instead.
 */
function parseYouTubeUrl(input) {
  if (typeof input !== "string") return null;
  const raw = input.trim();
  if (!raw) return null;

  if (ID_RE.test(raw)) {
    return {
      videoId: raw,
      startSec: null,
      originalUrl: `https://www.youtube.com/watch?v=${raw}`,
    };
  }

  let url;
  try {
    url = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\.|^m\./, "").toLowerCase();
  if (!["youtube.com", "youtube-nocookie.com", "youtu.be"].includes(host)) {
    return null;
  }

  const parts = url.pathname.split("/").filter(Boolean);
  let videoId = null;

  if (host === "youtu.be") {
    videoId = parts[0] || null;
  } else if (parts[0] === "watch" || url.pathname === "/watch") {
    videoId = url.searchParams.get("v");
  } else if (["shorts", "embed", "live", "v"].includes(parts[0])) {
    videoId = parts[1] || null;
  }

  if (!videoId || !ID_RE.test(videoId)) return null;

  return {
    videoId,
    startSec: parseTimeParam(url.searchParams.get("t")) ??
      parseTimeParam(url.searchParams.get("start")),
    originalUrl: raw,
  };
}

function parseTimeParam(raw) {
  if (!raw) return null;
  const value = String(raw).trim();
  if (/^\d+$/.test(value)) return Number(value);
  const m = value.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
}

function isYoutubeUrl(value) {
  return parseYouTubeUrl(value) !== null;
}

function youtubeEmbedUrl(videoId, options = {}) {
  const host = options.noCookie === false
    ? "https://www.youtube.com"
    : "https://www.youtube-nocookie.com";
  const url = new URL(`${host}/embed/${videoId}`);

  if (options.enableJsApi !== false) url.searchParams.set("enablejsapi", "1");
  // Without a matching origin the IFrame API silently ignores postMessage.
  if (options.origin) url.searchParams.set("origin", options.origin);
  if (options.startSec > 0) url.searchParams.set("start", String(Math.floor(options.startSec)));
  url.searchParams.set("autoplay", options.autoplay ? "1" : "0");
  url.searchParams.set("controls", options.controls === false ? "0" : "1");
  url.searchParams.set("rel", "0");
  url.searchParams.set("playsinline", "1");
  if (options.hl) url.searchParams.set("hl", options.hl);

  return url.toString();
}

function youtubeThumbUrl(videoId, quality = "hq") {
  const map = {
    default: "default", mq: "mqdefault", hq: "hqdefault",
    sd: "sddefault", maxres: "maxresdefault",
  };
  return `https://i.ytimg.com/vi/${videoId}/${map[quality] || "hqdefault"}.jpg`;
}

/* ------------------------------------------------------------------ */
/*  yt-dlp                                                             */
/* ------------------------------------------------------------------ */

async function resolveYtDlp() {
  const localBin = path.resolve(".venv/bin/yt-dlp");
  if (await commandExists(localBin, ["--version"])) {
    return { command: localBin, args: [] };
  }
  const localPython = path.resolve(".venv/bin/python3");
  if (await commandExists(localPython, ["-m", "yt_dlp", "--version"])) {
    return { command: localPython, args: ["-m", "yt_dlp"] };
  }
  if (await commandExists("yt-dlp", ["--version"])) {
    return { command: "yt-dlp", args: [] };
  }
  if (await commandExists("python3", ["-m", "yt_dlp", "--version"])) {
    return { command: "python3", args: ["-m", "yt_dlp"] };
  }
  throw new Error(
    "yt-dlp is not installed. Install with `python3 -m pip install --user -U yt-dlp`."
  );
}

/**
 * Metadata without downloading. The annotator needs the real duration and the
 * player aspect BEFORE the audio job finishes, so the admin can show something
 * immediately after the URL is pasted.
 */
async function getYoutubeMetadata(input) {
  const parsed = parseYouTubeUrl(input);
  if (!parsed) throw new Error(`Not a valid YouTube URL: ${input}`);

  const ytDlp = await resolveYtDlp();
  const raw = await run(ytDlp.command, [
    ...ytDlp.args,
    parsed.originalUrl,
    "--no-playlist",
    "--skip-download",
    "--dump-single-json",
  ]);

  const info = JSON.parse(raw);
  return {
    videoId: info.id || parsed.videoId,
    title: info.title || "",
    durationSec: Number(info.duration) || 0,
    width: Number(info.width) || null,
    height: Number(info.height) || null,
    fps: Number(info.fps) || null,
    uploader: info.uploader || null,
    thumbnail: info.thumbnail || youtubeThumbUrl(parsed.videoId, "maxres"),
    isLive: Boolean(info.is_live),
    availability: info.availability || null,
    startSec: parsed.startSec,
    originalUrl: parsed.originalUrl,
    embedUrl: youtubeEmbedUrl(parsed.videoId, { startSec: parsed.startSec }),
  };
}

/**
 * Download audio as mp3.
 *
 * Changes from v1:
 *  - filename is `<videoId>.mp3`, not `%(title)s` — Hebrew titles with slashes
 *    or quotes produced unpredictable (sometimes unopenable) paths, and a
 *    stable name makes caching and re-runs work.
 *  - ffmpeg location resolved at runtime instead of hardcoded to /usr/bin.
 *  - skips the download entirely if the file is already there.
 */
async function downloadYoutubeAsMp3(videoUrl, outputDir = "output", options = {}) {
  const parsed = parseYouTubeUrl(videoUrl);
  if (!parsed) throw new Error("A valid YouTube URL is required.");

  const absoluteDir = path.resolve(outputDir);
  await fsp.mkdir(absoluteDir, { recursive: true });

  const target = path.join(absoluteDir, `${parsed.videoId}.mp3`);
  if (fs.existsSync(target) && options.reuse !== false) {
    return target;
  }

  const ytDlp = await resolveYtDlp();
  const ffmpeg = await resolveBinary("ffmpeg", [
    "/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg",
  ]);

  const args = [
    ...ytDlp.args,
    parsed.originalUrl,
    "--no-playlist",
    "--extract-audio",
    "--audio-format", "mp3",
    "--audio-quality", "0",
    "--ffmpeg-location", ffmpeg,
    "--output", path.join(absoluteDir, `${parsed.videoId}.%(ext)s`),
    "--no-progress",
    "--quiet",
  ];

  if (options.cookiesFile) args.push("--cookies", options.cookiesFile);
  if (options.proxy) args.push("--proxy", options.proxy);

  try {
    await run(ytDlp.command, args, { pipeStderr: Boolean(options.verbose) });
  } catch (error) {
    throw new Error(
      `yt-dlp failed for ${parsed.videoId}. YouTube changes break yt-dlp often — ` +
      `try \`python3 -m pip install -U yt-dlp\`.\n${error.message}`
    );
  }

  if (!fs.existsSync(target)) {
    throw new Error(`yt-dlp reported success but ${target} does not exist.`);
  }
  return target;
}

module.exports = {
  parseYouTubeUrl,
  parseTimeParam,
  isYoutubeUrl,
  youtubeEmbedUrl,
  youtubeThumbUrl,
  getYoutubeMetadata,
  downloadYoutubeAsMp3,
};
