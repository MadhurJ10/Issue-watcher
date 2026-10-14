// src/state.js
// Atomic read/write for seen.json and meta.json.
// Corrupt or missing files: log a warning and continue with empty state.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { log } from "./util.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const STATE_DIR = resolve(__dirname, "../state");
const SEEN_PATH = resolve(STATE_DIR, "seen.json");
const META_PATH = resolve(STATE_DIR, "meta.json");

// Ensure state/ directory exists
function ensureStateDir() {
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Atomic write: write to a temp file, then rename (atomic on POSIX; best-effort
// on Windows where rename will overwrite atomically from Node 14.14+).
// ---------------------------------------------------------------------------
function atomicWrite(filePath, data) {
  const tmp = filePath + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  renameSync(tmp, filePath);
}

// ---------------------------------------------------------------------------
// Safe JSON read: returns null if file missing or corrupt
// ---------------------------------------------------------------------------
function safeReadJson(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    log.warn(`State file corrupt or unreadable, starting fresh: ${filePath}`, {
      error: err.message,
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// seen.json: { "ids": { "<issueId>": "<isoTimestamp>" } }
// ---------------------------------------------------------------------------

/**
 * Load seen.json.
 * @returns {{ ids: Record<string, string> }}
 */
export function loadSeen() {
  ensureStateDir();
  const data = safeReadJson(SEEN_PATH);
  if (!data || typeof data.ids !== "object" || Array.isArray(data.ids)) {
    log.warn("seen.json missing or invalid, starting with empty seen set");
    return { ids: {} };
  }
  return { ids: data.ids };
}

/**
 * Save seen.json atomically.
 * Also prunes entries older than 30 days.
 * @param {{ ids: Record<string, string> }} seen
 */
export function saveSeen(seen) {
  ensureStateDir();
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const pruned = {};
  for (const [id, ts] of Object.entries(seen.ids)) {
    if (new Date(ts).getTime() > cutoff) {
      pruned[id] = ts;
    }
  }
  const pruneCount = Object.keys(seen.ids).length - Object.keys(pruned).length;
  if (pruneCount > 0) {
    log.info(`Pruned ${pruneCount} old entries from seen.json`);
  }
  atomicWrite(SEEN_PATH, { ids: pruned });
}

/**
 * Mark an issue as seen.
 * @param {{ ids: Record<string, string> }} seen
 * @param {number|string} issueId
 */
export function markSeen(seen, issueId) {
  seen.ids[String(issueId)] = new Date().toISOString();
}

/**
 * Check if an issue ID is already seen.
 * @param {{ ids: Record<string, string> }} seen
 * @param {number|string} issueId
 * @returns {boolean}
 */
export function isSeen(seen, issueId) {
  return Object.prototype.hasOwnProperty.call(seen.ids, String(issueId));
}

// ---------------------------------------------------------------------------
// meta.json: { "lastRun": "<isoTimestamp>", "consecutiveFailedRuns": number }
// ---------------------------------------------------------------------------

/**
 * Load meta.json.
 * @returns {{ lastRun: string|null, consecutiveFailedRuns: number }}
 */
export function loadMeta() {
  ensureStateDir();
  const data = safeReadJson(META_PATH);
  if (!data) {
    return { lastRun: null, consecutiveFailedRuns: 0 };
  }
  return {
    lastRun: typeof data.lastRun === "string" ? data.lastRun : null,
    consecutiveFailedRuns: typeof data.consecutiveFailedRuns === "number"
      ? data.consecutiveFailedRuns
      : 0,
  };
}

/**
 * Save meta.json atomically.
 * @param {{ lastRun: string|null, consecutiveFailedRuns: number }} meta
 */
export function saveMeta(meta) {
  ensureStateDir();
  atomicWrite(META_PATH, meta);
}

/**
 * Get the ISO timestamp to use as the lower bound for issue discovery.
 * Falls back to "now minus 24 hours" on first run.
 * @param {{ lastRun: string|null }} meta
 * @returns {string} ISO timestamp
 */
export function getLastRunTimestamp(meta) {
  if (meta.lastRun) return meta.lastRun;
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return oneDayAgo.toISOString();
}
