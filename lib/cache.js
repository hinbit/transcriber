"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { createHash } = require("crypto");

/**
 * v1 cached by chunk FILENAME. Re-encode the same lecture and every cache entry
 * silently goes stale — or worse, a different video with the same base name
 * reuses the wrong transcript. Key on the audio bytes plus every parameter that
 * can change the output.
 */
async function fileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function hashParams(params) {
  return createHash("sha256")
    .update(JSON.stringify(params, Object.keys(params).sort()))
    .digest("hex")
    .slice(0, 12);
}

class TranscriptCache {
  constructor(dir) {
    this.dir = path.resolve(dir || path.join("output", ".cache"));
    this.enabled = true;
  }

  async key(filePath, params) {
    const content = await fileSha256(filePath);
    return `${content.slice(0, 24)}-${hashParams(params)}`;
  }

  pathFor(key) {
    return path.join(this.dir, `${key}.json`);
  }

  async get(key) {
    if (!this.enabled) return null;
    const file = this.pathFor(key);
    try {
      return JSON.parse(await fsp.readFile(file, "utf8"));
    } catch {
      return null;
    }
  }

  async set(key, value) {
    if (!this.enabled) return;
    await fsp.mkdir(this.dir, { recursive: true });
    // Write-then-rename so a crash mid-write never leaves corrupt JSON behind.
    const tmp = `${this.pathFor(key)}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(value), "utf8");
    await fsp.rename(tmp, this.pathFor(key));
  }

  async clear() {
    await fsp.rm(this.dir, { recursive: true, force: true });
  }
}

module.exports = { TranscriptCache, fileSha256, hashParams };
