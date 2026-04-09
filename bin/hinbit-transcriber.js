#!/usr/bin/env node

const fs = require("fs/promises");
const path = require("path");
const {
  createFamilySummary,
  summarizeText,
  transcribe,
  transcribeLocalFile,
  transcribeYoutube
} = require("../index.js");

function printUsage() {
  console.log(`hinbit-transcriber

Commands:
  transcribe <source> [--family-summary] [--html <path>] [--pdf <path>] [--language <code>] [--output-dir <path>] [--chunk-dir <path>]
  summarize --text <text>
  summarize --file <path>
  family-summary --title <title> --text <text> [--summary <text>] [--html <path>] [--pdf <path>]
  family-summary --title <title> --file <path> [--summary <text>] [--html <path>] [--pdf <path>]

Examples:
  hinbit-transcriber transcribe ./audio/lesson.wav --family-summary
  hinbit-transcriber transcribe "https://www.youtube.com/watch?v=VIDEO_ID"
  hinbit-transcriber summarize --file ./transcript.txt
  hinbit-transcriber family-summary --title "Pesach" --file ./transcript.txt --html ./out/pesach.html
`);
}

function parseArgs(argv) {
  const args = { _: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];

    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }

    args[key] = next;
    index += 1;
  }

  return args;
}

async function readTextArg(args) {
  if (typeof args.text === "string") {
    return args.text;
  }

  if (typeof args.file === "string") {
    return fs.readFile(path.resolve(args.file), "utf8");
  }

  throw new Error("Provide either --text or --file.");
}

async function runTranscribe(args) {
  const source = args._[1];
  if (!source) {
    throw new Error("transcribe requires a source path or YouTube URL.");
  }

  const options = {
    language: args.language,
    outputDir: args["output-dir"],
    chunkDir: args["chunk-dir"],
    familySummary: Boolean(args["family-summary"]),
    familySummaryHtmlPath: args.html,
    familySummaryPdfPath: args.pdf,
    title: args.title
  };

  const result =
    /(?:youtube\.com|youtu\.be)/i.test(source)
      ? await transcribeYoutube(source, options)
      : await transcribeLocalFile(source, options);

  console.log(JSON.stringify(result, null, 2));
}

async function runSummarize(args) {
  const text = await readTextArg(args);
  const summary = await summarizeText(text, {
    language: args.language,
    style: args.style,
    prompt: args.prompt
  });

  console.log(summary);
}

async function runFamilySummary(args) {
  const transcriptText = await readTextArg(args);
  const result = await createFamilySummary({
    title: args.title || "Lecture",
    transcriptText,
    summaryText: args.summary,
    outputHtmlPath: args.html,
    outputPdfPath: args.pdf
  });

  if (result.htmlPath || result.pdfPath) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(result.html);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];

  if (!command || command === "--help" || command === "help") {
    printUsage();
    return;
  }

  if (command === "transcribe") {
    await runTranscribe(args);
    return;
  }

  if (command === "summarize") {
    await runSummarize(args);
    return;
  }

  if (command === "family-summary") {
    await runFamilySummary(args);
    return;
  }

  if (command === "transcribe-auto") {
    const source = args._[1];
    if (!source) {
      throw new Error("transcribe-auto requires a source.");
    }
    console.log(JSON.stringify(await transcribe(source), null, 2));
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
