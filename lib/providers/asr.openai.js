"use strict";

const fsp = require("fs/promises");
const path = require("path");
const { env, requireKey } = require("../env");
const { fetchWithRetry } = require("../http");

const API_BASE = "https://api.openai.com/v1";

/**
 * OpenAI speech-to-text.
 *
 * `whisper-1` is the only OpenAI model exposing verbose_json with
 * timestamp_granularities. The gpt-4o-transcribe family supports
 * response_format json|text only and has no timestamp capability at all —
 * which is exactly why v1 of this library could not produce timings.
 */
const openaiAsr = {
  id: "openai",
  label: "OpenAI",
  keyEnv: "OPENAI_API_KEY",

  models: {
    word: "whisper-1",
    segment: "whisper-1",
    proportional: "gpt-4o-transcribe",
  },

  /** Hard API limit on the audio upload. */
  maxUploadBytes: 25 * 1024 * 1024,

  capabilities: {
    word: { supported: true, toleranceSec: 0.1 },
    segment: { supported: true, toleranceSec: 0.5 },
    proportional: { supported: true, toleranceSec: 15 },
  },

  resolveKey: (explicit) => requireKey(explicit, "OPENAI_API_KEY", "OpenAI"),

  async transcribeChunk(chunkPath, options = {}) {
    const apiKey = this.resolveKey(options.apiKey);
    const timingMode = options.timingMode || "word";
    const startSec = options.startSec || 0;
    const model = options.model || this.models[timingMode];
    const timestamped = timingMode !== "proportional";

    const form = new FormData();
    form.set("model", model);
    form.set("response_format", timestamped ? "verbose_json" : "text");

    if (timestamped) {
      form.append("timestamp_granularities[]", timingMode === "word" ? "word" : "segment");
      if (timingMode === "word") form.append("timestamp_granularities[]", "segment");
    }

    form.set("prompt", options.prompt || "");
    if (options.language) form.set("language", options.language);

    const buffer = await fsp.readFile(chunkPath);
    form.set("file", new Blob([buffer], { type: "audio/mpeg" }), path.basename(chunkPath));

    const response = await fetchWithRetry(`${API_BASE}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });

    const body = await response.text();
    if (!response.ok) {
      throw new Error(
        `OpenAI transcription failed for ${path.basename(chunkPath)}: ` +
        `${response.status} ${response.statusText}\n${body}`
      );
    }

    if (!timestamped) {
      return { text: body.trim(), words: [], segments: [] };
    }

    const json = JSON.parse(body);
    const shift = (n) => Number((Number(n) + startSec).toFixed(3));

    return {
      text: (json.text || "").trim(),
      language: json.language || options.language || null,
      words: (json.words || []).map((w) => ({
        w: w.word,
        s: shift(w.start),
        e: shift(w.end),
      })),
      segments: (json.segments || []).map((s) => ({
        start: shift(s.start),
        end: shift(s.end),
        text: (s.text || "").trim(),
        confidence: logprobToConfidence(s.avg_logprob),
        noSpeechProb: typeof s.no_speech_prob === "number" ? s.no_speech_prob : null,
      })),
    };
  },
};

/** Whisper reports avg_logprob; map it onto a rough 0..1 confidence. */
function logprobToConfidence(avgLogprob) {
  if (typeof avgLogprob !== "number") return 1;
  return Number(Math.max(0, Math.min(1, Math.exp(avgLogprob))).toFixed(3));
}

module.exports = { openaiAsr };
