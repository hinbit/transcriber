const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const { loadEnvFile } = require("./load-env");
const { downloadYoutubeAsMp3 } = require("./download-youtube-mp3");
const { transcribeMp3 } = require("./transcribe");
const {
  buildHtmlDocument,
  generateHandoutHtml,
  renderPdf,
  slugifyFileBase
} = require("./process-youtube-lecture");

const SUMMARY_MODEL = "gpt-5-mini";
const FETCH_RETRY_COUNT = 3;

loadEnvFile();

function isYoutubeUrl(value) {
  return typeof value === "string" && /(?:youtube\.com|youtu\.be)/i.test(value);
}

function resolveApiKey(apiKey) {
  const resolvedApiKey = apiKey || process.env.OPENAI_API_KEY;
  if (!resolvedApiKey) {
    throw new Error("OPENAI_API_KEY is required.");
  }
  return resolvedApiKey;
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
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }

  throw lastError;
}

async function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env
    });

    let stderr = "";
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

      reject(new Error(`${command} exited with code ${code}.${stderr ? `\n${stderr}` : ""}`));
    });
  });
}

async function convertToMp3IfNeeded(inputPath, options = {}) {
  const absoluteInput = path.resolve(inputPath);
  if (!fs.existsSync(absoluteInput)) {
    throw new Error(`Input file not found: ${absoluteInput}`);
  }

  const ext = path.extname(absoluteInput).toLowerCase();
  if (ext === ".mp3") {
    return absoluteInput;
  }

  const outputDir = path.resolve(options.outputDir || "output");
  await fsp.mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `${path.basename(absoluteInput, ext)}.mp3`);

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

async function extractResponseText(response) {
  const json = await response.json();

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}\n${JSON.stringify(json)}`);
  }

  if (typeof json.output_text === "string" && json.output_text.trim()) {
    return json.output_text.trim();
  }

  if (Array.isArray(json.output)) {
    const text = json.output
      .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
      .filter((item) => item.type === "output_text" && typeof item.text === "string")
      .map((item) => item.text.trim())
      .filter(Boolean)
      .join("\n")
      .trim();

    if (text) {
      return text;
    }
  }

  throw new Error("OpenAI returned empty output.");
}

async function summarizeText(text, options = {}) {
  if (!text || !String(text).trim()) {
    throw new Error("Text is required.");
  }

  const apiKey = resolveApiKey(options.apiKey);
  const language = options.language || "he";
  const style = options.style || "concise";
  const prompt = options.prompt ||
    (language === "he"
      ? `סכם את הטקסט בעברית בצורה ${style === "detailed" ? "מפורטת" : "קצרה"}, מדויקת, וברורה.`
      : `Summarize the text in a ${style === "detailed" ? "detailed" : "concise"}, precise, and clear way.`);

  const response = await fetchWithRetry("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: options.model || SUMMARY_MODEL,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: prompt
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: String(text)
            }
          ]
        }
      ]
    })
  });

  return extractResponseText(response);
}

async function createFamilySummary(options = {}) {
  const title = options.title || "Lecture";
  const transcriptText = options.transcriptText;
  if (!transcriptText || !String(transcriptText).trim()) {
    throw new Error("transcriptText is required.");
  }

  const apiKey = resolveApiKey(options.apiKey);
  const summaryText =
    options.summaryText ||
    (await summarizeText(transcriptText, {
      apiKey,
      language: "he",
      style: "detailed",
      prompt:
        "סכם את תוכן התמלול בעברית כרשימת נקודות לפי נושאים מרכזיים כדי לשמש בסיס לדף סיכום משפחתי."
    }));

  const html = await generateHandoutHtml({
    title,
    transcriptText,
    summaryText,
    apiKey
  });

  const result = {
    title,
    summaryText,
    html
  };

  if (options.outputHtmlPath || options.outputPdfPath) {
    const safeBaseName = slugifyFileBase(title);
    const htmlPath = path.resolve(options.outputHtmlPath || path.join("output_text", `${safeBaseName}_family_handout.html`));
    await fsp.mkdir(path.dirname(htmlPath), { recursive: true });
    await fsp.writeFile(htmlPath, buildHtmlDocument(title, html), "utf8");
    result.htmlPath = htmlPath;
  }

  if (options.outputPdfPath) {
    const pdfPath = path.resolve(options.outputPdfPath);
    await renderPdf(result.htmlPath, pdfPath);
    result.pdfPath = pdfPath;
  }

  return result;
}

async function transcribeLocalFile(inputPath, options = {}) {
  const mp3Path = await convertToMp3IfNeeded(inputPath, {
    outputDir: options.downloadDir || options.outputDir || "output"
  });

  const transcription = await transcribeMp3(mp3Path, {
    apiKey: options.apiKey,
    outputDir: options.outputDir || "output_text",
    chunkDir: options.chunkDir,
    language: options.language || "he"
  });

  const transcriptText = await fsp.readFile(transcription.outputFile, "utf8");
  const summaryText = await fsp.readFile(transcription.summaryFile, "utf8");

  const result = {
    sourceType: "local",
    inputPath: path.resolve(inputPath),
    mp3Path,
    transcriptText,
    summaryText,
    transcriptFile: transcription.outputFile,
    summaryFile: transcription.summaryFile,
    chunkFiles: transcription.chunkFiles
  };

  if (options.familySummary) {
    result.familySummary = await createFamilySummary({
      apiKey: options.apiKey,
      title: options.title || path.basename(mp3Path, path.extname(mp3Path)),
      transcriptText,
      summaryText,
      outputHtmlPath: options.familySummaryHtmlPath,
      outputPdfPath: options.familySummaryPdfPath
    });
  }

  return result;
}

async function transcribeYoutube(url, options = {}) {
  if (!isYoutubeUrl(url)) {
    throw new Error("A valid YouTube URL is required.");
  }

  const mp3Path = await downloadYoutubeAsMp3(url, options.downloadDir || "output");

  const result = await transcribeLocalFile(mp3Path, {
    ...options,
    title: options.title || path.basename(mp3Path, path.extname(mp3Path))
  });

  return {
    ...result,
    sourceType: "youtube",
    url
  };
}

async function transcribe(source, options = {}) {
  if (isYoutubeUrl(source)) {
    return transcribeYoutube(source, options);
  }

  return transcribeLocalFile(source, options);
}

module.exports = {
  convertToMp3IfNeeded,
  createFamilySummary,
  downloadYoutubeAsMp3,
  transcribe,
  transcribeLocalFile,
  transcribeMp3,
  transcribeYoutube,
  summarizeText
};
