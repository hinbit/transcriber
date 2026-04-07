const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const { loadEnvFile } = require("./load-env");

const CHUNK_SECONDS = 300;
const TRANSCRIPTION_MODEL = "gpt-4o-transcribe";
const SUMMARY_MODEL = "gpt-5-mini";
const FETCH_RETRY_COUNT = 3;

loadEnvFile();

function formatTimestamp(totalSeconds) {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const hours = String(Math.floor(safeSeconds / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((safeSeconds % 3600) / 60)).padStart(2, "0");
  const seconds = String(safeSeconds % 60).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env
    });

    let stderr = "";

    if (options.pipeStdout) {
      child.stdout.on("data", (chunk) => {
        process.stdout.write(chunk.toString());
      });
    }

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (options.pipeStderr !== false) {
        process.stderr.write(text);
      }
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `${command} exited with code ${code}.${stderr ? `\n${stderr}` : ""}`
        )
      );
    });
  });
}

async function fetchWithRetry(url, options, attempts = FETCH_RETRY_COUNT) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetch(url, options);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) {
        throw error;
      }
      console.error(`Fetch attempt ${attempt}/${attempts} failed: ${error.message}. Retrying...`);
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }

  throw lastError;
}

function runCommandWithOutput(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }

      reject(
        new Error(
          `${command} exited with code ${code}.${stderr ? `\n${stderr}` : ""}`
        )
      );
    });
  });
}

async function getAudioDurationSeconds(filePath) {
  const output = await runCommandWithOutput("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    filePath
  ]);
  const duration = Number.parseFloat(output);
  if (!Number.isFinite(duration)) {
    throw new Error(`Could not determine duration for ${filePath}`);
  }
  return duration;
}

async function splitMp3IntoChunks(mp3Path, chunkDir) {
  await fsp.mkdir(chunkDir, { recursive: true });

  const basename = path.basename(mp3Path, path.extname(mp3Path));
  const outputPattern = path.join(chunkDir, `${basename}-%03d.mp3`);

  await runCommand(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      mp3Path,
      "-f",
      "segment",
      "-segment_time",
      String(CHUNK_SECONDS),
      "-reset_timestamps",
      "1",
      "-c",
      "copy",
      outputPattern
    ],
    { pipeStderr: true }
  );

  const entries = await fsp.readdir(chunkDir);
  const chunkFiles = entries
    .filter((entry) => entry.startsWith(`${basename}-`) && entry.endsWith(".mp3"))
    .sort()
    .map((entry) => path.join(chunkDir, entry));

  if (chunkFiles.length === 0) {
    throw new Error("ffmpeg did not produce any chunk files.");
  }

  return chunkFiles;
}

async function transcribeChunk(chunkPath, apiKey, language) {
  const buffer = await fsp.readFile(chunkPath);
  const form = new FormData();
  form.set("model", TRANSCRIPTION_MODEL);
  form.set("response_format", "text");
  form.set(
    "prompt",
    "The audio is a Hebrew lecture by Rabbi Schneur Ashkenazi. Transcribe verbatim in Hebrew as accurately as possible. Preserve religious terms, names, quotations, and punctuation. Do not translate or summarize."
  );

  if (language) {
    form.set("language", language);
  }

  form.set("file", new Blob([buffer], { type: "audio/mpeg" }), path.basename(chunkPath));

  const response = await fetchWithRetry("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    body: form
  });

  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(
      `OpenAI transcription failed for ${path.basename(chunkPath)}: ${response.status} ${response.statusText}\n${bodyText}`
    );
  }

  return bodyText.trim();
}

async function summarizeChunk(transcriptText, apiKey, startSeconds, endSeconds) {
  const response = await fetchWithRetry("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: SUMMARY_MODEL,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: "You summarize Hebrew lecture transcripts. Return exactly one concise bullet in Hebrew describing the main subjects discussed in the chunk. Do not add intro text or numbering."
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                `Summarize this lecture chunk into one precise Hebrew bullet covering the main subjects discussed in this ${CHUNK_SECONDS / 60}-minute window.\n` +
                `Time window: ${formatTimestamp(startSeconds)}-${formatTimestamp(endSeconds)}\n\n` +
                transcriptText
            }
          ]
        }
      ]
    })
  });

  const json = await response.json();
  if (!response.ok) {
    throw new Error(
      `OpenAI summary failed: ${response.status} ${response.statusText}\n${JSON.stringify(json)}`
    );
  }

  let summaryText = "";

  if (typeof json.output_text === "string") {
    summaryText = json.output_text.trim();
  } else if (Array.isArray(json.output)) {
    summaryText = json.output
      .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
      .filter((contentItem) => contentItem.type === "output_text" && typeof contentItem.text === "string")
      .map((contentItem) => contentItem.text.trim())
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  if (!summaryText) {
    throw new Error("OpenAI summary response was empty.");
  }

  return summaryText.replace(/^\s*[-*•]\s*/, "");
}

async function transcribeMp3(mp3Path, options = {}) {
  const apiKey = options.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required.");
  }

  const absoluteMp3Path = path.resolve(mp3Path);
  if (!fs.existsSync(absoluteMp3Path)) {
    throw new Error(`MP3 file not found: ${absoluteMp3Path}`);
  }

  const absoluteOutputDir = path.resolve(options.outputDir || "output_text");
  const chunkDir = path.resolve(options.chunkDir || path.join("output", "chunks"));
  const language = options.language;
  const baseName = path.basename(absoluteMp3Path, path.extname(absoluteMp3Path));
  const cacheDir = path.join(absoluteOutputDir, ".cache", baseName);

  await fsp.mkdir(absoluteOutputDir, { recursive: true });
  await fsp.mkdir(cacheDir, { recursive: true });

  const chunkFiles = await splitMp3IntoChunks(absoluteMp3Path, chunkDir);
  const parts = [];
  const summaryLines = [];

  for (let index = 0; index < chunkFiles.length; index += 1) {
    const chunkPath = chunkFiles[index];
    const startSeconds = index * CHUNK_SECONDS;
    const chunkDuration = await getAudioDurationSeconds(chunkPath);
    const endSeconds = startSeconds + chunkDuration;
    console.log(
      `Transcribing chunk ${index + 1}/${chunkFiles.length}: ${path.basename(chunkPath)}`
    );
    const transcriptCachePath = path.join(
      cacheDir,
      `${path.basename(chunkPath, path.extname(chunkPath))}.transcript.txt`
    );
    const summaryCachePath = path.join(
      cacheDir,
      `${path.basename(chunkPath, path.extname(chunkPath))}.summary.txt`
    );

    let text;
    if (fs.existsSync(transcriptCachePath)) {
      text = (await fsp.readFile(transcriptCachePath, "utf8")).trim();
      console.log(`Reusing transcript cache for chunk ${index + 1}/${chunkFiles.length}`);
    } else {
      text = await transcribeChunk(chunkPath, apiKey, language);
      await fsp.writeFile(transcriptCachePath, `${text}\n`, "utf8");
    }

    parts.push(
      `--- Chunk ${index + 1} (${formatTimestamp(startSeconds)}-${formatTimestamp(endSeconds)}) ---\n${text}`
    );

    console.log(
      `Summarizing chunk ${index + 1}/${chunkFiles.length}: ${path.basename(chunkPath)}`
    );
    let summary;
    if (fs.existsSync(summaryCachePath)) {
      summary = (await fsp.readFile(summaryCachePath, "utf8")).trim();
      console.log(`Reusing summary cache for chunk ${index + 1}/${chunkFiles.length}`);
    } else {
      summary = await summarizeChunk(text, apiKey, startSeconds, endSeconds);
      await fsp.writeFile(summaryCachePath, `${summary}\n`, "utf8");
    }
    summaryLines.push(
      `- ${formatTimestamp(startSeconds)}-${formatTimestamp(endSeconds)}: ${summary}`
    );
  }

  const outputFile = path.join(absoluteOutputDir, `${baseName}.txt`);
  const summaryFile = path.join(absoluteOutputDir, `${baseName}_summarize_text.txt`);
  await fsp.writeFile(outputFile, `${parts.join("\n\n")}\n`, "utf8");
  await fsp.writeFile(summaryFile, `${summaryLines.join("\n")}\n`, "utf8");

  return {
    chunkFiles,
    outputFile,
    summaryFile
  };
}

async function cli() {
  const mp3Path = process.argv[2];
  if (!mp3Path) {
    console.error("Usage: node transcribe.js <path-to-mp3>");
    process.exitCode = 1;
    return;
  }

  const result = await transcribeMp3(mp3Path, {
    outputDir: "output_text"
  });
  console.log(`Saved transcript to: ${result.outputFile}`);
  console.log(`Saved summary to: ${result.summaryFile}`);
}

if (require.main === module) {
  cli().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  splitMp3IntoChunks,
  transcribeMp3
};
