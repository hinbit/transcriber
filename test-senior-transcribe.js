const fs = require("fs");
const path = require("path");
const { loadEnvFile } = require("./load-env");
const { downloadYoutubeAsMp3 } = require("./download-youtube-mp3");
const { transcribeMp3 } = require("./transcribe");

loadEnvFile();

function findExistingMp3(outputDir) {
  const absoluteOutputDir = path.resolve(outputDir);
  if (!fs.existsSync(absoluteOutputDir)) {
    return null;
  }

  const files = fs
    .readdirSync(absoluteOutputDir)
    .filter((file) => file.toLowerCase().endsWith(".mp3"))
    .sort();

  if (files.length === 0) {
    return null;
  }

  return path.join(absoluteOutputDir, files[0]);
}

async function main() {
  const url = "https://www.youtube.com/watch?v=hzaklTHmofo";
  let outputFile = findExistingMp3("output");

  if (outputFile) {
    console.log(`Using existing MP3: ${outputFile}`);
  } else {
    outputFile = await downloadYoutubeAsMp3(url, "output");
    console.log(`Saved MP3 to: ${outputFile}`);
  }

  const result = await transcribeMp3(outputFile, {
    outputDir: "output_text",
    language: "he"
  });
  console.log(`Saved transcript to: ${result.outputFile}`);
  console.log(`Saved summary to: ${result.summaryFile}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
