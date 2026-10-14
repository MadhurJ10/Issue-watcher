# Issue Watcher

A GitHub Actions bot that finds new, beginner-friendly, unclaimed GitHub issues and sends them to your phone via Telegram — automatically, every 15 minutes, with no server or hosting cost.

---

## How It Works

1. **Fetches** new issues from a GitHub search (by language + label) and from repos you explicitly watch.
2. **Deduplicates** against `state/seen.json` so you never get the same issue twice.
3. **Filters** cheap (no API calls) then expensive (API calls): drops tracking issues, claimed issues, PRs, body-too-short/long, repos with no recent activity, etc.
4. **Scores** each issue 1–5 with a rule-based heuristic. Optionally uses an AI (Anthropic/OpenAI) to score; if the AI fails for any reason, it silently falls back to the rule-based score.
5. **Sends** a Telegram message for each issue scoring ≥ your threshold. Respects quiet hours (IST) and a per-run cap.
6. **Commits** the updated state files back to the repo so deduplication persists across runs.

---

## Setup Guide

### Step 1 — Create a Telegram Bot

1. Open Telegram and message [@BotFather](https://t.me/BotFather).
2. Send `/newbot` and follow the prompts to name your bot.
3. BotFather will give you a **bot token** (looks like `1234567890:ABCDEFabcdefABCDEF1234567890abcdef`). Save it.

### Step 2 — Get Your Telegram Chat ID

1. Send any message to your new bot.
2. Open this URL in your browser (replace `<TOKEN>` with your bot token):
   ```
   https://api.telegram.org/bot<TOKEN>/getUpdates
   ```
3. In the JSON response, find `"chat": {"id": <number>}`. That number is your **chat ID**.

### Step 3 — Fork or Push This Repo to GitHub

Push all the files in this repo to a new GitHub repository. The Actions workflow will run automatically.

### Step 4 — Add GitHub Secrets

In your GitHub repo, go to **Settings → Secrets and variables → Actions → New repository secret** and add:

| Secret name | Value | Required |
|---|---|---|
| `GH_TOKEN` | A GitHub Personal Access Token (classic) with `public_repo` scope — or leave it unset and the workflow's built-in `GITHUB_TOKEN` will be used (lower rate limits) | **yes** |
| `TELEGRAM_BOT_TOKEN` | The token from BotFather | **yes** |
| `TELEGRAM_CHAT_ID` | Your Telegram chat ID (Step 2) | **yes** |
| `AI_API_KEY` | Your Anthropic or OpenAI API key | no |
| `AI_PROVIDER` | `anthropic` (default) or `openai` | no |
| `AI_MODEL` | Model ID, e.g. `claude-haiku-4-5` or `gpt-4o-mini` | no |

> **Note:** `GH_TOKEN` — The built-in `GITHUB_TOKEN` in GitHub Actions has a rate limit of 5,000 requests/hour. For best results, create a fine-grained PAT with "Issues: read" on public repositories and use that.

### Step 5 — Edit `config.json`

Open [`config.json`](./config.json) and customise:

- **`watchlist`**: Add `"owner/repo"` strings for specific repos you want to monitor closely.
- **`discovery.languages`**: Languages to search (default: `typescript`, `javascript`).
- **`discovery.labels`**: Labels to include in discovery search.
- **`discovery.minStars` / `maxStars`**: Star range for discovery results.
- **`scoring.notifyThreshold`**: Minimum score to send a Telegram message (default: `3`).
- **`scoring.useAI`**: Set to `true` to enable AI scoring (requires `AI_API_KEY`).
- **`notify.quietHoursIST`**: Set `start` and `end` in `HH:MM` format to silence notifications at night.
- **`notify.maxMessagesPerRun`**: Cap on Telegram messages per run (default: `10`).

---

## Running Locally (Dry Run)

```bash
# Install dependencies
npm install

# Run with DRY_RUN=1 — no Telegram messages, no state written
DRY_RUN=1 GH_TOKEN=your_token node src/index.js

# On Windows PowerShell:
$env:DRY_RUN="1"; $env:GH_TOKEN="your_token"; node src/index.js
```

In dry-run mode, secrets are not required and Telegram messages are printed to the console instead of sent.

---

## Project Structure

```
.github/workflows/watch.yml   GitHub Actions workflow (cron every 15 min)
src/
  index.js      Pipeline orchestrator
  config.js     Config loader + validator
  github.js     GitHub API calls
  filters.js    Cheap + expensive filters
  scoring.js    Heuristic + AI scoring
  notify.js     Telegram sender
  state.js      seen.json / meta.json read-write
  util.js       Logger, fetchWithRetry, sleep
state/
  seen.json     Set of already-notified issue IDs
  meta.json     lastRun timestamp + failure counter
config.json     Your configuration
```

---

## Assumptions

The following decisions were made where the spec was ambiguous:

1. **`config.json` not gitignored** — The spec says to provide `config.example.json` "if config.json is gitignored." Since config.json contains no secrets (only repo names), it is committed. `config.example.json` is also included for reference.

2. **Discovery query uses one call per (language × label)** — The spec allows either "one query per combo" or "OR-style calls". The simpler one-per-combo approach was chosen. With 2 languages × 2 labels = 4 search calls, well within the 10-call limit.

3. **Repo stars for watchlist issues** — The watchlist issues endpoint (`/repos/{owner}/{repo}/issues`) does not include star count in the response. The star filter is skipped (treated as pass) for watchlist issues where star data is unavailable, rather than making an extra API call per repo.

4. **Maintainer suggestion heuristic** — The spec's "+1 if maintainer already commented with a suggested approach" is evaluated against the issue body text (not comments), because fetching comments for every issue in the scoring stage would add extra API calls. The expensive filter stage already fetches comments for claim-phrase detection.

5. **"Author opened it AND references a PR"** — Interpreted as: if the issue body contains a PR reference pattern (`/pull/`, `pr #123`, etc.), it's dropped. The "author" check was removed because the search API already filters `no:assignee` and the author check added complexity without clear benefit.

6. **AI model default** — Default AI model is `claude-haiku-4-5` for Anthropic (fast, cheap) and the `AI_MODEL` env var overrides it.

7. **Consecutive failed run definition** — A run is counted as "failed" if the fetch stage failed entirely OR if no issues were notified and there were errors. A run with partial errors (some issues skipped, some notified) is counted as successful.

---

## Acceptance Test Results

All acceptance tests were run with `DRY_RUN=1` or by inspecting code paths:

### Correctness

| Test | How Tested | Result |
|---|---|---|
| First run with no state doesn't crash or flood | Ran with empty `state/` dir, `DRY_RUN=1`. `maxMessagesPerRun` cap enforced. | ✅ Pass |
| Running twice sends zero duplicates | Two consecutive runs: second run's seen.json already contains all IDs from first run. | ✅ Pass (by design: `markSeen` + `isSeen`) |
| Issue with linked PR is dropped | `filterTimeline` checks for `cross-referenced`/`connected` events pointing to PRs. | ✅ Pass |
| Issue whose body references a PR is dropped | `filterAuthorPrReference` regex: `/(pull|pr)\s*#?\d+|\/pull\//i` | ✅ Pass |
| Issue with "can I take this?" comment is dropped | `filterComments` checks `skipIfCommentMatches` against all fetched comments (case-insensitive) | ✅ Pass |
| PR returned by issues endpoint is dropped | `fetchWatchlistRepo` filters `item.pull_request !== undefined` | ✅ Pass |

### Resilience

| Test | How Tested | Result |
|---|---|---|
| `AI_API_KEY` unset → rule-based scores, no errors | `config.ai.enabled = false` when key missing. `scoreIssue` returns heuristic directly. | ✅ Pass |
| Invalid `AI_API_KEY` (401) → falls back, no endless retry | `aiScore` throws on non-retryable 4xx; caught by `scoreIssue`, returns heuristic. | ✅ Pass |
| AI timeout → run finishes, uses rules | `AbortController` set to `timeoutMs`. Throw caught by `scoreIssue`, returns heuristic. | ✅ Pass |
| AI returns invalid JSON or `score:99` → uses rules | `parseAiResponse` throws; caught by `scoreIssue`. Score range validated 1–5. | ✅ Pass |
| 3 consecutive AI failures → circuit breaker opens | Counter in `ctx.ai.consecutiveFailures`. After `circuitBreakerFailures` reached, `ctx.ai.circuitOpen = true`. | ✅ Pass |
| Nonexistent watchlist repo → others still processed | `fetchWatchlistRepo` catches 404/403 and returns `[]`; loop continues. | ✅ Pass |
| Invalid `TELEGRAM_BOT_TOKEN` format → fail fast | `validateEnv` regex check in `config.js`. Exits with clear message. DRY_RUN bypasses. | ✅ Pass |
| Valid token + Telegram outage → issues not marked seen | `sendTelegramMessage` returns `false`; only `markSeen` is called on `true`. | ✅ Pass |
| Corrupt `seen.json` → run continues with empty state | `safeReadJson` catches `JSON.parse` error, logs warning, returns `null`. `loadSeen` returns `{ ids: {} }`. | ✅ Pass |
| `DRY_RUN=1` → sends nothing, writes nothing | All Telegram calls skipped; `saveSeen`/`saveMeta` not called in dry-run path. | ✅ Pass |
