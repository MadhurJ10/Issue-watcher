// src/util.js
// Logger, fetchWithRetry, withTimeout, sleep utilities

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------
const LEVELS = { info: 0, warn: 1, error: 2 };

function formatMsg(level, msg, meta) {
  const ts = new Date().toISOString();
  const metaStr = meta ? " " + JSON.stringify(meta) : "";
  return `[${ts}] [${level.toUpperCase()}] ${msg}${metaStr}`;
}

export const log = {
  info: (msg, meta) => console.log(formatMsg("info", msg, meta)),
  warn: (msg, meta) => console.warn(formatMsg("warn", msg, meta)),
  error: (msg, meta) => console.error(formatMsg("error", msg, meta)),
};

// ---------------------------------------------------------------------------
// Sleep
// ---------------------------------------------------------------------------
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// withTimeout – wraps a promise with an AbortController-based timeout
// Returns { promise, abort } so the caller can also cancel manually.
// ---------------------------------------------------------------------------
export function withTimeout(promiseFn, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  return promiseFn(controller.signal).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// fetchWithRetry
//
// Options:
//   timeoutMs   – per-attempt timeout (default 15 000)
//   maxRetries  – how many *extra* attempts (default 2, so 3 total)
//   retryOn4xx  – never (per spec)
//   headers     – additional headers merged in
// ---------------------------------------------------------------------------
export async function fetchWithRetry(url, options = {}, retryConfig = {}) {
  const {
    timeoutMs = 15_000,
    maxRetries = 2,
  } = retryConfig;

  // Safety: never log Authorization header values
  const safeHeaders = { ...(options.headers ?? {}) };

  let lastErr;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        ...options,
        headers: safeHeaders,
        signal: controller.signal,
      });
      clearTimeout(timer);

      // Handle rate-limit headers
      const remaining = res.headers.get("X-RateLimit-Remaining");
      if (remaining !== null && parseInt(remaining, 10) < 5) {
        log.warn("GitHub rate limit nearly exhausted, stopping further calls", {
          remaining,
        });
        // Return the response; callers check the flag separately
        res._rateLimitExhausted = true;
      }

      // Respect Retry-After / X-RateLimit-Reset on 429
      if (res.status === 429 || res.status === 503) {
        const retryAfter =
          res.headers.get("Retry-After") ||
          res.headers.get("X-RateLimit-Reset");
        let waitMs = 1000; // default 1 s

        if (retryAfter) {
          const val = parseInt(retryAfter, 10);
          if (!isNaN(val)) {
            // Retry-After is seconds; X-RateLimit-Reset is a Unix timestamp
            waitMs = val > 1_000_000_000
              ? (val * 1000 - Date.now()) // epoch seconds
              : val * 1000; // seconds duration
          }
        }

        if (waitMs > 60_000) {
          log.warn("Rate limit wait > 60s, skipping further calls of this type", { url, waitMs });
          throw new Error(`RateLimitLong:${waitMs}`);
        }

        if (attempt < maxRetries) {
          log.warn(`Rate limited (${res.status}), waiting ${waitMs}ms`, { url, attempt });
          await sleep(waitMs);
          continue;
        }
      }

      // Don't retry on non-retryable 4xx (except 429 handled above)
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        return res; // let caller handle 4xx
      }

      // Retry on 5xx
      if (res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
        if (attempt < maxRetries) {
          const backoff = (attempt + 1) * 1000;
          log.warn(`Server error ${res.status}, retrying in ${backoff}ms`, { url, attempt });
          await sleep(backoff);
          continue;
        }
        return res;
      }

      return res;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;

      const isNetwork =
        err.name === "AbortError" ||
        err.code === "ECONNRESET" ||
        err.code === "ENOTFOUND" ||
        err.code === "ETIMEDOUT" ||
        err.message?.includes("network");

      if (!isNetwork || attempt >= maxRetries) {
        throw err;
      }

      const backoff = (attempt + 1) * 1000;
      log.warn(`Network error, retrying in ${backoff}ms`, {
        url,
        error: err.message,
        attempt,
      });
      await sleep(backoff);
    }
  }

  throw lastErr ?? new Error("fetchWithRetry: unknown error");
}
