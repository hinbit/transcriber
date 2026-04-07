# SimpleTranscriber

Node-based helpers for:

- downloading YouTube lectures as MP3
- splitting long audio into 5-minute chunks with `ffmpeg`
- transcribing Hebrew audio with the OpenAI API
- generating family-friendly HTML handouts
- exporting those handouts to PDF

## Project Files

- `download-youtube-mp3.js`: downloads a YouTube video as MP3 into `output/`
- `transcribe.js`: splits an MP3 into 5-minute chunks and writes transcript + chunk summary to `output_text/`
- `process-youtube-lecture.js`: full end-to-end flow from YouTube URL to MP3, transcript, HTML handout, and PDF
- `process-local-lecture.js`: full end-to-end flow from a local audio file to MP3, transcript, HTML handout, and PDF
- `test-senior-transcribe.js`: example runner for the original sample lecture
- `load-env.js`: lightweight `.env` loader with no external dependency

## Requirements

- Node.js 20+
- `ffmpeg`
- `ffprobe`
- local `yt-dlp` in `.venv/` or available globally
- Chromium available at `/snap/bin/chromium` for PDF export

## Environment Setup

This project reads configuration from `.env`.

Files included:

- `.env`: local runtime file
- `.env.example`: template you can copy from

Example `.env`:

```env
OPENAI_API_KEY=your_openai_api_key_here
TARGET_PDF_PAGES=4
```

`.env` is ignored by git.

Environment variables:

- `OPENAI_API_KEY`: required for transcription and handout generation
- `TARGET_PDF_PAGES`: optional target page count for generated PDFs, default `4`

## Install / Prepare

Create the local Python environment and install `yt-dlp`:

```bash
python3 -m venv .venv
.venv/bin/pip install yt-dlp
```

Make sure `ffmpeg` is installed:

```bash
ffmpeg -version
ffprobe -version
```

## npm Scripts

Install is not required for runtime because there are no npm dependencies right now, but `package.json` provides command aliases:

```bash
npm run test:senior-transcribe
npm run transcribe -- "output/some-file.mp3"
npm run process:youtube -- "https://www.youtube.com/watch?v=VIDEO_ID"
npm run process:local -- "tmp/lecture.mpeg"
```

## Usage

### 1. Download a lecture as MP3

Direct Node usage:

```bash
node -e "const { downloadYoutubeAsMp3 } = require('./download-youtube-mp3'); downloadYoutubeAsMp3('https://www.youtube.com/watch?v=hzaklTHmofo').then(console.log)"
```

Output:

- MP3 file in `output/`

### 2. Transcribe an existing MP3

```bash
npm run transcribe -- "output/lecture.mp3"
```

Outputs:

- `output_text/<lecture title>.txt`
- `output_text/<lecture title>_summarize_text.txt`

The transcript is split into 5-minute chunks and each chunk gets:

- a verbatim Hebrew transcript
- a short Hebrew topic summary

### 3. Run the full YouTube-to-PDF flow

```bash
npm run process:youtube -- "https://www.youtube.com/watch?v=6XnlAhcgcZc"
```

This does all of the following:

1. downloads the lecture as MP3
2. transcribes it in Hebrew
3. generates a family-friendly HTML outline
4. includes `מדרש/מקור שהוזכר` lines when the lecture references מדרש or חז"ל
5. exports a PDF named after the lecture title

Outputs:

- `output/<lecture title>.mp3`
- `output_text/<lecture title>.txt`
- `output_text/<lecture title>_summarize_text.txt`
- `output_text/<lecture title>_family_handout.html`
- `output_pdf/<lecture title>.pdf`

### 4. Run the full local-file-to-PDF flow

```bash
npm run process:local -- "tmp/7pes.mpeg"
```

This flow:

1. converts the local file to MP3 if needed
2. transcribes it in Hebrew
3. generates the family handout HTML
4. exports the PDF named after the lecture/audio title

## Example Runs

Original sample lecture:

```bash
npm run test:senior-transcribe
```

Process a new lecture directly from YouTube:

```bash
npm run process:youtube -- "https://www.youtube.com/watch?v=kZ-PEj5bvog"
```

Process a local recording:

```bash
npm run process:local -- "tmp/7pes.mpeg"
```

Transcribe an existing local MP3 without redownloading:

```bash
npm run transcribe -- "output/\"lecture title\".mp3"
```

## Notes

- The transcriber is configured for Hebrew audio.
- The full lecture processor uses OpenAI to generate a polished Hebrew handout from the transcript.
- PDF export uses Chromium headless print mode.
- PDF export automatically shrinks print scale until the output fits within `TARGET_PDF_PAGES`.
- If a lecture includes references to מדרש, the generated handout tries to surface them explicitly in the final HTML/PDF.

## Security

- Do not commit a real API key into `.env`.
- If an API key was ever pasted into chat, terminal history, or committed anywhere, rotate it in OpenAI immediately.
