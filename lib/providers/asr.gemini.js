"use strict";

const fsp = require("fs/promises");
const path = require("path");
const { env, requireKey } = require("../env");
const { fetchWithRetry } = require("../http");

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

/**
 * Gemini speech-to-text.
 *
 * Gemini is a generative model doing transcription, not a dedicated ASR model.
 * That has two consequences worth understanding before selecting it:
 *
 *  1. NO WORD-LEVEL TIMING. Timestamps come back as MM:SS strings, so the
 *     resolution is one second at best. We declare a 1.5s tolerance to account
 *     for that plus normal drift.
 *
 *  2. Timings can be wrong in ways a dedicated ASR model's cannot — a
 *     generative model can produce a plausible-looking timestamp it did not
 *     measure. Everything returned here is validated: non-monotonic or
 *     out-of-range segments are dropped rather than trusted.
 *
 * In exchange it is cheaper, often stronger on Hebrew phrasing and punctuation,
 * and can label speakers in the same pass. Good for search, summaries and
 * draft subtitles. For tooltip timing, prefer OpenAI word mode.
 */
const geminiAsr = {
  id: "gemini",
  label: "Google Gemini",
  keyEnv: "GEMINI_API_KEY",

  models: {
    segment: "gemini-2.5-flash",
    proportional: "gemini-2.5-flash",
  },

  /** Inline request cap is 20MB including the prompt; base64 inflates by ~33%. */
  maxUploadBytes: 13 * 1024 * 1024,

  capabilities: {
    word: {
      supported: false,
      reason: "Gemini returns MM:SS timestamps only — there is no word-level granularity.",
    },
    segment: { supported: true, toleranceSec: 1.5 },
    proportional: { supported: true, toleranceSec: 15 },
  },

  resolveKey: (explicit) =>
    requireKey(explicit, "GEMINI_API_KEY", "Google Gemini"),

  async transcribeChunk(chunkPath, options = {}) {
    const apiKey = this.resolveKey(options.apiKey);
    const timingMode = options.timingMode || "segment";
    const startSec = options.startSec || 0;
    const model = options.model || env("GEMINI_ASR_MODEL", this.models.segment);
    const chunkDuration = options.chunkDurationSec || null;

    const buffer = await fsp.readFile(chunkPath);
    if (buffer.byteLength > this.maxUploadBytes) {
      throw new Error(
        `${path.basename(chunkPath)} is ${(buffer.byteLength / 1e6).toFixed(1)}MB. ` +
        `Gemini inline audio must stay under ~13MB after base64. Lower TRANSCRIBER_CHUNK_SECONDS.`
      );
    }

    const wantTimestamps = timingMode !== "proportional";
    const languageHint = options.language
      ? ` The audio is in language code "${options.language}".`
      : "";
    const vocabularyHint = options.prompt ? ` ${options.prompt}` : "";

    const instruction = wantTimestamps
      ? "Transcribe the audio verbatim, split into natural sentences. " +
        "For each sentence give start and end timestamps in MM:SS format, measured " +
        "from the beginning of THIS audio clip (not from any larger recording). " +
        "Timestamps must increase monotonically and must not exceed the clip length. " +
        "Do not translate, do not summarize, do not invent content. " +
        "If a portion is inaudible, omit it rather than guessing." +
        languageHint + vocabularyHint
      : "Transcribe the audio verbatim. Preserve punctuation and proper nouns. " +
        "Do not translate or summarize." + languageHint + vocabularyHint;

    const body = {
      contents: [
        {
          role: "user",
          parts: [
            { text: instruction },
            {
              inline_data: {
                mime_type: "audio/mpeg",
                data: buffer.toString("base64"),
              },
            },
          ],
        },
      ],
      generationConfig: wantTimestamps
        ? {
            responseMimeType: "application/json",
            responseSchema: {
              type: "OBJECT",
              properties: {
                segments: {
                  type: "ARRAY",
                  items: {
                    type: "OBJECT",
                    properties: {
                      start: { type: "STRING", description: "MM:SS" },
                      end: { type: "STRING", description: "MM:SS" },
                      text: { type: "STRING" },
                      speaker: { type: "STRING" },
                    },
                    required: ["start", "end", "text"],
                  },
                },
              },
              required: ["segments"],
            },
          }
        : { responseMimeType: "text/plain" },
    };

    const response = await fetchWithRetry(
      `${API_BASE}/models/${model}:generateContent`,
      {
        method: "POST",
        headers: {
          "x-goog-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }
    );

    const raw = await response.text();
    if (!response.ok) {
      throw new Error(
        `Gemini transcription failed for ${path.basename(chunkPath)}: ` +
        `${response.status} ${response.statusText}\n${raw}`
      );
    }

    const json = JSON.parse(raw);
    const text = extractText(json);

    if (!wantTimestamps) {
      return { text: text.trim(), words: [], segments: [] };
    }

    let parsed;
    try {
      parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
    } catch {
      throw new Error(
        `Gemini returned malformed JSON for ${path.basename(chunkPath)}. ` +
        `Retry, or switch ASR_PROVIDER to openai.`
      );
    }

    const segments = sanitizeSegments(parsed.segments || [], startSec, chunkDuration);

    return {
      text: segments.map((s) => s.text).join(" ").trim(),
      language: options.language || null,
      words: [],
      segments,
    };
  },
};

function extractText(response) {
  const parts = response?.candidates?.[0]?.content?.parts || [];
  return parts
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("");
}

/** "01:23" | "1:02:03" | "83" | "83.5" -> seconds, or null. */
function parseTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);

  const parts = trimmed.split(":").map((p) => Number(p));
  if (parts.some((p) => !Number.isFinite(p))) return null;

  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

/**
 * Guard rail for generative timestamps. Drops anything non-monotonic, negative,
 * zero-length, or past the end of the clip. Silently trusting these is how you
 * end up with a tooltip firing three minutes early.
 */
function sanitizeSegments(rawSegments, startSec, chunkDurationSec) {
  const out = [];
  let lastEnd = 0;
  let dropped = 0;

  for (const raw of rawSegments) {
    const start = parseTimestamp(raw.start);
    const end = parseTimestamp(raw.end);
    const text = String(raw.text || "").trim();

    if (start === null || end === null || !text) { dropped++; continue; }
    if (start < 0 || end <= start) { dropped++; continue; }
    if (chunkDurationSec && start > chunkDurationSec + 1) { dropped++; continue; }
    if (start < lastEnd - 1.5) { dropped++; continue; }

    const clampedEnd = chunkDurationSec ? Math.min(end, chunkDurationSec) : end;
    lastEnd = clampedEnd;

    out.push({
      start: Number((start + startSec).toFixed(3)),
      end: Number((clampedEnd + startSec).toFixed(3)),
      text,
      speaker: raw.speaker || null,
      // Gemini gives no per-segment confidence. 0.85 keeps these above the
      // default 0.7 meaningfulness floor without pretending to be measured.
      confidence: 0.85,
      noSpeechProb: null,
    });
  }

  if (dropped > 0 && process.env.TRANSCRIBER_DEBUG) {
    console.warn(`[gemini] dropped ${dropped} invalid segment(s)`);
  }
  return out;
}

module.exports = { geminiAsr, parseTimestamp, sanitizeSegments };
