# @hinbit/transcriber

`@hinbit/transcriber` is a Node.js library for:

- transcribing local audio files
- transcribing YouTube lectures
- generating plain text summaries
- generating family-oriented Hebrew summary handouts

It reuses the existing OpenAI, `ffmpeg`, `ffprobe`, `yt-dlp`, and Chromium-based flow already present in this project, but exposes it as a package you can import from other projects.

## Install

Local package usage from another project:

```bash
npm install /path/to/SimpleTranscriber
```

Or if you publish it later:

```bash
npm install @hinbit/transcriber
```

## Requirements

- Node.js 20+
- `ffmpeg`
- `ffprobe`
- `yt-dlp`
- Chromium at `/snap/bin/chromium` if you want PDF output
- `OPENAI_API_KEY`

Example `.env`:

```env
OPENAI_API_KEY=your_openai_api_key_here
TARGET_PDF_PAGES=4
```

## Import

CommonJS:

```js
const {
  transcribe,
  transcribeLocalFile,
  transcribeYoutube,
  summarizeText,
  createFamilySummary
} = require("@hinbit/transcriber");
```

ESM:

```js
import {
  transcribe,
  transcribeLocalFile,
  transcribeYoutube,
  summarizeText,
  createFamilySummary
} from "@hinbit/transcriber";
```

TypeScript:

```ts
import { transcribeYoutube, summarizeText, type TranscriptionResult } from "@hinbit/transcriber";

const result: TranscriptionResult = await transcribeYoutube("https://www.youtube.com/watch?v=VIDEO_ID");
const summary = await summarizeText(result.transcriptText, { language: "he" });
```

## CLI

After install, you can also use the package as a command:

```bash
hinbit-transcriber transcribe ./audio/lesson.wav --family-summary
hinbit-transcriber transcribe "https://www.youtube.com/watch?v=VIDEO_ID"
hinbit-transcriber summarize --file ./transcript.txt
hinbit-transcriber family-summary --title "Pesach" --file ./transcript.txt --html ./out/pesach.html
```

## Package Maintenance

For local package validation:

```bash
npm install
npm run typecheck
npm run publish:dry-run
```

The `prepublishOnly` hook runs both checks automatically before `npm publish`.

## API

### `transcribe(source, options)`

Auto-detects whether `source` is a local file path or a YouTube URL.

```js
const result = await transcribe("tmp/lecture.mpeg", {
  language: "he",
  familySummary: true
});
```

### `transcribeLocalFile(inputPath, options)`

Converts non-MP3 files to MP3 when needed, then transcribes and summarizes.

```js
const result = await transcribeLocalFile("tmp/lecture.mpeg", {
  outputDir: "output_text",
  familySummary: true,
  familySummaryHtmlPath: "output_text/lecture_family.html",
  familySummaryPdfPath: "output_pdf/lecture.pdf"
});
```

Returned fields include:

- `mp3Path`
- `transcriptText`
- `summaryText`
- `transcriptFile`
- `summaryFile`
- `chunkFiles`
- `familySummary`

### `transcribeYoutube(url, options)`

Downloads the audio from YouTube and runs the same transcription flow.

```js
const result = await transcribeYoutube("https://www.youtube.com/watch?v=VIDEO_ID", {
  familySummary: true
});
```

### `summarizeText(text, options)`

Generates a plain text summary from any transcript or free text.

```js
const summary = await summarizeText(transcriptText, {
  language: "he",
  style: "concise"
});
```

Options:

- `apiKey`
- `language`
- `style`: `concise` or `detailed`
- `model`
- `prompt`

### `createFamilySummary(options)`

Creates a family-oriented Hebrew handout HTML fragment and can optionally write HTML/PDF files.

```js
const familySummary = await createFamilySummary({
  title: "שיעור לפסח",
  transcriptText,
  summaryText,
  outputHtmlPath: "output_text/pesach_family.html",
  outputPdfPath: "output_pdf/pesach_family.pdf"
});
```

Returned fields include:

- `title`
- `summaryText`
- `html`
- `htmlPath` when requested
- `pdfPath` when requested

## Sample Code

Runnable examples are included in [examples/local-file.js](/home/shaykid/Documents/Git/SimpleTranscriber/examples/local-file.js), [examples/youtube-link.js](/home/shaykid/Documents/Git/SimpleTranscriber/examples/youtube-link.js), and [examples/text-summary.js](/home/shaykid/Documents/Git/SimpleTranscriber/examples/text-summary.js).

Run them with:

```bash
npm run example:local
npm run example:youtube
npm run example:summary
```

## Existing CLI scripts

The old script workflows still work:

```bash
npm run transcribe -- "output/lecture.mp3"
npm run process:local -- "tmp/lecture.mpeg"
npm run process:youtube -- "https://www.youtube.com/watch?v=VIDEO_ID"
```

## Suggested Usage In Another Project

Simple transcript:

```js
const { transcribe } = require("@hinbit/transcriber");

const result = await transcribe("/absolute/path/to/audio.mp3");
console.log(result.transcriptText);
```

Transcript plus summary:

```js
const { transcribeLocalFile } = require("@hinbit/transcriber");

const result = await transcribeLocalFile("./recordings/lesson.wav");
console.log(result.summaryText);
```

YouTube lecture:

```js
const { transcribeYoutube } = require("@hinbit/transcriber");

const result = await transcribeYoutube("https://www.youtube.com/watch?v=VIDEO_ID");
console.log(result.transcriptFile);
```

Standalone summary:

```js
const { summarizeText } = require("@hinbit/transcriber");

const summary = await summarizeText("טקסט ארוך כאן", { language: "he" });
console.log(summary);
```

Family handout:

```js
const { createFamilySummary } = require("@hinbit/transcriber");

const handout = await createFamilySummary({
  title: "שיעור משפחתי",
  transcriptText: "תמלול מלא כאן"
});

console.log(handout.html);
```

## WhatsApp Voice Notes

If your outer app receives a short WhatsApp voice note file, save it locally and pass the file path into `transcribeLocalFile`.

Example with a local temp file:

```js
const fs = require("fs/promises");
const path = require("path");
const { transcribeLocalFile } = require("@hinbit/transcriber");

async function transcribeWhatsappVoiceNote(audioBuffer, fileName = "voice.ogg") {
  const tmpDir = path.resolve("tmp");
  await fs.mkdir(tmpDir, { recursive: true });

  const filePath = path.join(tmpDir, fileName);
  await fs.writeFile(filePath, audioBuffer);

  const result = await transcribeLocalFile(filePath, {
    language: "he"
  });

  return result.transcriptText;
}
```

Example when your app receives a downloadable audio URL:

```js
const fs = require("fs/promises");
const path = require("path");
const { transcribeLocalFile } = require("@hinbit/transcriber");

async function transcribeWhatsappAudioFromUrl(audioUrl) {
  const response = await fetch(audioUrl);
  if (!response.ok) {
    throw new Error(`Failed to download audio: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const filePath = path.resolve("tmp/whatsapp-voice.ogg");

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, Buffer.from(arrayBuffer));

  const result = await transcribeLocalFile(filePath, {
    language: "he"
  });

  return result.transcriptText;
}
```

This works well for short recordings such as WhatsApp voice notes because the package already converts non-MP3 audio with `ffmpeg` before transcription.
