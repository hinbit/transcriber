"use strict";

const fs = require("fs");
const path = require("path");

let loaded = false;

/**
 * Walk up from a starting directory looking for a .env.
 *
 * Resolving "./.env" against the cwd only works when the process happens to
 * start at the file's directory. In a workspace it never does: the server runs
 * from packages/server, the CLI from packages/transcriber, and the .env lives
 * at the repo root. Every value then silently falls back to its default, which
 * surfaces later as a missing-key error pointing at a file that does exist.
 */
function findEnvFile(startDir) {
  let dir = path.resolve(startDir);

  for (;;) {
    const candidate = path.join(dir, ".env");
    if (fs.existsSync(candidate)) return candidate;

    const parent = path.dirname(dir);
    if (parent === dir) return null; // filesystem root
    dir = parent;
  }
}

/**
 * Loads .env without a dependency, and — critically — trims every value.
 * An unnoticed trailing space on OPENAI_API_KEY produces a 401 that looks
 * exactly like a wrong key, and costs an hour every time.
 */
function loadEnv(envPath) {
  if (loaded && !envPath) return process.env;

  const explicit = envPath || process.env.TRANSCRIBER_ENV_FILE;
  const file = explicit ? path.resolve(explicit) : findEnvFile(process.cwd());
  loaded = true;

  if (!file || !fs.existsSync(file)) return process.env;

  const content = fs.readFileSync(file, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key && process.env[key] === undefined) {
      process.env[key] = value.trim();
    }
  }

  return process.env;
}

/** Always read env through this. Never touch process.env directly. */
function env(key, fallback = undefined) {
  loadEnv();
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  return String(raw).trim();
}

function envInt(key, fallback) {
  const raw = env(key);
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(key, fallback) {
  const raw = env(key);
  if (raw === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

/**
 * Recognise the placeholder values .env.example ships with.
 *
 * `cp .env.example .env` leaves every unused provider holding a value like
 * sk-ant-xxxxxxxx. A plain emptiness check calls that configured, so the
 * startup validation passes and the run instead dies against the API — which
 * is the exact failure assertConfigured() exists to prevent. Six consecutive
 * x's never occur in a real key.
 */
function isPlaceholder(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return true;
  return /x{6,}/i.test(raw) || /^(your[-_ ]?\S*|change[-_ ]?me|todo|<.+>)$/i.test(raw);
}

/** True when a variable holds something that could actually be a key. */
function hasKey(varName) {
  return !isPlaceholder(env(varName));
}

/** Generic key resolver so each provider reports its own missing variable. */
function requireKey(explicit, varName, label) {
  const key = (explicit || env(varName) || "").trim();
  if (!key || isPlaceholder(key)) {
    const error = new Error(
      key
        ? `${varName} still holds the placeholder from .env.example ("${key.slice(0, 12)}…"). ` +
          `Set a real key for ${label || varName}.`
        : `${varName} is required for ${label || varName}. Set it in .env or pass options.apiKey.`
    );
    // A missing key is a configuration fault, not a transient one — callers
    // must not retry it on another model or another attempt.
    error.deterministic = true;
    throw error;
  }
  return key;
}

/** @deprecated use requireKey(explicit, "OPENAI_API_KEY", "OpenAI") */
const requireApiKey = (explicit) => requireKey(explicit, "OPENAI_API_KEY", "OpenAI");

module.exports = {
  loadEnv,
  findEnvFile,
  env,
  envInt,
  envBool,
  isPlaceholder,
  hasKey,
  requireKey,
  requireApiKey,
};
