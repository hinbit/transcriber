#!/usr/bin/env node
"use strict";

const path = require("path");
const {
  transcribeToSegments,
  writeOutputs,
  getYoutubeMetadata,
  isYoutubeUrl,
  summarizeText,
  listProviders,
  timecode,
} = require("../index.js");

const HELP = `
hinbit-transcriber v2 — transcription with usable timestamps

USAGE
  hinbit-transcriber transcribe <youtube-url | file> [options]
  hinbit-transcriber info <youtube-url>
  hinbit-transcriber summarize --file <path> [--style detailed]
  hinbit-transcriber providers

OPTIONS
  --lang <code>          Source language hint            (default: he)
  --asr <provider>       openai | gemini                 (default: $ASR_PROVIDER)
  --llm <provider>       openai | anthropic | gemini     (default: $LLM_PROVIDER)
  --timing <mode>        word | segment | proportional   (default: word)
  --out <dir>            Output directory                (default: output_text)
  --name <base>          Output file base name           (default: video id)
  --vocab <a,b,c>        Domain terms for the ASR prompt
  --concurrency <n>      Parallel chunk requests         (default: 3)
  --chunk <seconds>      Chunk length                    (default: 300)
  --no-enrich            Skip the LLM titling/keyword pass
  --no-cache             Ignore the transcript cache
  --json                 Print the result as JSON
  -h, --help

EXAMPLES
  hinbit-transcriber transcribe "https://youtu.be/VIDEO_ID"
  hinbit-transcriber transcribe ./lecture.mp4 --lang he --vocab "מרשם,רוקח,טופס 17"
  hinbit-transcriber transcribe "https://youtu.be/VIDEO_ID" --timing proportional
  hinbit-transcriber info "https://youtu.be/VIDEO_ID"
  hinbit-transcriber transcribe ./call.m4a --asr gemini --timing segment --llm anthropic

NOTE
  Only --asr openai supports --timing word. Gemini reports MM:SS timestamps,
  so its best is segment (±1.5s). Anthropic has no speech-to-text API and is
  therefore an --llm option only.
`;

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        args.flags[key] = true;
      } else {
        args.flags[key] = next;
        i++;
      }
    } else if (token === "-h") {
      args.flags.help = true;
    } else {
      args._.push(token);
    }
  }
  return args;
}

function progressBar({ stage, done, total }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  const width = 24;
  const filled = Math.round((pct / 100) * width);
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  process.stderr.write(`\r${stage.padEnd(11)} ${bar} ${String(pct).padStart(3)}%   `);
  if (done >= total) process.stderr.write("\n");
}

async function cmdTranscribe(args) {
  const source = args._[1];
  if (!source) {
    console.error("A YouTube URL or file path is required.");
    process.exitCode = 1;
    return;
  }

  const result = await transcribeToSegments(source, {
    language: args.flags.lang || "he",
    timingMode: args.flags.timing || undefined,
    asrProvider: args.flags.asr || undefined,
    llmProvider: args.flags.llm || undefined,
    concurrency: Number(args.flags.concurrency) || undefined,
    chunkSeconds: Number(args.flags.chunk) || undefined,
    vocabulary: args.flags.vocab ? String(args.flags.vocab).split(",").map((s) => s.trim()) : undefined,
    enrich: !args.flags["no-enrich"],
    cache: !args.flags["no-cache"],
    onProgress: args.flags.json ? undefined : progressBar,
  });

  const files = await writeOutputs(result, {
    outputDir: args.flags.out,
    baseName: args.flags.name,
  });

  if (args.flags.json) {
    console.log(JSON.stringify({ result, files }, null, 2));
    return;
  }

  console.log(`\n${result.title}`);
  console.log(`  duration    ${timecode(result.durationSec, false)}`);
  console.log(`  asr         ${result.providers.asr} / ${result.engine}`);
  if (result.providers.llm) console.log(`  llm         ${result.providers.llm}`);
  console.log(`  timing      ${result.timing.mode} (±${result.timing.toleranceSec}s)`);
  console.log(`  segments    ${result.stats.segmentsMeaningful} meaningful / ${result.stats.segmentsTotal} total`);
  console.log(`  confidence  ${result.stats.avgConfidence}`);
  if (result.timing.note) console.log(`\n  ⚠ ${result.timing.note}`);
  console.log("\nWrote:");
  for (const [key, file] of Object.entries(files)) {
    console.log(`  ${key.padEnd(15)} ${path.relative(process.cwd(), file)}`);
  }
}

async function cmdInfo(args) {
  const url = args._[1];
  if (!isYoutubeUrl(url)) {
    console.error("A valid YouTube URL is required.");
    process.exitCode = 1;
    return;
  }
  const meta = await getYoutubeMetadata(url);
  console.log(JSON.stringify(meta, null, 2));
}

async function cmdSummarize(args) {
  const file = args.flags.file;
  if (!file) {
    console.error("--file is required.");
    process.exitCode = 1;
    return;
  }
  const text = await require("fs/promises").readFile(path.resolve(file), "utf8");
  const summary = await summarizeText(text, {
    language: args.flags.lang || "he",
    style: args.flags.style === "detailed" ? "detailed" : "concise",
  });
  console.log(summary);
}

function cmdProviders(args) {
  const registry = listProviders();
  if (args.flags.json) {
    console.log(JSON.stringify(registry, null, 2));
    return;
  }

  console.log("\nSpeech-to-text (ASR_PROVIDER)");
  for (const provider of registry.asr) {
    const key = provider.keyPresent ? "key set" : `MISSING ${provider.keyEnv}`;
    const active = provider.id === registry.selected.asr ? " ← selected" : "";
    console.log(`\n  ${provider.label} [${provider.id}]  (${key})${active}`);
    for (const [mode, capability] of Object.entries(provider.timingModes)) {
      console.log(capability.supported
        ? `    ${mode.padEnd(13)} ±${capability.toleranceSec}s`
        : `    ${mode.padEnd(13)} unsupported — ${capability.reason}`);
    }
  }

  console.log("\n\nText generation (LLM_PROVIDER)");
  console.log(`  ${"".padEnd(16)} ${"fast".padEnd(24)} ${"heavy (escalation)".padEnd(24)}`);
  for (const provider of registry.llm) {
    const key = provider.keyPresent ? "key set" : `MISSING ${provider.keyEnv}`;
    const active = provider.id === registry.selected.llm ? " ← selected" : "";
    console.log(
      `  ${provider.label.padEnd(16)} ${provider.defaultModel.padEnd(24)} ` +
      `${provider.heavyModel.padEnd(24)} (${key})${active}`
    );
  }
  console.log(`\n  Escalation: TRANSCRIBER_LLM_ESCALATE=${registry.escalate}` +
    "  (auto = heavy for long/detailed summaries and failed batches)");

  for (const item of registry.unsupported) {
    console.log(`\n  Note: ${item.reason}`);
  }
  console.log("");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];

  if (!command || args.flags.help || command === "help") {
    console.log(HELP.trim());
    return;
  }

  switch (command) {
    case "transcribe": return cmdTranscribe(args);
    case "providers":  return cmdProviders(args);
    case "info":       return cmdInfo(args);
    case "summarize":  return cmdSummarize(args);
    default:
      console.error(`Unknown command "${command}". Run with --help.`);
      process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write("\n");
  console.error(error.message);
  process.exitCode = 1;
});
