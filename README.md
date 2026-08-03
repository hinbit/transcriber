# @hinbit/transcriber

**v2.1.0** — transcription with usable timestamps, across OpenAI, Anthropic and Gemini.

Takes a YouTube link or a local media file and returns sentences with timings
accurate enough to drive subtitles and time-anchored UI. Node 20+, zero runtime
dependencies.

```js
const { transcribeToSegments } = require("@hinbit/transcriber");

const result = await transcribeToSegments("https://youtu.be/VIDEO_ID");

result.segments[0];
// {
//   id: "seg_001",
//   start: 12.4,
//   end: 17.85,
//   text: "המערכת מזהה את המטופל לפי מספר תעודת הזהות.",
//   shortTitle: "זיהוי מטופל",
//   meaningful: true,
//   words: [{ w: "המערכת", s: 12.4, e: 12.86 }, ...]
// }
```

---

## Providers

Two **independent** provider choices, because the vendors do not offer the same
things:

| Axis | Env var | Options |
|---|---|---|
| Speech-to-text | `ASR_PROVIDER` | `openai`, `gemini` |
| Text generation | `LLM_PROVIDER` | `openai`, `anthropic`, `gemini` |

> **Anthropic is not in the ASR list, and that is not an omission.** Claude has
> no speech-to-text API — it accepts text, images and PDFs, not audio. Setting
> `ASR_PROVIDER=anthropic` fails immediately with an explanation pointing you at
> `LLM_PROVIDER` instead. Claude is a strong choice for the text work and cannot
> do the transcription work.

### Timing accuracy by provider

The mode name alone does not tell you the accuracy — the provider does.

| Mode | OpenAI (`whisper-1`) | Gemini (`gemini-2.5-flash`) |
|---|---|---|
| `word` | **±0.1s** | **unsupported** — MM:SS only |
| `segment` | ±0.5s | ±1.5s |
| `proportional` | ±15s | ±15s |

`result.timing.toleranceSec` reports the real figure for whatever combination
you selected, rather than a constant.

Gemini is a generative model doing transcription, not a dedicated ASR engine.
It is cheaper, often strong on Hebrew phrasing, and can label speakers in the
same pass — but it can also produce a plausible-looking timestamp it never
measured. Every Gemini segment is validated: non-monotonic, inverted,
zero-length or out-of-range entries are dropped rather than trusted, and the
result carries a note explaining the tradeoff.

**Mixing is normal.** Cheap transcription plus strong Hebrew titling:

```bash
ASR_PROVIDER=gemini
LLM_PROVIDER=anthropic
```

### Two model tiers, and when the run escalates

Each LLM provider has a **fast** model and a **heavy** one:

```bash
OPENAI_LLM_MODEL=gpt-5-mini          # fast — runs everything by default
OPENAI_LLM_MODEL_HEAVY=gpt-5         # heavy — only where the small one struggles
```

The fast model is not a compromise for this workload. Enrichment is thousands
of one-line classifications, where a small model agrees with a large one and
the call count is the entire bill. Escalation is reserved for the two places
they measurably differ:

- a summary of a long transcript, or `style: "detailed"` — one call per project
- a retry of an enrichment batch the fast model answered with unusable JSON

```bash
TRANSCRIBER_LLM_ESCALATE=auto      # default
TRANSCRIBER_LLM_ESCALATE=never     # hard cost ceiling — fast model only
TRANSCRIBER_LLM_ESCALATE=always    # quality baseline to measure against
TRANSCRIBER_LLM_HEAVY_CHARS=12000  # input length that counts as complex
```

A rejected request — bad key, unknown model, malformed prompt — is **not**
escalated. It fails identically on a larger model, so retrying only doubles the
cost of learning that. Leaving `*_LLM_MODEL_HEAVY` unset disables escalation for
that provider: it falls back to the fast model rather than failing.

Pass `tier: "fast" | "heavy"` to `summarizeText()` or `enrichSegments()` to
override the policy for one call, or `model` to name a model outright.

For OpenAI's reasoning models, effort defaults to `low` on the fast tier and
`medium` on the heavy one. Reasoning tokens are billed against
`max_output_tokens`, and at high effort a model can spend the whole budget
thinking and return no text — `OPENAI_REASONING_EFFORT` overrides it.

Print the live matrix, including which keys are actually loaded:

```bash
hinbit-transcriber providers
```

```
Speech-to-text (ASR_PROVIDER)

  OpenAI [openai]  (key set) ← selected
    word          ±0.1s
    segment       ±0.5s
    proportional  ±15s

  Google Gemini [gemini]  (MISSING GEMINI_API_KEY)
    word          unsupported — Gemini returns MM:SS timestamps only
    segment       ±1.5s
    proportional  ±15s

Text generation (LLM_PROVIDER)
  OpenAI           gpt-5-mini                  (key set) ← selected
  Anthropic Claude claude-haiku-4-5-20251001   (key set)
  Google Gemini    gemini-2.5-flash            (MISSING GEMINI_API_KEY)
```

---

## Why v2

v1 posted to OpenAI with `response_format: "text"` using `gpt-4o-transcribe`.
That model family supports `json` and `text` only — it has **no timestamp
capability at all**. The result was a flat string, and the only surviving time
information was the 300-second chunk boundary.

For anything that has to line up with a video, a 5-minute resolution is not a
limitation, it is the absence of the feature.

v2 keeps the parts of v1 that worked — the yt-dlp flow, ffmpeg conversion, the
CLI — and rebuilds the transcription path around `whisper-1`, currently the only
OpenAI model exposing `verbose_json` with `timestamp_granularities`.

### Every change

| Area | v1 | v2 |
|---|---|---|
| Timestamps | none | word-level, ±0.1s |
| Model | `gpt-4o-transcribe` | `whisper-1` (configurable) |
| Return shape | `transcriptText: string` | `segments[]` with `words[]` |
| Chunking | `-c copy` at hard boundaries | re-encode with 1.5s overlap + dedupe |
| ASR prompt | hardcoded to one lecturer | configurable, `vocabulary[]` option |
| Chunk requests | sequential | bounded concurrency (default 3) |
| Cache key | chunk filename | audio content hash + parameters |
| ffmpeg path | hardcoded `/usr/bin/ffmpeg` | resolved at runtime |
| YouTube matching | `/youtube\.com\|youtu\.be/` regex | strict URL parsing |
| Downloaded filename | `%(title)s.mp3` | `<videoId>.mp3` |
| YouTube metadata | — | `getYoutubeMetadata()` without downloading |
| Subtitles | — | `toVTT()` / `toSRT()` |
| Sentence quality | — | filler filter + batched LLM enrichment |
| Progress | console logs | `onProgress` callback |
| Retries | fixed 1s, network errors only | exponential, honours `Retry-After` |

> **The regex matters.** v1's `/(?:youtube\.com|youtu\.be)/i` matches
> `https://youtube.com.attacker.example/watch?v=...`. v2 parses the URL and
> checks the hostname. There is a test for it.

---

## Install

```bash
npm install @hinbit/transcriber
```

**System requirements**

| Binary | Purpose |
|---|---|
| `ffmpeg` | audio conversion and chunking |
| `ffprobe` | duration and stream probing |
| `yt-dlp` | YouTube download |

```bash
sudo apt install ffmpeg
python3 -m pip install --user -U yt-dlp
```

Then copy `.env.example` to `.env` and set `OPENAI_API_KEY`.

---

## Timing modes

`proportional` exists because v1's approach still has a use: it is faster and
cheaper when you only need searchable text or a summary. It splits each chunk's
text into sentences and distributes the window by character count. Speech rate
is not uniform, so error accumulates toward the middle of each chunk.

Everything it produces is flagged `approximate: true`, and the result carries
`timing.note` explaining why. **Do not publish time-anchored UI off it without
human correction.**

---

## API

### `transcribeToSegments(source, options?)`

The main entry point. `source` is a YouTube URL, a bare 11-character video id,
or a path to a local audio/video file.

```js
const result = await transcribeToSegments("https://youtu.be/VIDEO_ID", {
  language: "he",
  timingMode: "word",
  vocabulary: ["טופס 17", "מרשם", "רוקח"],
  concurrency: 3,
  onProgress: ({ stage, done, total }) => {
    console.log(`${stage}: ${done}/${total}`);
  },
});
```

**Options**

| Option | Default | Notes |
|---|---|---|
| `language` | `"he"` | ISO 639-1 hint |
| `asrProvider` | `$ASR_PROVIDER` | `openai` \| `gemini` |
| `llmProvider` | `$LLM_PROVIDER` | `openai` \| `anthropic` \| `gemini` |
| `timingMode` | `"word"` | see table above |
| `vocabulary` | — | domain terms appended to the ASR prompt |
| `prompt` | — | replaces the default prompt entirely |
| `enrich` | `true` | batched LLM pass for titles and keywords |
| `concurrency` | `3` | parallel chunk requests |
| `chunkSeconds` | `300` | must keep chunks under 25MB |
| `overlapSec` | `1.5` | below ~0.8 words get clipped at seams |
| `cache` | `true` | keyed by audio hash + parameters |
| `segmentation` | — | `{ gapSec, minWords, maxWords, maxDurationSec }` |
| `cookiesFile` | — | for age-restricted videos |
| `onProgress` | — | `metadata → download → split → transcribe → enrich` |

**Returns**

```js
{
  sourceType: "youtube",
  videoId: "VIDEO_ID",
  embedUrl: "https://www.youtube-nocookie.com/embed/...",
  title: "...",
  durationSec: 612.4,
  width: 1920, height: 1080, fps: 30,
  audioSha256: "...",
  engine: "whisper-1",
  providers: { asr: "openai", llm: "anthropic" },
  timing: { mode: "word", toleranceSec: 0.1, chunkSeconds: 300, overlapSec: 1.5, note: null },
  stats: { segmentsTotal: 128, segmentsMeaningful: 74, avgConfidence: 0.91 },
  text: "...",
  segments: [ /* Segment[] */ ]
}
```

### `getYoutubeMetadata(url)`

Title, duration, dimensions and thumbnail **without downloading**. Use it the
moment a link is pasted so the operator sees a preview instead of a spinner.

```js
const meta = await getYoutubeMetadata("https://youtu.be/VIDEO_ID");
// { videoId, title, durationSec, width, height, fps, thumbnail, isLive, embedUrl }
```

### `writeOutputs(result, options?)`

Writes `.transcript.json`, `.vtt`, `.srt` and `.txt`.

```js
const files = await writeOutputs(result, { outputDir: "output_text" });
```

### `youtubeEmbedUrl(videoId, options?)`

```js
youtubeEmbedUrl("VIDEO_ID", { origin: "https://app.example", startSec: 30 });
```

> **`origin` is not optional in practice.** With `enablejsapi=1` but no matching
> `origin`, the YouTube IFrame API ignores every `postMessage` — silently. No
> error, no warning, the clock simply never advances. It must equal
> `window.location.origin` exactly, scheme and port included.

### Other exports

| Function | Purpose |
|---|---|
| `listProviders()` | capability matrix + which API keys are present |
| `assertConfigured()` | throws if the selected providers lack their keys |
| `parseYouTubeUrl(input)` | strict parse → `{ videoId, startSec, originalUrl }` |
| `isYoutubeUrl(value)` | boolean |
| `youtubeThumbUrl(id, quality)` | thumbnail URL |
| `probeMedia(file)` | duration, dimensions, aspect, fps, codecs |
| `resolveSource(source)` | normalise link-or-file → mp3 + metadata |
| `summarizeText(text, opts)` | standalone summary |
| `enrichSegments(segments)` | batched titling and keywords |
| `toVTT(segments, opts)` / `toSRT(segments)` | subtitle export |
| `dedupeOverlap`, `mergeWordsToSentences`, `toSegments` | pure helpers, unit-tested |

---

## CLI

```bash
hinbit-transcriber transcribe "https://youtu.be/VIDEO_ID"
hinbit-transcriber transcribe ./lecture.mp4 --lang he --vocab "מרשם,רוקח,טופס 17"
hinbit-transcriber transcribe "https://youtu.be/VIDEO_ID" --timing proportional
hinbit-transcriber info "https://youtu.be/VIDEO_ID"
hinbit-transcriber summarize --file ./transcript.txt --style detailed
hinbit-transcriber providers

# mix providers for one run
hinbit-transcriber transcribe ./call.m4a --asr gemini --timing segment --llm anthropic
```

| Flag | Default |
|---|---|
| `--lang <code>` | `he` |
| `--asr <provider>` | `$ASR_PROVIDER` |
| `--llm <provider>` | `$LLM_PROVIDER` |
| `--timing <mode>` | `word` |
| `--out <dir>` | `output_text` |
| `--name <base>` | video id |
| `--vocab <a,b,c>` | — |
| `--concurrency <n>` | `3` |
| `--chunk <seconds>` | `300` |
| `--no-enrich` | off |
| `--no-cache` | off |
| `--json` | off |

---

## How the pipeline works

```
source (YouTube URL | file)
  │
  ├─ parseYouTubeUrl ──► getYoutubeMetadata ──► downloadYoutubeAsMp3   (yt-dlp)
  └─ local file ───────────────────────────────► convertToMp3IfNeeded  (ffmpeg)
  │
  ▼
splitWithOverlap                 300s chunks, 1.5s lead-in, mono 16kHz
  │
  ▼
asr.transcribeChunk ×N           selected ASR provider, concurrency 3
  │                              cache: sha256(audio) + provider + params
  ▼
dedupeOverlap                    drop words repeated at the seams
  │
  ▼
mergeWordsToSentences            break on punctuation / silence / caps
  │
  ▼
scoreMeaningfulnessHeuristic     free filter — removes ~⅓ of segments
  │
  ▼
enrichSegments                   selected LLM provider, 40 segments per call
  │
  ▼
Segment[] ──► transcript.json + subtitles.vtt + subtitles.srt
```

Two details do most of the work:

**Overlap plus timestamp dedupe.** v1's `-c copy` cuts on MP3 frame boundaries
and reliably clips the first syllable after each cut — a lost word every five
minutes. v2 starts each chunk 1.5s early and removes the duplicates afterwards
by comparing timestamps, so nothing is lost and nothing is repeated.

**Heuristic before LLM.** The filler filter rejects roughly a third of segments
before any model sees them. That third costs nothing, which makes the
enrichment pass affordable at 40 segments per call.

---

## Cost

For a 60-minute Hebrew video with defaults:

| Stage | Notes |
|---|---|
| `whisper-1` | billed per minute of audio |
| Enrichment | ~2 calls (≈74 meaningful segments ÷ 40) |
| Re-run, unchanged | **free** — every chunk hits cache |

Turning `enrich` off removes the second row entirely. Changing the language,
prompt, vocabulary, model or timing mode invalidates the cache, because each of
those changes the output.

---

## Migrating from v1

`transcribe()`, `transcribeYoutube()` and `transcribeLocalFile()` still exist
and still return `transcriptText`, so existing callers keep working. They now
additionally return `segments` and `timing`.

```js
// v1
const { transcriptText } = await transcribe(url);

// v2 — same call, more data
const { transcriptText, segments, timing } = await transcribe(url);

// v2 — preferred
const result = await transcribeToSegments(url);
```

**Breaking changes**

- `createFamilySummary()` and the PDF/Chromium path were removed. They were
  specific to one downstream use and pulled in a heavy dependency. Use
  `summarizeText()` and render elsewhere.
- `transcribeMp3()` no longer writes chunk-marker text files; use
  `transcribeToSegments()` plus `writeOutputs()`.
- Downloaded audio is now `<videoId>.mp3` rather than `<title>.mp3`. Hebrew
  titles containing slashes or quotes produced unpredictable paths.

---

## Tests

```bash
npm test    # 25 tests, no network required
```

Covers URL parsing including the lookalike-host case, both timestamp formats,
overlap dedupe, sentence merging, the monologue length cap, proportional
distribution, the filler filter, VTT/SRT output, provider registration and
capability negotiation, and the Gemini timestamp sanitizer (inverted,
non-monotonic, out-of-range and empty segments).

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `No word timestamps were returned` | model is not `whisper-1`; the gpt-4o family cannot produce timestamps |
| `ASR_PROVIDER="anthropic" is not valid` | correct — Claude has no audio API. Use `openai` or `gemini` |
| `Gemini cannot provide timingMode "word"` | use `--timing segment`, or `--asr openai` for word-level |
| `Gemini returned malformed JSON` | retry, or switch `ASR_PROVIDER=openai` |
| Gemini chunk size errors | lower `TRANSCRIBER_CHUNK_SECONDS` to 240 — its cap is 20MB including base64 |
| `401` with a key that looks right | trailing whitespace — v2 trims, but check anything constructing the key elsewhere |
| `Chunk is 31.2MB, above the 25MB limit` | lower `TRANSCRIBER_CHUNK_SECONDS` |
| `yt-dlp failed` | YouTube changed something: `pip install -U yt-dlp` |
| Player clock never advances | `origin` missing from or mismatched in the embed URL |
| Words missing at 5-minute marks | `overlapSec` too low, or v1 chunking still in use |

---

MIT
