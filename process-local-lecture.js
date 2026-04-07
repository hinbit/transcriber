const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const { transcribeMp3 } = require("./transcribe");
const {
  buildHtmlDocument,
  generateHandoutHtml,
  renderPdf,
  slugifyFileBase
} = require("./process-youtube-lecture");
const { loadEnvFile } = require("./load-env");

loadEnvFile();

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env
    });

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      process.stderr.write(chunk.toString());
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with code ${code}.${stderr ? `\n${stderr}` : ""}`));
    });
  });
}

async function convertToMp3IfNeeded(inputPath) {
  const absoluteInput = path.resolve(inputPath);
  const ext = path.extname(absoluteInput).toLowerCase();

  if (ext === ".mp3") {
    return absoluteInput;
  }

  await fsp.mkdir(path.resolve("output"), { recursive: true });
  const baseName = path.basename(absoluteInput, ext);
  const outputPath = path.resolve("output", `${baseName}.mp3`);

  await runCommand("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    absoluteInput,
    outputPath
  ]);

  return outputPath;
}

async function processLocalLecture(inputPath) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required.");
  }

  const mp3Path = await convertToMp3IfNeeded(inputPath);
  const baseName = path.basename(mp3Path, path.extname(mp3Path));
  const safeBaseName = slugifyFileBase(baseName);

  const transcription = await transcribeMp3(mp3Path, {
    outputDir: "output_text",
    language: "he"
  });

  const transcriptText = await fsp.readFile(transcription.outputFile, "utf8");
  const summaryText = await fsp.readFile(transcription.summaryFile, "utf8");

  console.log(`Generating handout for: ${baseName}`);
  const handoutInnerHtml = await generateHandoutHtml({
    title: baseName,
    transcriptText,
    summaryText,
    apiKey
  });

  const htmlPath = path.resolve("output_text", `${safeBaseName}_family_handout.html`);
  const pdfPath = path.resolve("output_pdf", `${safeBaseName}.pdf`);
  await fsp.writeFile(htmlPath, buildHtmlDocument(baseName, handoutInnerHtml), "utf8");
  await renderPdf(htmlPath, pdfPath);

  return {
    mp3Path,
    transcriptFile: transcription.outputFile,
    summaryFile: transcription.summaryFile,
    htmlPath,
    pdfPath
  };
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error("Usage: node process-local-lecture.js <path-to-local-audio-file>");
    process.exitCode = 1;
    return;
  }

  const result = await processLocalLecture(inputPath);
  console.log(`Saved transcript to: ${result.transcriptFile}`);
  console.log(`Saved summary to: ${result.summaryFile}`);
  console.log(`Saved handout HTML to: ${result.htmlPath}`);
  console.log(`Saved handout PDF to: ${result.pdfPath}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  processLocalLecture
};
