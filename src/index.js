// src/index.js
// Main orchestrator – full pipeline (Phases 1–6). All stages, all resilience.

import { initConfig } from "./config.js";
import {
  loadSeen,
  loadMeta,
  saveSeen,
  saveMeta,
  getLastRunTimestamp,
  markSeen,
  isSeen,
} from "./state.js";
import {
  fetchDiscoveryIssues,
  fetchWatchlistIssues,
  mergeAndDedupe,
  resetRateLimitGate,
  resetRepoCache,
} from "./github.js";
import { runCheapFilters, runExpensiveFilters, parseRepo } from "./filters.js";
import { scoreIssue } from "./scoring.js";
import { formatMessage, sendTelegramMessage, isQuietHour } from "./notify.js";
import { log } from "./util.js";

// ---------------------------------------------------------------------------
// Global unhandled error safety nets
// ---------------------------------------------------------------------------
process.on("uncaughtException", (err) => {
  log.error("Uncaught exception", { message: err.message, stack: err.stack });
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  log.error("Unhandled rejection", {
    message: reason?.message ?? String(reason),
    stack: reason?.stack,
  });
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Run summary accumulator
// ---------------------------------------------------------------------------
const summary = {
  fetched: 0,
  deduped: 0,
  dropped: 0,
  dropReasons: {},
  scored: 0,
  aiScored: 0,
  rulesScored: 0,
  notified: 0,
  errors: 0,
};

function recordDrop(reason) {
  summary.dropped++;
  const bucket = reason.split(":")[0];
  summary.dropReasons[bucket] = (summary.dropReasons[bucket] ?? 0) + 1;
}

function printSummary() {
  const reasons = Object.entries(summary.dropReasons)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  log.info(
    `Run summary: fetched=${summary.fetched} deduped=${summary.deduped} ` +
      `dropped=${summary.dropped} (reasons: ${reasons || "none"}) ` +
      `scored=${summary.scored} (AI=${summary.aiScored}, rules=${summary.rulesScored}) ` +
      `notified=${summary.notified} errors=${summary.errors}`
  );
}

// ---------------------------------------------------------------------------
// Helper: issue label string
// ---------------------------------------------------------------------------
function issueLabel(issue) {
  const { owner, repo } = parseRepo(issue);
  return `${owner}/${repo}#${issue.number}`;
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------
async function main() {
  log.info("=== Issue Watcher starting ===");

  // ------------------------------------------------------------------
  // 1. Config (hard-exits on validation failure)
  // ------------------------------------------------------------------
  const config = initConfig();
  log.info(`Config loaded. DRY_RUN=${config.env.dryRun}`);

  // Build the ctx object used by scoring.js
  const ctx = {
    ai: config.ai,
    env: config.env,
  };

  // ------------------------------------------------------------------
  // 2. Load state
  // ------------------------------------------------------------------
  const seen = loadSeen();
  const meta = loadMeta();
  const lastRun = getLastRunTimestamp(meta);
  log.info(`State loaded. seen=${Object.keys(seen.ids).length} issues. lastRun=${lastRun}`);

  // ------------------------------------------------------------------
  // 3. FETCH – discovery + watchlist
  // ------------------------------------------------------------------
  resetRateLimitGate();
  resetRepoCache();
  let fetchSucceeded = false;
  let allIssues = [];

  try {
    log.info("--- Stage: FETCH ---");
    const [discoveryResult, watchlistResult] = await Promise.allSettled([
      fetchDiscoveryIssues(config, lastRun),
      fetchWatchlistIssues(config, lastRun),
    ]);

    const discovered =
      discoveryResult.status === "fulfilled" ? discoveryResult.value : [];
    const watchlisted =
      watchlistResult.status === "fulfilled" ? watchlistResult.value : [];

    if (discoveryResult.status === "rejected") {
      log.warn("Discovery fetch failed", { error: discoveryResult.reason?.message });
      summary.errors++;
    }
    if (watchlistResult.status === "rejected") {
      log.warn("Watchlist fetch failed", { error: watchlistResult.reason?.message });
      summary.errors++;
    }

    allIssues = mergeAndDedupe(discovered, watchlisted);
    summary.fetched = allIssues.length;
    log.info(
      `Fetched ${allIssues.length} unique issues ` +
        `(discovery=${discovered.length}, watchlist=${watchlisted.length})`
    );
    fetchSucceeded = true;
  } catch (err) {
    log.error("Fetch stage failed catastrophically", { error: err.message });
    summary.errors++;
  }

  // ------------------------------------------------------------------
  // 4. DEDUPE – drop already-seen issues
  // ------------------------------------------------------------------
  log.info("--- Stage: DEDUPE ---");
  const unseenIssues = allIssues.filter((issue) => !isSeen(seen, issue.id));
  summary.deduped = unseenIssues.length;
  log.info(
    `After dedupe: ${unseenIssues.length} new issues ` +
      `(dropped ${allIssues.length - unseenIssues.length} already-seen)`
  );

  const candidates = unseenIssues.slice(0, config.discovery.maxResultsPerRun);
  if (candidates.length < unseenIssues.length) {
    log.info(`Capped to ${config.discovery.maxResultsPerRun} issues (maxResultsPerRun)`);
  }

  // ------------------------------------------------------------------
  // 5. CHEAP FILTERS
  // ------------------------------------------------------------------
  log.info("--- Stage: CHEAP FILTERS ---");
  const cheapSurvivors = [];

  for (const issue of candidates) {
    try {
      const result = runCheapFilters(issue, config);
      if (!result.pass) {
        log.info(`dropped ${issueLabel(issue)}: ${result.reason}`);
        recordDrop(result.reason);
        markSeen(seen, issue.id);
      } else {
        cheapSurvivors.push(issue);
      }
    } catch (err) {
      log.warn(`Cheap filter error on ${issueLabel(issue)}, skipping`, {
        error: err.message,
      });
      summary.errors++;
    }
  }
  log.info(`After cheap filters: ${cheapSurvivors.length} survivors`);

  // ------------------------------------------------------------------
  // 6. EXPENSIVE FILTERS
  // ------------------------------------------------------------------
  log.info("--- Stage: EXPENSIVE FILTERS ---");
  const expensiveSurvivors = [];

  for (const issue of cheapSurvivors) {
    try {
      const result = await runExpensiveFilters(issue, config);
      if (!result.pass) {
        if (result.skip) {
          log.info(`skipped ${issueLabel(issue)}: ${result.reason} (retry next run)`);
          summary.errors++;
        } else {
          log.info(`dropped ${issueLabel(issue)}: ${result.reason}`);
          recordDrop(result.reason);
          markSeen(seen, issue.id);
        }
      } else {
        expensiveSurvivors.push(issue);
      }
    } catch (err) {
      log.warn(`Expensive filter error on ${issueLabel(issue)}, skipping`, {
        error: err.message,
      });
      summary.errors++;
    }
  }
  log.info(`After expensive filters: ${expensiveSurvivors.length} survivors`);

  // ------------------------------------------------------------------
  // 7. SCORE
  // ------------------------------------------------------------------
  log.info("--- Stage: SCORE ---");
  const scoredIssues = [];

  for (const issue of expensiveSurvivors) {
    try {
      const result = await scoreIssue(issue, ctx);
      summary.scored++;
      if (result.source === "AI") summary.aiScored++;
      else summary.rulesScored++;

      log.info(
        `scored ${issueLabel(issue)}: ${result.score}/5 [${result.source}] — ${result.reason}`
      );
      scoredIssues.push({ issue, scoreResult: result });
    } catch (err) {
      // Should never throw but just in case
      log.warn(`Scoring error on ${issueLabel(issue)}, skipping`, { error: err.message });
      summary.errors++;
    }
  }

  // Filter by notifyThreshold and sort by score descending
  const toNotify = scoredIssues
    .filter(({ scoreResult }) => scoreResult.score >= config.scoring.notifyThreshold)
    .sort((a, b) => b.scoreResult.score - a.scoreResult.score);

  log.info(
    `${toNotify.length} issues meet notify threshold of ${config.scoring.notifyThreshold}`
  );

  // ------------------------------------------------------------------
  // 8. NOTIFY
  // ------------------------------------------------------------------
  log.info("--- Stage: NOTIFY ---");

  // Check quiet hours
  const quiet = isQuietHour(config.notify.quietHoursIST);
  if (quiet) {
    log.info(
      "Quiet hours active (IST). Skipping notifications — issues will be retried next run."
    );
    // Do NOT mark these as seen
    printSummary();
    // Still update lastRun if fetch succeeded
    if (fetchSucceeded && !config.env.dryRun) {
      meta.lastRun = new Date().toISOString();
      saveMeta(meta);
      saveSeen(seen);
    }
    log.info("=== Issue Watcher finished ===");
    return;
  }

  // Apply message cap
  const cappedNotify = toNotify.slice(0, config.notify.maxMessagesPerRun);
  if (cappedNotify.length < toNotify.length) {
    log.info(
      `Message cap: sending ${cappedNotify.length} of ${toNotify.length} ` +
        `(remaining will be retried next run)`
    );
  }

  // DRY_RUN: print what would be sent, don't send, don't write state
  if (config.env.dryRun) {
    log.info(`[DRY_RUN] Would send ${cappedNotify.length} Telegram messages:`);
    for (const { issue, scoreResult } of cappedNotify) {
      const msg = formatMessage(issue, scoreResult);
      log.info(`\n--- [DRY_RUN] MESSAGE ---\n${msg}\n------------------------`);
    }

    // Log issues that would be dropped (below threshold)
    const belowThreshold = scoredIssues.filter(
      ({ scoreResult }) => scoreResult.score < config.scoring.notifyThreshold
    );
    if (belowThreshold.length > 0) {
      log.info(
        `[DRY_RUN] ${belowThreshold.length} issues below notify threshold (${config.scoring.notifyThreshold}):`
      );
      for (const { issue, scoreResult } of belowThreshold) {
        log.info(`  [DRY_RUN] score=${scoreResult.score} ${issueLabel(issue)} — ${issue.title}`);
      }
    }

    summary.notified = cappedNotify.length;
    printSummary();
    log.info("=== Issue Watcher finished (DRY_RUN) ===");
    return;
  }

  // Real send
  let aiUnavailableWarningAdded = false;
  let telegramFailed = false;

  // Section 8.11: check for consecutive failed runs and send alert if needed
  if (meta.consecutiveFailedRuns >= 3) {
    const alertMsg = `⚠️ Issue watcher has failed ${meta.consecutiveFailedRuns} runs in a row, check the Actions logs.`;
    const alertSent = await sendTelegramMessage(alertMsg, config).catch(() => false);
    if (alertSent) {
      log.warn(`Sent failure alert (${meta.consecutiveFailedRuns} consecutive failed runs)`);
    }
  }

  for (let i = 0; i < cappedNotify.length; i++) {
    const { issue, scoreResult } = cappedNotify[i];
    try {
      let msg = formatMessage(issue, scoreResult);

      // Add AI unavailable warning to the last message of the run (spec 7.3 #10)
      if (i === cappedNotify.length - 1 && ctx.ai.aiUnavailableThisRun && !aiUnavailableWarningAdded) {
        msg += "\n\n⚠️ AI scoring unavailable this run, used rule-based scores.";
        aiUnavailableWarningAdded = true;
      }

      const sent = await sendTelegramMessage(msg, config);
      if (sent) {
        markSeen(seen, issue.id);
        summary.notified++;
        log.info(`notified ${issueLabel(issue)}`);
      } else {
        // Telegram failed after retries – do NOT mark seen
        log.warn(`Failed to send notification for ${issueLabel(issue)}, will retry next run`);
        summary.errors++;
        telegramFailed = true;
      }
    } catch (err) {
      log.warn(`Notify error for ${issueLabel(issue)}`, { error: err.message });
      summary.errors++;
    }
  }

  // Mark below-threshold issues as seen (they were deliberately filtered)
  const belowThreshold = scoredIssues.filter(
    ({ scoreResult }) => scoreResult.score < config.scoring.notifyThreshold
  );
  for (const { issue } of belowThreshold) {
    markSeen(seen, issue.id);
    log.info(`dropped ${issueLabel(issue)}: scoreBelowThreshold`);
    recordDrop("scoreBelowThreshold");
  }

  // ------------------------------------------------------------------
  // 9. Save state
  // ------------------------------------------------------------------
  if (fetchSucceeded) {
    try {
      meta.lastRun = new Date().toISOString();
      // Reset consecutive failure counter on successful run
      // A successful run = fetch worked and at least no catastrophic errors
      if (summary.errors === 0 || summary.notified > 0) {
        meta.consecutiveFailedRuns = 0;
      } else {
        // Partial failures (e.g. all Telegram sends failed) count as failed
        meta.consecutiveFailedRuns = (meta.consecutiveFailedRuns ?? 0) + 1;
      }
      saveMeta(meta);
      saveSeen(seen);
      log.info("State saved.");
    } catch (err) {
      log.error("Failed to save state", { error: err.message });
      summary.errors++;
    }
  } else {
    // Fetch failed entirely – increment failure counter but don't update lastRun
    try {
      meta.consecutiveFailedRuns = (meta.consecutiveFailedRuns ?? 0) + 1;
      saveMeta(meta);
    } catch (err) {
      log.error("Failed to save meta after fetch failure", { error: err.message });
    }
  }

  printSummary();
  log.info("=== Issue Watcher finished ===");
}

main();
