"use strict";

/**
 * Turning raw ASR output into sentences that are worth showing as a tooltip.
 * Pure functions only — no I/O, no network. Everything here is unit-tested.
 */

const SENTENCE_END = /[.!?׃؟…]$/;

const FILLERS = new Set([
  "אה", "אהה", "אמ", "אמם", "המ", "הממ", "אוקיי", "אוקי", "נו", "כאילו",
  "יעני", "הא", "אהם", "מממ",
  "uh", "uhh", "um", "umm", "erm", "hmm", "mmm", "ok", "okay", "yeah", "yep",
]);

const normalize = (token) =>
  token.replace(/[\u0591-\u05C7]/g, "").replace(/["'׳״.,!?…:;]/g, "").trim().toLowerCase();

const DEFAULTS = {
  gapSec: 0.4,
  minWords: 4,
  maxWords: 35,
  maxDurationSec: 12,
  minConfidence: 0.7,
};

/**
 * Remove words duplicated by the chunk overlap.
 *
 * Because chunk N starts `overlapSec` before its nominal boundary, the first
 * words of every chunk after the first are already present at the tail of the
 * previous one. Timestamps make this trivial to detect: anything starting
 * meaningfully before the last accepted word ended is a duplicate.
 */
function dedupeOverlap(words, toleranceSec = 0.05) {
  const sorted = [...words].sort((a, b) => a.s - b.s);
  const out = [];
  let lastEnd = -Infinity;

  for (const word of sorted) {
    if (word.s < lastEnd - toleranceSec) continue;
    out.push(word);
    lastEnd = word.e;
  }
  return out;
}

/** Merge ASR words into sentences. Breaks on punctuation, silence, and caps. */
function mergeWordsToSentences(words, options = {}) {
  const opt = { ...DEFAULTS, ...options };
  if (!words || words.length === 0) return [];

  const out = [];
  let buffer = [];

  const flush = () => {
    if (buffer.length === 0) return;
    const first = buffer[0];
    const last = buffer[buffer.length - 1];
    const confidences = buffer.map((w) => (typeof w.conf === "number" ? w.conf : 1));
    out.push({
      start: first.s,
      end: last.e,
      text: buffer.map((w) => w.w).join(" ").replace(/\s+([.,!?׃:;])/g, "$1").trim(),
      words: [...buffer],
      confidence: confidences.reduce((a, b) => a + b, 0) / confidences.length,
    });
    buffer = [];
  };

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const previous = words[i - 1];

    if (previous && word.s - previous.e > opt.gapSec && buffer.length >= opt.minWords) {
      flush();
    }
    buffer.push(word);

    const tooLong = word.e - buffer[0].s >= opt.maxDurationSec;
    const endsSentence = SENTENCE_END.test(word.w);

    if ((endsSentence && buffer.length >= opt.minWords) || buffer.length >= opt.maxWords || tooLong) {
      flush();
    }
  }
  flush();

  return mergeTooShort(out, opt.minWords);
}

function mergeTooShort(segments, minWords) {
  const out = [];
  for (const segment of segments) {
    const count = segment.text.split(/\s+/).filter(Boolean).length;
    const previous = out[out.length - 1];
    if (count < minWords && previous && !SENTENCE_END.test(previous.text)) {
      previous.end = segment.end;
      previous.text = `${previous.text} ${segment.text}`.trim();
      previous.words.push(...segment.words);
      previous.confidence = (previous.confidence + segment.confidence) / 2;
    } else {
      out.push({ ...segment });
    }
  }
  return out;
}

/** Build sentences from whisper's own segment list (no word granularity). */
function sentencesFromAsrSegments(asrSegments) {
  return (asrSegments || [])
    .filter((s) => s.text && s.text.trim())
    .map((s) => ({
      start: s.start,
      end: s.end,
      text: s.text.trim(),
      words: [],
      confidence: typeof s.confidence === "number" ? s.confidence : 0.9,
    }));
}

function splitPlainTextToSentences(text) {
  return String(text)
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?׃…])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1);
}

/**
 * LAST RESORT. When the ASR gave us only text for a window, distribute that
 * window across sentences by character count.
 *
 * Speech rate is not uniform, so error accumulates toward the middle of the
 * window. With the default 300s chunk this means roughly ±15s. Everything
 * produced here must be flagged approximate and corrected by a human before
 * it drives tooltip timing.
 */
function distributeSentencesOverWindow(text, windowStart, windowEnd) {
  const sentences = splitPlainTextToSentences(text);
  if (sentences.length === 0) return [];

  const totalChars = sentences.reduce((sum, s) => sum + s.length, 0);
  const span = Math.max(0.001, windowEnd - windowStart);
  let cursor = windowStart;

  return sentences.map((sentence) => {
    const share = (sentence.length / totalChars) * span;
    const start = cursor;
    const end = Math.min(windowEnd, cursor + share);
    cursor = end;
    return { start, end, text: sentence, words: [], confidence: 0.75 };
  });
}

/** Cheap filter. Runs BEFORE any LLM call and removes ~a third of segments. */
function scoreMeaningfulnessHeuristic(segment, options = {}) {
  const opt = { ...DEFAULTS, ...options };
  const tokens = segment.text.split(/\s+/).filter(Boolean);
  const content = tokens.filter((t) => !FILLERS.has(normalize(t)));

  if (tokens.length < opt.minWords) return { meaningful: false, score: 0.05, reason: "too-short" };
  if (content.length / tokens.length < 0.5) return { meaningful: false, score: 0.05, reason: "mostly-filler" };
  if (segment.confidence < opt.minConfidence) return { meaningful: false, score: 0.2, reason: "low-confidence" };
  if (segment.end - segment.start < 0.6) return { meaningful: false, score: 0.1, reason: "too-brief" };

  const lengthScore = Math.min(1, content.length / 12);
  const score = Math.min(1, 0.45 * lengthScore + 0.55 * segment.confidence);
  return { meaningful: score >= 0.5, score, reason: "ok" };
}

function toSegments(drafts, options = {}) {
  const prefix = options.idPrefix || "seg";
  const approximate = options.timingMode === "proportional";

  return drafts.map((draft, i) => {
    const verdict = scoreMeaningfulnessHeuristic(draft, options.segmentation);
    return {
      id: `${prefix}_${String(i + 1).padStart(3, "0")}`,
      index: i,
      start: Number(draft.start.toFixed(3)),
      end: Number(draft.end.toFixed(3)),
      text: draft.text,
      shortTitle: null,
      speaker: null,
      confidence: Number(draft.confidence.toFixed(3)),
      meaningful: verdict.meaningful,
      score: Number(verdict.score.toFixed(3)),
      keywords: [],
      words: draft.words || [],
      approximate,
      sourceChunk: draft.sourceChunk ?? null,
    };
  });
}

/* ------------------------------------------------------------------ */
/*  Subtitle export                                                    */
/* ------------------------------------------------------------------ */

function timecode(seconds, withMs = true) {
  const safe = Math.max(0, seconds);
  const pad = (n, len = 2) => String(n).padStart(len, "0");
  const base = `${pad(Math.floor(safe / 3600))}:${pad(Math.floor((safe % 3600) / 60))}:${pad(Math.floor(safe % 60))}`;
  return withMs ? `${base}.${pad(Math.round((safe % 1) * 1000), 3)}` : base;
}

function wrapLine(text, at = 42) {
  if (text.length <= at) return text;
  const words = text.split(/\s+/);
  const lines = [];
  let current = "";
  for (const word of words) {
    if (current && `${current} ${word}`.length > at) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  // More than two subtitle lines is unreadable; fold the tail.
  return lines.length > 2 ? [lines[0], lines.slice(1).join(" ")].join("\n") : lines.join("\n");
}

function toVTT(segments, options = {}) {
  const { language = "he", meaningfulOnly = true, wrapAt = 42, note = null } = options;
  const list = meaningfulOnly ? segments.filter((s) => s.meaningful) : segments;

  const header = ["WEBVTT", "Kind: subtitles", `Language: ${language}`, ""];
  if (note) header.push("NOTE", note, "");

  const cues = list.map(
    (s) => `${s.id}\n${timecode(s.start)} --> ${timecode(s.end)} line:90% align:center\n${wrapLine(s.text, wrapAt)}\n`
  );
  return `${header.join("\n")}${cues.join("\n")}`;
}

function toSRT(segments, meaningfulOnly = true) {
  const list = meaningfulOnly ? segments.filter((s) => s.meaningful) : segments;
  return list
    .map((s, i) =>
      `${i + 1}\n${timecode(s.start).replace(".", ",")} --> ${timecode(s.end).replace(".", ",")}\n${s.text}\n`
    )
    .join("\n");
}

module.exports = {
  DEFAULTS,
  dedupeOverlap,
  mergeWordsToSentences,
  sentencesFromAsrSegments,
  splitPlainTextToSentences,
  distributeSentencesOverWindow,
  scoreMeaningfulnessHeuristic,
  toSegments,
  timecode,
  toVTT,
  toSRT,
};
