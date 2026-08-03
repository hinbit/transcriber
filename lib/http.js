"use strict";

const { envInt } = require("./env");

/** Status codes worth retrying. 429 and 5xx are transient; 4xx otherwise is not. */
const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Shared retry wrapper for every provider. Exponential backoff, but honours a
 * Retry-After header when the API tells us how long to wait — guessing when
 * you have been given the answer just wastes quota.
 */
async function fetchWithRetry(url, options, attempts) {
  const maxAttempts = attempts || envInt("TRANSCRIBER_RETRY_ATTEMPTS", 3);
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(url, options);
      if (response.ok || !RETRYABLE.has(response.status)) return response;

      lastError = new Error(`${response.status} ${response.statusText}`);
      const retryAfter = Number(response.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 1000 * 2 ** (attempt - 1);

      if (attempt < maxAttempts) await sleep(waitMs);
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) await sleep(1000 * 2 ** (attempt - 1));
    }
  }

  throw new Error(`Request to ${url} failed after ${maxAttempts} attempts: ${lastError?.message}`);
}

module.exports = { fetchWithRetry, RETRYABLE };
