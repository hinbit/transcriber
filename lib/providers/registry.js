"use strict";

const { env, hasKey } = require("../env");
const { openaiAsr } = require("./asr.openai");
const { geminiAsr } = require("./asr.gemini");
const { openaiLlm, anthropicLlm, geminiLlm } = require("./llm");

/**
 * Two independent provider axes.
 *
 *   ASR_PROVIDER  openai | gemini      speech-to-text
 *   LLM_PROVIDER  openai | anthropic | gemini    summaries and enrichment
 *
 * Anthropic is absent from the ASR list on purpose. Claude has no
 * speech-to-text capability — the API accepts text, images and PDFs, not
 * audio. Setting ASR_PROVIDER=anthropic fails immediately with an explanation
 * rather than at some later point with a confusing error.
 */

const ASR_PROVIDERS = {
  openai: openaiAsr,
  gemini: geminiAsr,
};

const LLM_PROVIDERS = {
  openai: openaiLlm,
  anthropic: anthropicLlm,
  gemini: geminiLlm,
};

const ASR_UNSUPPORTED = {
  anthropic:
    "Anthropic does not offer a speech-to-text API — Claude accepts text, images and PDFs, not audio. " +
    "Use ASR_PROVIDER=openai or gemini for transcription; Claude is available for LLM_PROVIDER.",
};

function getAsrProvider(name) {
  const id = String(name || env("ASR_PROVIDER", "openai")).toLowerCase().trim();

  if (ASR_UNSUPPORTED[id]) {
    throw new Error(`ASR_PROVIDER="${id}" is not valid. ${ASR_UNSUPPORTED[id]}`);
  }

  const provider = ASR_PROVIDERS[id];
  if (!provider) {
    throw new Error(
      `Unknown ASR_PROVIDER "${id}". Available: ${Object.keys(ASR_PROVIDERS).join(", ")}.`
    );
  }
  return provider;
}

function getLlmProvider(name) {
  // Accept an already-built provider so callers can supply their own backend,
  // and so the text passes can be tested without a network round trip.
  if (name && typeof name === "object" && typeof name.complete === "function") {
    return name;
  }

  const id = String(name || env("LLM_PROVIDER", "openai")).toLowerCase().trim();
  const provider = LLM_PROVIDERS[id];
  if (!provider) {
    throw new Error(
      `Unknown LLM_PROVIDER "${id}". Available: ${Object.keys(LLM_PROVIDERS).join(", ")}.`
    );
  }
  return provider;
}

/**
 * Check a provider can actually deliver the requested timing accuracy, and say
 * exactly what to do about it if not. Called before any audio is downloaded —
 * failing after a 40-minute yt-dlp run would be needlessly cruel.
 */
function assertTimingSupported(provider, timingMode) {
  const capability = provider.capabilities?.[timingMode];

  if (!capability) {
    throw new Error(
      `Unknown timingMode "${timingMode}". Use word | segment | proportional.`
    );
  }
  if (!capability.supported) {
    const alternatives = Object.entries(provider.capabilities)
      .filter(([, c]) => c.supported)
      .map(([mode]) => mode);

    throw new Error(
      `${provider.label} cannot provide timingMode "${timingMode}". ` +
      `${capability.reason || ""} ` +
      `Supported by ${provider.label}: ${alternatives.join(", ")}. ` +
      `For word-level timings use ASR_PROVIDER=openai.`
    );
  }
  return capability;
}

function toleranceFor(provider, timingMode) {
  return provider.capabilities?.[timingMode]?.toleranceSec ?? null;
}

/** Machine-readable capability matrix — used by the CLI and the admin UI. */
function listProviders() {
  return {
    asr: Object.values(ASR_PROVIDERS).map((p) => ({
      id: p.id,
      label: p.label,
      keyEnv: p.keyEnv,
      keyPresent: hasKey(p.keyEnv),
      maxUploadBytes: p.maxUploadBytes,
      timingModes: Object.fromEntries(
        Object.entries(p.capabilities).map(([mode, c]) => [
          mode,
          c.supported
            ? { supported: true, toleranceSec: c.toleranceSec }
            : { supported: false, reason: c.reason },
        ])
      ),
    })),
    llm: Object.values(LLM_PROVIDERS).map((p) => ({
      id: p.id,
      label: p.label,
      keyEnv: p.keyEnv,
      keyPresent: hasKey(p.keyEnv),
      defaultModel: p.defaultModel(),
      heavyModel: p.heavyModel(),
    })),
    unsupported: Object.entries(ASR_UNSUPPORTED).map(([id, reason]) => ({
      axis: "asr", id, reason,
    })),
    selected: {
      asr: env("ASR_PROVIDER", "openai"),
      llm: env("LLM_PROVIDER", "openai"),
    },
    escalate: env("TRANSCRIBER_LLM_ESCALATE", "auto"),
  };
}

/** Fail at startup rather than mid-pipeline when a key is missing. */
function assertConfigured({ asr, llm } = {}) {
  const problems = [];

  try {
    const provider = getAsrProvider(asr);
    if (!hasKey(provider.keyEnv)) {
      problems.push(`ASR provider "${provider.id}" needs ${provider.keyEnv} in the environment.`);
    }
  } catch (error) {
    problems.push(error.message);
  }

  try {
    const provider = getLlmProvider(llm);
    if (!hasKey(provider.keyEnv)) {
      problems.push(`LLM provider "${provider.id}" needs ${provider.keyEnv} in the environment.`);
    }
  } catch (error) {
    problems.push(error.message);
  }

  if (problems.length > 0) {
    throw new Error(`Provider configuration problem:\n  - ${problems.join("\n  - ")}`);
  }
  return true;
}

module.exports = {
  ASR_PROVIDERS,
  LLM_PROVIDERS,
  getAsrProvider,
  getLlmProvider,
  assertTimingSupported,
  toleranceFor,
  listProviders,
  assertConfigured,
};
