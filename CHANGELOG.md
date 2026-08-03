# Changelog

## 2.2.0

Cost control for the text passes, and three defects found by running the
library against a live account rather than only against its tests.

### Fixed
- **Enrichment never worked against OpenAI.** The batch prompt asked for a JSON
  object through `text.format: json_object`, but OpenAI rejects that request
  unless the prompt itself contains the word "json" — so every batch returned
  400. Enrichment degrades silently by design, so the visible symptom was not
  an error but annotations that were never drafted: no `meaningful`, no
  `shortTitle`, no `keywords`, on every run.
- **`.env` was only found when the process started in its directory.** The path
  was resolved against the cwd, so any workspace or subdirectory invocation
  silently fell back to defaults and then failed with a missing-key error
  naming a file that exists. The loader now walks up to the nearest `.env`.
- **Placeholder keys counted as configured.** After `cp .env.example .env`,
  values like `sk-ant-xxxxxxxx` passed the emptiness check, so
  `assertConfigured()` approved a run that then died against the API — the
  exact failure it exists to prevent.

### Added
- **Two model tiers per provider**, `*_LLM_MODEL` and `*_LLM_MODEL_HEAVY`, with
  `TRANSCRIBER_LLM_ESCALATE` (`auto` | `never` | `always`) and
  `TRANSCRIBER_LLM_HEAVY_CHARS`. The fast model runs everything; the heavy one
  is used for long or detailed summaries and to retry a batch the fast model
  returned unusable output for. Exposed as `chooseTier()`, as a `tier` option
  on `summarizeText()` and `enrichSegments()`, and in `listProviders()`.
- `OPENAI_REASONING_EFFORT`, defaulting to `low` on the fast tier and `medium`
  on the heavy one. Reasoning is billed against `max_output_tokens`; at higher
  effort a model can consume the budget and return no text, which previously
  surfaced as a bare "empty output" error.
- Provider errors carry `status` and `deterministic`, so a 4xx rejection is not
  retried on a larger model while throttling and 5xx still are.
- `getLlmProvider()` accepts a provider object, so a custom backend can be
  injected and the text passes can be tested without network access.
- `loadEnv` and `chooseTier` are exported; `listProviders()` reports
  `heavyModel` and `escalate`.
- 20 tests covering escalation policy, tier resolution, placeholder detection,
  `.env` discovery, and the enrichment retry path.

### Changed
- `requireKey()` names a placeholder as a placeholder instead of reporting the
  variable as missing.
- The CLI's `providers` view shows both tiers and the escalation mode.

## 2.1.0

Multi-provider support. Two independent axes, selectable in `.env`.

### Added
- `ASR_PROVIDER` — `openai` | `gemini`.
- `LLM_PROVIDER` — `openai` | `anthropic` | `gemini`.
- Gemini speech-to-text via `generateContent` with a structured response
  schema, MM:SS timestamp parsing, and inline-audio size guards.
- Anthropic and Gemini text providers behind one `complete()` interface,
  alongside the existing OpenAI one.
- `listProviders()` — capability matrix plus which API keys are actually
  loaded. Exposed as `hinbit-transcriber providers`.
- `assertConfigured()` — fails at startup on missing keys instead of
  mid-pipeline.
- `asrProvider` / `llmProvider` per-call options, and `--asr` / `--llm` CLI
  flags, so one run can override the environment.
- `result.providers` records which engines actually produced the output.
- 9 new tests covering registration, capability negotiation and the Gemini
  timestamp sanitizer.

### Changed
- `timing.toleranceSec` is now declared by the provider rather than read from a
  global table. The same mode name means different accuracy on different
  engines: `segment` is ±0.5s on whisper-1 and ±1.5s on Gemini.
- Timing capability is validated **before** any audio is downloaded. Requesting
  `word` from Gemini fails in milliseconds with the reason and the alternative,
  not after a 40-minute yt-dlp run.
- Cache keys include the provider id, so the same audio transcribed by
  different engines no longer collides.
- Retry logic moved to a shared `lib/http.js` used by every provider.
- `requireApiKey()` generalised to `requireKey(explicit, varName, label)` so
  each provider names its own missing variable. The old export remains.
- `summarizeText()` and `enrichSegments()` take `provider` instead of `apiKey`.

### Notes
**Anthropic cannot be an ASR provider.** Claude has no speech-to-text API — it
accepts text, images and PDFs, not audio. `ASR_PROVIDER=anthropic` throws a
message saying so and pointing at `LLM_PROVIDER`. This is a vendor capability
boundary, not a gap in this library.

**Gemini timings are generated, not measured.** Resolution is MM:SS, so word
mode is impossible and segment mode is ±1.5s at best. Segments with inverted,
non-monotonic or out-of-range timestamps are dropped rather than trusted, and
`timing.note` explains the tradeoff in every Gemini result.

## 2.0.0

### The reason for this version

v1 could not produce timestamps. `gpt-4o-transcribe` supports `response_format`
of `json` or `text` only — timestamp support does not exist in that model
family. The only time information that survived was the 300-second chunk
boundary. v2 rebuilds the transcription path around `whisper-1`, the current
OpenAI model exposing `verbose_json` with `timestamp_granularities`.

### Added
- `transcribeToSegments()` — sentences with word-level timings (±0.1s).
- `timingMode`: `word` | `segment` | `proportional`, with documented accuracy
  per mode surfaced in `result.timing.toleranceSec`.
- `getYoutubeMetadata()` — title, duration, dimensions without downloading.
- `youtubeEmbedUrl()`, `youtubeThumbUrl()`, `parseYouTubeUrl()`.
- `probeMedia()` — dimensions, aspect and fps for overlay geometry.
- `toVTT()` / `toSRT()` subtitle export.
- `enrichSegments()` — batched LLM titling and keywords, 40 segments per call.
- Filler-word heuristic that rejects ~⅓ of segments before any LLM call.
- `onProgress` callback across all stages.
- Bounded-concurrency chunk transcription.
- Full `index.d.ts`.
- 16 unit tests, no network required.

### Changed
- Chunking re-encodes with a 1.5s overlap instead of `-c copy`. Stream-copy cut
  on MP3 frame boundaries and clipped the first syllable after every cut.
  Duplicates from the overlap are removed by timestamp comparison.
- Cache keys are the audio content hash plus every parameter that affects
  output, not the chunk filename.
- ffmpeg is resolved at runtime instead of hardcoded to `/usr/bin/ffmpeg`.
- YouTube URLs are parsed and the hostname checked. The v1 regex
  `/(?:youtube\.com|youtu\.be)/i` matched `youtube.com.attacker.example`.
- Downloaded audio is `<videoId>.mp3`, not `<title>.mp3`. Hebrew titles with
  slashes or quotes produced unpredictable paths.
- The ASR prompt is configurable. v1 hardcoded a prompt naming one specific
  lecturer, which biased vocabulary on all other content.
- Retries are exponential and honour `Retry-After` on 429.
- All env values are trimmed on read.

### Removed
- `createFamilySummary()` and the Chromium/PDF path — downstream-specific and a
  heavy dependency. Use `summarizeText()` and render elsewhere.
- Chunk-marker text output from `transcribeMp3()`.

### Compatibility
`transcribe()`, `transcribeYoutube()` and `transcribeLocalFile()` keep their v1
shape and now also return `segments` and `timing`.

## 1.0.0
Initial release.
