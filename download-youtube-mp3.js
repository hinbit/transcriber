const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

function commandExists(command, args = ["--version"]) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

async function resolveYtDlpCommand() {
  const localYtDlp = path.resolve(".venv/bin/yt-dlp");
  if (await commandExists(localYtDlp)) {
    return { command: localYtDlp, args: [] };
  }

  const localPython = path.resolve(".venv/bin/python3");
  if (await commandExists(localPython, ["-m", "yt_dlp", "--version"])) {
    return { command: localPython, args: ["-m", "yt_dlp"] };
  }

  if (await commandExists("yt-dlp")) {
    return { command: "yt-dlp", args: [] };
  }

  if (await commandExists("python3", ["-m", "yt_dlp", "--version"])) {
    return { command: "python3", args: ["-m", "yt_dlp"] };
  }

  throw new Error(
    "yt-dlp is not installed. Install it with `python3 -m pip install --user yt-dlp` or add `yt-dlp` to PATH."
  );
}

async function downloadYoutubeAsMp3(videoUrl, outputDir = "output") {
  if (!videoUrl) {
    throw new Error("A YouTube URL is required.");
  }

  const absoluteOutputDir = path.resolve(outputDir);
  fs.mkdirSync(absoluteOutputDir, { recursive: true });

  const ytDlp = await resolveYtDlpCommand();
  const outputTemplate = path.join(absoluteOutputDir, "%(title)s.%(ext)s");

  const args = [
    ...ytDlp.args,
    videoUrl,
    "--no-playlist",
    "--extract-audio",
    "--audio-format",
    "mp3",
    "--audio-quality",
    "0",
    "--ffmpeg-location",
    "/usr/bin/ffmpeg",
    "--output",
    outputTemplate,
    "--print",
    "after_move:filepath"
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(ytDlp.command, args, {
      cwd: process.cwd(),
      env: process.env
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `yt-dlp exited with code ${code}.\n${stderr || stdout}`.trim()
          )
        );
        return;
      }

      const lines = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const downloadedFile = lines[lines.length - 1];

      if (!downloadedFile || !fs.existsSync(downloadedFile)) {
        reject(
          new Error(
            "Download finished but the output file path could not be verified."
          )
        );
        return;
      }

      resolve(downloadedFile);
    });
  });
}

module.exports = {
  downloadYoutubeAsMp3
};
