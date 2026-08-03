"use strict";

const { spawn } = require("child_process");

/**
 * Run a command and resolve with trimmed stdout. Rejects with stderr attached,
 * which v1 sometimes swallowed — a silent ffmpeg failure is very hard to debug.
 */
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (options.pipeStdout) process.stdout.write(text);
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (options.pipeStderr) process.stderr.write(text);
    });

    child.on("error", (error) => {
      reject(
        new Error(
          `Failed to spawn "${command}". Is it installed and on PATH?\n${error.message}`
        )
      );
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      const detail = stderr.trim() || stdout.trim();
      reject(
        new Error(
          `${command} exited with code ${code}.${detail ? `\n${detail}` : ""}`
        )
      );
    });
  });
}

function commandExists(command, args = ["-version"]) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

const binaryCache = new Map();

/**
 * v1 hardcoded `--ffmpeg-location /usr/bin/ffmpeg`, which breaks on macOS
 * (homebrew), on Windows, and inside most containers. Resolve at runtime and
 * cache the answer.
 */
async function resolveBinary(name, candidates = []) {
  if (binaryCache.has(name)) return binaryCache.get(name);

  const probes = [...candidates, name];
  for (const candidate of probes) {
    if (await commandExists(candidate)) {
      binaryCache.set(name, candidate);
      return candidate;
    }
  }
  throw new Error(
    `Required binary "${name}" was not found. Install it or add it to PATH.`
  );
}

/** Bounded-concurrency map. Keeps chunk transcription from stampeding the API. */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}

module.exports = { run, commandExists, resolveBinary, mapLimit };
