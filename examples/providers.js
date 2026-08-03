/**
 * Provider selection, three ways.
 *   node examples/providers.js
 */
const {
  listProviders,
  assertConfigured,
  transcribeToSegments,
} = require("../index.js");

// 1. What is available, and which keys are actually loaded?
console.log(JSON.stringify(listProviders(), null, 2));

// 2. Fail fast if the configured combination is missing a key.
try {
  assertConfigured();
  console.log("\nProviders configured.");
} catch (error) {
  console.error(`\n${error.message}`);
  process.exit(1);
}

// 3. Override per call. Environment stays the default; this run does not.
async function run() {
  const result = await transcribeToSegments(process.argv[2], {
    asrProvider: "gemini",     // cheap transcription
    llmProvider: "anthropic",  // strong Hebrew titling
    timingMode: "segment",     // gemini cannot do "word"
    language: "he",
    onProgress: ({ stage, done, total }) =>
      process.stderr.write(`\r${stage} ${done}/${total}   `),
  });

  console.log(`\n\nasr: ${result.providers.asr}  llm: ${result.providers.llm}`);
  console.log(`accuracy: ±${result.timing.toleranceSec}s`);
  if (result.timing.note) console.log(`note: ${result.timing.note}`);
  console.log(`\n${result.stats.segmentsMeaningful} meaningful segments`);
}

if (process.argv[2]) run().catch((e) => { console.error(e.message); process.exit(1); });
else console.log("\nPass a YouTube URL or file path to run a transcription.");
