// src/notify.js
// Telegram notification sender.

import { fetchWithRetry, log, sleep } from "./util.js";

const TELEGRAM_API = "https://api.telegram.org";

/**
 * Escape special HTML characters for Telegram HTML parse mode.
 */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Format a star count as "4.2k" or "32k" etc.
 */
function formatStars(stars) {
  if (stars == null) return "?";
  if (stars >= 1000) return `${(stars / 1000).toFixed(1)}k`;
  return String(stars);
}

/**
 * Format a scored issue as a Telegram HTML message.
 * Format from spec Section 5, Stage 7:
 *   {emoji} {owner}/{repo}  ⭐ {stars}k
 *   {title}
 *   Score {score}/5 · {source: AI | rules}
 *   {reason, one line}
 *   {url}
 */
export function formatMessage(issue, scoreResult) {
  const emoji = scoreResult.score >= 4 ? "🟢" : "🟡";

  // Extract owner/repo from issue
  let repoFull = "unknown/unknown";
  if (issue.repository_url) {
    repoFull = issue.repository_url.split("/repos/")[1] ?? repoFull;
  } else if (issue.repository?.full_name) {
    repoFull = issue.repository.full_name;
  } else if (issue.html_url) {
    const m = issue.html_url.match(/github\.com\/([^/]+\/[^/]+)\/issues/);
    if (m) repoFull = m[1];
  }

  const stars = formatStars(
    issue.repository?.stargazers_count ?? issue.stargazers_count
  );

  const lines = [
    `${emoji} <b>${escapeHtml(repoFull)}</b>  ⭐ ${escapeHtml(stars)}`,
    escapeHtml(issue.title ?? ""),
    `Score ${scoreResult.score}/5 · ${scoreResult.source}`,
    escapeHtml((scoreResult.reason ?? "").substring(0, 120)),
    escapeHtml(issue.html_url ?? ""),
  ];

  return lines.join("\n");
}

/**
 * Send a single Telegram message.
 * Retries up to 2 times, respects 429 retry_after.
 * Returns true on success, false on failure.
 */
export async function sendTelegramMessage(text, config) {
  const token = config.env.telegramBotToken;
  const chatId = config.env.telegramChatId;
  const url = `${TELEGRAM_API}/bot${token}/sendMessage`;

  const body = JSON.stringify({
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });

  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      const res = await fetchWithRetry(
        url,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        },
        { timeoutMs: 15_000, maxRetries: 0 } // we handle retries ourselves
      );

      if (res.ok) return true;

      if (res.status === 429) {
        let data;
        try { data = await res.json(); } catch { data = {}; }
        const retryAfter = data?.parameters?.retry_after ?? 5;
        log.warn(`Telegram 429, waiting ${retryAfter}s`, { attempt });
        await sleep(retryAfter * 1000);
        continue;
      }

      // Other error
      let errText;
      try { errText = await res.text(); } catch { errText = ""; }
      log.warn(`Telegram returned ${res.status}`, { body: errText.substring(0, 200) });

      if (attempt < 2) {
        await sleep((attempt + 1) * 1000);
        continue;
      }

      return false;
    } catch (err) {
      log.warn(`Telegram send error`, { error: err.message, attempt });
      if (attempt < 2) {
        await sleep((attempt + 1) * 1000);
        continue;
      }
      return false;
    }
  }

  return false;
}

/**
 * Check if the current IST time is within quiet hours.
 * @param {{ start: string, end: string }} quietHours – HH:MM strings
 * @returns {boolean}
 */
export function isQuietHour(quietHours) {
  // Get current IST time (UTC+5:30)
  const now = new Date();
  const istOffset = 5 * 60 + 30; // minutes
  const istMs = now.getTime() + istOffset * 60 * 1000;
  const ist = new Date(istMs);

  const currentHHMM = ist.getUTCHours() * 60 + ist.getUTCMinutes();

  const [startH, startM] = quietHours.start.split(":").map(Number);
  const [endH, endM] = quietHours.end.split(":").map(Number);
  const startMin = startH * 60 + startM;
  const endMin = endH * 60 + endM;

  // Handle overnight range (e.g., 01:00 to 07:00)
  if (startMin <= endMin) {
    return currentHHMM >= startMin && currentHHMM < endMin;
  } else {
    // Wraps midnight
    return currentHHMM >= startMin || currentHHMM < endMin;
  }
}
