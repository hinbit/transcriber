"use strict";

const { env, envInt } = require("./env");
const { getLlmProvider } = require("./providers/registry");

/**
 * Text passes, provider-agnostic. Whichever LLM_PROVIDER is configured,
 * these two functions behave identically from the caller's point of view.
 */

/**
 * Which model tier a call should use.
 *
 * The small model is the right default: enrichment is thousands of short
 * classifications where it matches the large model's answers, and the cost
 * difference is the whole budget. Escalation is reserved for the two places
 * that measurably differ — input long enough that the small model loses the
 * thread, and a call it has already answered badly.
 *
 *   TRANSCRIBER_LLM_ESCALATE   auto (default) | never | always
 *   TRANSCRIBER_LLM_HEAVY_CHARS   input length that counts as complex
 *
 * `never` pins everything to the fast model, for a hard cost ceiling.
 * `always` pins everything to the heavy one, for a quality baseline to
 * compare against.
 */
function chooseTier({ complex = false, retry = false } = {}) {
  const mode = String(env("TRANSCRIBER_LLM_ESCALATE", "auto")).toLowerCase();

  if (mode === "never") return "fast";
  if (mode === "always") return "heavy";
  return complex || retry ? "heavy" : "fast";
}

/** Input long enough that the small model starts dropping the thread. */
function isComplexInput(text) {
  return String(text || "").length > envInt("TRANSCRIBER_LLM_HEAVY_CHARS", 12000);
}

async function summarizeText(text, options = {}) {
  if (!text || !String(text).trim()) throw new Error("Text is required.");

  const provider = getLlmProvider(options.provider);
  const language = options.language || env("TRANSCRIBER_LANGUAGE", "he");
  const style = options.style || "concise";

  const system = options.prompt || (language === "he"
    ? `סכם את הטקסט בעברית בצורה ${style === "detailed" ? "מפורטת" : "קצרה"}, מדויקת וברורה.`
    : `Summarize the text in a ${style === "detailed" ? "detailed" : "concise"}, precise and clear way.`);

  // A detailed summary of an hour-long lecture is exactly the case the small
  // model handles worst, and it is one call per project — the wrong place to
  // economise.
  const tier = options.tier
    || chooseTier({ complex: style === "detailed" || isComplexInput(text) });

  return provider.complete({
    system,
    user: String(text),
    model: options.model,
    tier,
    maxTokens: options.maxTokens || 2048,
  });
}

/**
 * Add shortTitle, keywords and a meaningfulness verdict to segments.
 *
 * Batched deliberately: one call per segment costs roughly 20x more for the
 * same answer. Only segments that already passed the free heuristic filter
 * should be sent here.
 */
async function enrichSegments(segments, options = {}) {
  if (!segments || segments.length === 0) return [];

  const provider = getLlmProvider(options.provider);
  const batchSize = options.batchSize || envInt("TRANSCRIBER_LLM_BATCH_SIZE", 40);
  const language = options.language || env("TRANSCRIBER_LANGUAGE", "he");
  const out = [];

  // The word "json" must appear literally. OpenAI's json_object response
  // format rejects any request whose prompt does not contain it — a 400 that
  // fails every batch and, because enrichment degrades silently by design,
  // shows up only as annotations that are never drafted.
  const system =
    "You classify transcript sentences for an interactive video-annotation tool. " +
    "For each item return: meaningful (true only if the sentence carries standalone " +
    "informational value — not filler, greetings, or fragments), score between 0 and 1, " +
    `shortTitle (at most 4 words, in language "${language}"), and keywords (at most 3, ` +
    `in language "${language}"). ` +
    "Reply with a single JSON object and nothing else — no markdown fences, no commentary. " +
    'The JSON must have exactly this shape: {"items":[{"i":0,"meaningful":true,"score":0.9,' +
    '"shortTitle":"...","keywords":["..."]}]} — one entry per input item, keeping its "i".';

  for (let i = 0; i < segments.length; i += batchSize) {
    const batch = segments.slice(i, i + batchSize);
    const payload = batch.map((segment, j) => ({ i: i + j, text: segment.text }));
    const user = JSON.stringify(payload);

    const attempt = async (tier) => {
      const raw = await provider.complete({
        system,
        user,
        model: options.model,
        tier,
        maxTokens: options.maxTokens || 4096,
        json: true,
      });
      return JSON.parse(raw.replace(/```json|```/g, "").trim());
    };

    // A caller that names a tier gets that tier, first attempt and retry both.
    const firstTier = options.tier || chooseTier({});
    const retryTier = options.tier || chooseTier({ retry: true });

    let parsed;
    try {
      parsed = await attempt(firstTier);
    } catch (firstError) {
      // The small model failing on a batch is the signal that this batch is
      // the hard kind — malformed JSON, a truncated array, a refusal. Retry it
      // once on the heavy model rather than paying for the heavy model on the
      // 99% of batches that were fine. Nothing to gain when both tiers resolve
      // to the same model.
      try {
        if (retryTier === firstTier) throw firstError;
        // A rejected request (bad prompt, missing key, unknown model) fails the
        // same way on any model. Escalating it only spends money to be told the
        // same thing twice.
        if (firstError.deterministic) throw firstError;
        if (process.env.TRANSCRIBER_DEBUG) {
          console.warn(`[enrich] batch at ${i} failed on the ${firstTier} model, retrying ${retryTier}: ${firstError.message}`);
        }
        parsed = await attempt(retryTier);
      } catch (error) {
        // Enrichment is an enhancement, never a gate. A failed batch degrades
        // to the heuristic verdict rather than losing a transcript.
        if (process.env.TRANSCRIBER_DEBUG) {
          console.warn(`[enrich] batch at ${i} failed: ${error.message}`);
        }
        out.push(...batch.map((segment) => ({ ...segment })));
        continue;
      }
    }

    const byIndex = new Map((parsed.items || []).map((item) => [item.i, item]));
    batch.forEach((segment, j) => {
      const hit = byIndex.get(i + j);
      out.push(hit ? {
        ...segment,
        meaningful: Boolean(hit.meaningful),
        score: Number.isFinite(Number(hit.score)) ? Number(hit.score) : segment.score,
        shortTitle: hit.shortTitle || null,
        keywords: Array.isArray(hit.keywords) ? hit.keywords.slice(0, 3) : [],
      } : { ...segment });
    });
  }

  return out;
}

module.exports = { summarizeText, enrichSegments, chooseTier, isComplexInput };
