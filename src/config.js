// src/config.js
// Loads, validates, and exports the merged config (config.json + env vars).

import { readFileSync } from "fs";
import { resolve } from "path";
import { fileURLToPath } from "url";
import { log } from "./util.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const CONFIG_PATH = resolve(__dirname, "../config.json");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function assertType(val, type, path) {
  if (typeof val !== type) {
    throw new Error(`config.json: "${path}" must be a ${type}, got ${typeof val}`);
  }
}

function assertArray(val, path) {
  if (!Array.isArray(val)) {
    throw new Error(`config.json: "${path}" must be an array`);
  }
}

function assertRange(val, min, max, path) {
  if (typeof val !== "number" || val < min || val > max) {
    throw new Error(`config.json: "${path}" must be a number between ${min} and ${max}`);
  }
}

// ---------------------------------------------------------------------------
// Validate the parsed config object (throws on error)
// ---------------------------------------------------------------------------
function validate(cfg) {
  // discovery
  if (cfg.discovery?.enabled !== undefined) {
    assertType(cfg.discovery.enabled, "boolean", "discovery.enabled");
  }
  assertArray(cfg.discovery?.languages, "discovery.languages");
  assertArray(cfg.discovery?.labels, "discovery.labels");
  assertArray(cfg.discovery?.excludeLabels, "discovery.excludeLabels");
  assertRange(cfg.discovery?.minStars, 0, Infinity, "discovery.minStars");
  assertRange(cfg.discovery?.maxStars, 1, Infinity, "discovery.maxStars");
  assertRange(cfg.discovery?.maxResultsPerRun, 1, 1000, "discovery.maxResultsPerRun");

  if (cfg.discovery.minStars >= cfg.discovery.maxStars) {
    throw new Error("config.json: discovery.minStars must be less than discovery.maxStars");
  }

  // watchlist
  assertArray(cfg.watchlist, "watchlist");

  // filters
  assertRange(cfg.filters?.maxBodyChars, 1, Infinity, "filters.maxBodyChars");
  assertRange(cfg.filters?.minBodyChars, 0, Infinity, "filters.minBodyChars");
  assertRange(cfg.filters?.maxIssueAgeHours, 1, Infinity, "filters.maxIssueAgeHours");
  const pushedWithinDays =
    cfg.filters?.repoMustBePushedWithinDays ?? cfg.filters?.repoMustHaveMergedPrWithinDays;
  assertRange(pushedWithinDays, 1, 365, "filters.repoMustBePushedWithinDays");
  assertArray(cfg.filters?.skipIfCommentMatches, "filters.skipIfCommentMatches");

  // scoring
  assertRange(cfg.scoring?.notifyThreshold, 1, 5, "scoring.notifyThreshold");
  assertType(cfg.scoring?.useAI, "boolean", "scoring.useAI");
  assertRange(cfg.scoring?.ai?.timeoutMs, 1, 60000, "scoring.ai.timeoutMs");
  assertRange(cfg.scoring?.ai?.maxRetries, 0, 10, "scoring.ai.maxRetries");
  assertRange(cfg.scoring?.ai?.maxIssuesPerRun, 1, 100, "scoring.ai.maxIssuesPerRun");
  assertRange(cfg.scoring?.ai?.circuitBreakerFailures, 1, 20, "scoring.ai.circuitBreakerFailures");

  // notify
  assertRange(cfg.notify?.maxMessagesPerRun, 1, 100, "notify.maxMessagesPerRun");

  const qh = cfg.notify?.quietHoursIST;
  if (!qh?.start || !qh?.end) {
    throw new Error("config.json: notify.quietHoursIST must have start and end");
  }
  if (!/^\d{2}:\d{2}$/.test(qh.start) || !/^\d{2}:\d{2}$/.test(qh.end)) {
    throw new Error("config.json: notify.quietHoursIST times must be in HH:MM format");
  }
}

// ---------------------------------------------------------------------------
// Validate required environment variables (throws on missing)
// ---------------------------------------------------------------------------
function validateEnv() {
  const required = ["GH_TOKEN", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}. ` +
        "Set them as GitHub Actions secrets or in your shell for local runs."
    );
  }

  // Basic format check on Telegram bot token (never log the actual value)
  const tbt = process.env.TELEGRAM_BOT_TOKEN;
  if (!/^\d+:[A-Za-z0-9_-]{35,}$/.test(tbt)) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN does not look like a valid bot token (expected format: <digits>:<35+ chars>). " +
        "Check the value you set."
    );
  }
}

// ---------------------------------------------------------------------------
// Load & export
// ---------------------------------------------------------------------------
function loadConfig() {
  let raw;
  try {
    raw = readFileSync(CONFIG_PATH, "utf8");
  } catch (err) {
    throw new Error(`Cannot read config.json at ${CONFIG_PATH}: ${err.message}`);
  }

  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (err) {
    throw new Error(`config.json is not valid JSON: ${err.message}`);
  }

  try {
    validate(cfg);
  } catch (err) {
    throw err; // re-throw with the message from validate()
  }

  if (cfg.discovery) {
    cfg.discovery.enabled = cfg.discovery.enabled ?? false;
  }

  if (cfg.filters) {
    cfg.filters.repoMustBePushedWithinDays =
      cfg.filters.repoMustBePushedWithinDays ?? cfg.filters.repoMustHaveMergedPrWithinDays;
  }

  // DRY_RUN flag
  const dryRun = process.env.DRY_RUN === "1";

  // AI config
  const aiApiKey = process.env.AI_API_KEY ?? null;
  const aiEnabled =
    cfg.scoring.useAI && !!aiApiKey;

  return {
    ...cfg,
    env: {
      ghToken: process.env.GH_TOKEN,
      telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
      telegramChatId: process.env.TELEGRAM_CHAT_ID,
      aiApiKey,
      aiProvider: process.env.AI_PROVIDER ?? "anthropic",
      aiModel: process.env.AI_MODEL ?? "claude-haiku-4-5",
      dryRun,
    },
    ai: {
      ...cfg.scoring.ai,
      enabled: aiEnabled,
      circuitOpen: false,
      consecutiveFailures: 0,
      maxFailures: cfg.scoring.ai.circuitBreakerFailures,
      aiUnavailableThisRun: false,
    },
  };
}

// ---------------------------------------------------------------------------
// Entry point – called once at startup
// Exits with code 1 on any validation failure (the only hard-fail case).
// ---------------------------------------------------------------------------
export function initConfig() {
  // In DRY_RUN mode, skip env validation for secrets (makes local testing easy).
  // We still validate config.json structure.
  const isDryRun = process.env.DRY_RUN === "1";

  let cfg;
  try {
    // Parse and validate config.json first (structure only)
    const raw = readFileSync(CONFIG_PATH, "utf8");
    cfg = JSON.parse(raw);
    validate(cfg);
  } catch (err) {
    log.error(`Config validation failed: ${err.message}`);
    process.exit(1);
  }

  if (!isDryRun) {
    try {
      validateEnv();
    } catch (err) {
      log.error(`Environment validation failed: ${err.message}`);
      process.exit(1);
    }
  } else {
    // In dry run, we still need some env vars to be present or use stubs
    log.info("DRY_RUN=1: skipping secret validation (Telegram/AI calls will be skipped)");

    // Set stub values for missing secrets so the rest of the code doesn't crash
    if (!process.env.GH_TOKEN) {
      log.warn("GH_TOKEN not set – GitHub API calls will be unauthenticated (lower rate limits)");
    }
    if (!process.env.TELEGRAM_BOT_TOKEN) {
      process.env.TELEGRAM_BOT_TOKEN = "0000000000:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    }
    if (!process.env.TELEGRAM_CHAT_ID) {
      process.env.TELEGRAM_CHAT_ID = "0";
    }
  }

  return loadConfig();
}
