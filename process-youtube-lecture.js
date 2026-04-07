const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const { downloadYoutubeAsMp3 } = require("./download-youtube-mp3");
const { transcribeMp3 } = require("./transcribe");
const { loadEnvFile } = require("./load-env");

const PDF_PRINTER = "/snap/bin/chromium";
const HANDOUT_MODEL = "gpt-5-mini";
const FETCH_RETRY_COUNT = 3;

loadEnvFile();

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

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

function slugifyFileBase(name) {
  return name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
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

async function callResponsesApi(apiKey, input) {
  const response = await fetchWithRetry("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: HANDOUT_MODEL,
      input
    })
  });

  const json = await response.json();
  if (!response.ok) {
    throw new Error(`OpenAI handout generation failed: ${response.status} ${response.statusText}\n${JSON.stringify(json)}`);
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

  throw new Error("OpenAI handout generation returned empty output.");
}

function buildHtmlDocument(title, innerHtml) {
  const safeTitle = escapeHtml(title);
  return `<!doctype html>
<html lang="he" dir="rtl">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${safeTitle}</title>
    <style>
      :root {
        --bg: #f6efe2;
        --paper: #fffdf9;
        --ink: #1d241d;
        --muted: #697063;
        --line: #ddcfb8;
        --accent: #8a5a2f;
        --accent-soft: #f1e2cc;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Noto Sans Hebrew", "Assistant", "Rubik", sans-serif;
        background:
          radial-gradient(circle at top right, #f0debf 0, transparent 26%),
          linear-gradient(180deg, #fbf5eb 0%, var(--bg) 100%);
        color: var(--ink);
        line-height: 1.75;
        font-size: 16px;
      }
      .page {
        max-width: 1040px;
        margin: 0 auto;
        padding: 32px 20px 56px;
      }
      .hero {
        background: var(--paper);
        border: 1px solid var(--line);
        border-radius: 24px;
        padding: 28px;
        box-shadow: 0 14px 40px rgba(74, 53, 28, 0.08);
      }
      h1 {
        margin: 0 0 10px;
        font-size: clamp(2rem, 4vw, 3rem);
        line-height: 1.15;
      }
      .subtitle {
        margin: 0;
        color: var(--muted);
        font-size: 1.04rem;
      }
      .timeline {
        list-style: none;
        padding: 0;
        margin: 28px 0 0;
        display: grid;
        gap: 14px;
      }
      .item {
        background: rgba(255, 253, 249, 0.94);
        border: 1px solid var(--line);
        border-radius: 20px;
        padding: 16px 18px 15px;
        break-inside: avoid;
        page-break-inside: avoid;
      }
      .time {
        display: inline-block;
        margin-bottom: 9px;
        padding: 4px 10px;
        border-radius: 999px;
        background: var(--accent-soft);
        color: var(--accent);
        font-size: 0.9rem;
        font-weight: 700;
      }
      h2 {
        margin: 0 0 6px;
        font-size: 1.18rem;
      }
      p { margin: 0; }
      .story {
        display: block;
        margin-top: 8px;
        color: var(--muted);
      }
      .midrash {
        display: block;
        margin-top: 8px;
        color: #5f4930;
      }
      .footer {
        margin-top: 22px;
        color: var(--muted);
        font-size: 0.95rem;
      }
      @media print {
        @page { size: A4; margin: 10mm; }
        body { background: #fff; font-size: 12px; line-height: 1.45; }
        .page { max-width: none; padding: 0; }
        .hero {
          box-shadow: none;
          border-radius: 14px;
          padding: 16px;
          margin-bottom: 12px;
          break-inside: avoid;
          page-break-inside: avoid;
        }
        h1 { font-size: 1.8rem; margin-bottom: 6px; }
        .subtitle { font-size: 0.9rem; }
        .timeline {
          column-count: 2;
          column-gap: 10px;
          gap: 0;
          margin-top: 14px;
        }
        .item {
          display: inline-block;
          width: 100%;
          border-radius: 12px;
          padding: 10px 12px;
          margin: 0 0 8px;
        }
        .time { margin-bottom: 5px; padding: 3px 8px; font-size: 0.76rem; }
        h2 { font-size: 0.98rem; margin-bottom: 4px; }
        p { font-size: 0.82rem; }
        .story, .midrash { margin-top: 4px; font-size: 0.79rem; }
        .footer { margin-top: 12px; font-size: 0.78rem; }
      }
    </style>
  </head>
  <body>
    <main class="page">
${innerHtml}
    </main>
  </body>
</html>`;
}

async function generateHandoutHtml({ title, transcriptText, summaryText, apiKey }) {
  const prompt = [
    {
      role: "system",
      content: [
        {
          type: "input_text",
          text:
            "You create polished Hebrew family handouts for Torah lectures. Output only HTML fragments to be embedded inside <main class=\"page\">. Use natural Hebrew, warm but not childish. Structure must include: one <section class=\"hero\"> with <h1> and <p class=\"subtitle\">, one <ol class=\"timeline\"> containing at least 20 <li class=\"item\"> entries. Each item must include <div class=\"time\">, <h2>, and one <p>. Inside that <p>, include the main explanation text, then a <span class=\"story\"><strong>סיפור מן השיעור:</strong> ...</span>. If the lecture references a מדרש or מדרשי חז\"ל relevant to that point, also include <span class=\"midrash\"><strong>מדרש/מקור שהוזכר:</strong> ...</span>. If there is no clear reference for that bullet, omit the midrash span for that bullet. Finish with <p class=\"footer\">. Do not include markdown fences, scripts, or a full HTML document."
        }
      ]
    },
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text:
            `Lecture title: ${title}\n\n` +
            `Summary by 5-minute chunks:\n${summaryText}\n\n` +
            `Full transcript:\n${transcriptText}`
        }
      ]
    }
  ];

  return callResponsesApi(apiKey, prompt);
}

async function renderPdf(htmlPath, pdfPath) {
  await fsp.mkdir(path.dirname(pdfPath), { recursive: true });
  await runCommand(PDF_PRINTER, [
    "--headless",
    "--disable-gpu",
    "--no-sandbox",
    `--print-to-pdf=${pdfPath}`,
    `file://${htmlPath}`
  ]);
}

async function processLecture(url) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required.");
  }

  const mp3Path = await downloadYoutubeAsMp3(url, "output");
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
  const fullHtml = buildHtmlDocument(baseName, handoutInnerHtml);
  await fsp.writeFile(htmlPath, fullHtml, "utf8");

  console.log(`Rendering PDF: ${path.basename(pdfPath)}`);
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
  const url = process.argv[2];
  if (!url) {
    console.error("Usage: node process-youtube-lecture.js <youtube-url>");
    process.exitCode = 1;
    return;
  }

  const result = await processLecture(url);
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
  buildHtmlDocument,
  generateHandoutHtml,
  processLecture,
  renderPdf,
  slugifyFileBase
};
