"use strict";

const { env, requireKey } = require("../env");
const { fetchWithRetry } = require("../http");

/**
 * LLM providers for the text passes: summaries and segment enrichment
 * (shortTitle, keywords, meaningfulness).
 *
 * All three expose the same shape:
 *   complete({ system, user, model, tier, maxTokens, json }) -> string
 *
 * Note this axis is SEPARATE from the ASR axis. Anthropic appears here and not
 * in the ASR list because Claude has no speech-to-text capability — the API
 * accepts text, images and PDFs, not audio. Claude is an excellent choice for
 * the text work and cannot do the transcription work.
 *
 * TWO TIERS PER PROVIDER
 *
 *   fast    the default. Bulk classification of transcript sentences is a
 *           high-volume, low-difficulty job; a small model does it well and
 *           the run is dominated by that call count.
 *   heavy   used only where the small model actually falls down — long or
 *           detailed summaries, and retries of a batch it returned unusable
 *           output for. See chooseTier() in ../llm.js for the policy.
 *
 * An explicit `model` always wins over the tier. `tier` is a request, not a
 * guarantee: a provider with no heavy model configured stays on the fast one.
 */

/**
 * Reasoning models bill and consume the output budget for thinking, and reject
 * nothing else about the payload — but sending `reasoning` to a non-reasoning
 * model is a 400. Detect by family rather than maintaining a model list that
 * goes stale the week after it is written.
 */
const REASONING_MODEL = /^(gpt-5|o[1-9])/i;

/**
 * Provider failures carry the HTTP status so callers can tell a deterministic
 * rejection from a transient one. Retrying a 400 on a larger model changes
 * nothing except the bill.
 */
function providerError(label, status, statusText, body) {
  const error = new Error(`${label} ${status} ${statusText}\n${JSON.stringify(body)}`);
  error.status = status;
  // 408/429 are throttling, not a bad request; everything else in 4xx will
  // fail identically however many times it is sent.
  error.deterministic = status >= 400 && status < 500 && status !== 408 && status !== 429;
  return error;
}

/** Resolve the model for a call: explicit > tier > provider default. */
function modelFor(provider, { model, tier } = {}) {
  if (model) return String(model).trim();
  if (tier === "heavy") return provider.heavyModel();
  return provider.defaultModel();
}

/* ------------------------------------------------------------------ */
/*  OpenAI                                                             */
/* ------------------------------------------------------------------ */

const openaiLlm = {
  id: "openai",
  label: "OpenAI",
  keyEnv: "OPENAI_API_KEY",
  defaultModel: () => env("OPENAI_LLM_MODEL", "gpt-5-mini"),
  heavyModel: () => env("OPENAI_LLM_MODEL_HEAVY", env("OPENAI_LLM_MODEL", "gpt-5")),

  async complete({ system, user, model, tier, maxTokens = 4096, json = false }) {
    const apiKey = requireKey(null, "OPENAI_API_KEY", "OpenAI");
    const chosen = modelFor(this, { model, tier });

    const payload = {
      model: chosen,
      max_output_tokens: maxTokens,
      input: [
        { role: "system", content: [{ type: "input_text", text: system }] },
        { role: "user", content: [{ type: "input_text", text: user }] },
      ],
    };
    if (json) payload.text = { format: { type: "json_object" } };

    // Reasoning is charged against max_output_tokens. At the default effort a
    // model can spend the entire budget thinking and return a completed
    // response with no text at all, which reads as "the API broke". Low effort
    // is both the cheaper and the more predictable choice for these two jobs;
    // the heavy tier is where a caller has already said the task is hard.
    if (REASONING_MODEL.test(chosen)) {
      payload.reasoning = {
        effort: env("OPENAI_REASONING_EFFORT", tier === "heavy" ? "medium" : "low"),
      };
    }

    const response = await fetchWithRetry("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const body = await response.json();
    if (!response.ok) {
      throw providerError("OpenAI", response.status, response.statusText, body);
    }

    if (typeof body.output_text === "string" && body.output_text.trim()) {
      return body.output_text.trim();
    }
    if (Array.isArray(body.output)) {
      const text = body.output
        .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
        .filter((c) => c.type === "output_text" && typeof c.text === "string")
        .map((c) => c.text.trim())
        .filter(Boolean)
        .join("\n")
        .trim();
      if (text) return text;
    }

    // Distinguish "ran out of budget" from "returned nothing" — the fix for
    // the first is a bigger maxTokens or lower reasoning effort, and for the
    // second it is the prompt.
    if (body.status === "incomplete") {
      const why = body.incomplete_details?.reason || "unknown";
      throw new Error(
        `OpenAI stopped before answering (${why}). Model ${chosen} used its ` +
        `${maxTokens}-token budget without producing text — raise maxTokens or ` +
        `lower OPENAI_REASONING_EFFORT.`
      );
    }
    throw new Error(`OpenAI returned empty output from ${chosen}.`);
  },
};

/* ------------------------------------------------------------------ */
/*  Anthropic                                                          */
/* ------------------------------------------------------------------ */

const anthropicLlm = {
  id: "anthropic",
  label: "Anthropic Claude",
  keyEnv: "ANTHROPIC_API_KEY",
  defaultModel: () => env("ANTHROPIC_LLM_MODEL", "claude-haiku-4-5-20251001"),
  heavyModel: () =>
    env("ANTHROPIC_LLM_MODEL_HEAVY", env("ANTHROPIC_LLM_MODEL", "claude-sonnet-5")),

  async complete({ system, user, model, tier, maxTokens = 4096, json = false }) {
    const apiKey = requireKey(null, "ANTHROPIC_API_KEY", "Anthropic");

    // JSON mode is expressed through the system prompt rather than a flag.
    const systemPrompt = json
      ? `${system}\n\nRespond with a single valid JSON object and nothing else. No markdown fences, no commentary.`
      : system;

    const response = await fetchWithRetry("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": env("ANTHROPIC_API_VERSION", "2023-06-01"),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelFor(this, { model, tier }),
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: "user", content: user }],
        // temperature is deliberately omitted: newer Claude models reject
        // sampling parameters with a 400.
      }),
    });

    const body = await response.json();
    if (!response.ok) {
      throw providerError("Anthropic", response.status, response.statusText, body);
    }

    const text = (body.content || [])
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text.trim())
      .filter(Boolean)
      .join("\n")
      .trim();

    if (!text) throw new Error("Anthropic returned empty output.");
    return text;
  },
};

/* ------------------------------------------------------------------ */
/*  Gemini                                                             */
/* ------------------------------------------------------------------ */

const geminiLlm = {
  id: "gemini",
  label: "Google Gemini",
  keyEnv: "GEMINI_API_KEY",
  defaultModel: () => env("GEMINI_LLM_MODEL", "gemini-2.5-flash"),
  heavyModel: () => env("GEMINI_LLM_MODEL_HEAVY", env("GEMINI_LLM_MODEL", "gemini-2.5-pro")),

  async complete({ system, user, model, tier, maxTokens = 4096, json = false }) {
    const apiKey = requireKey(null, "GEMINI_API_KEY", "Google Gemini");
    const chosen = modelFor(this, { model, tier });

    const response = await fetchWithRetry(
      `https://generativelanguage.googleapis.com/v1beta/models/${chosen}:generateContent`,
      {
        method: "POST",
        headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: user }] }],
          generationConfig: {
            maxOutputTokens: maxTokens,
            responseMimeType: json ? "application/json" : "text/plain",
          },
        }),
      }
    );

    const body = await response.json();
    if (!response.ok) {
      throw providerError("Gemini", response.status, response.statusText, body);
    }

    const text = (body?.candidates?.[0]?.content?.parts || [])
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("")
      .trim();

    if (!text) throw new Error("Gemini returned empty output.");
    return text;
  },
};

module.exports = {
  openaiLlm,
  anthropicLlm,
  geminiLlm,
  modelFor,
  providerError,
  REASONING_MODEL,
};
