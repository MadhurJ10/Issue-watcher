# Issue Watcher: Build Spec

> **Instructions for the AI agent:** Implement this project exactly as specified. Build in the order given in "Build Order". After each phase, run it in `DRY_RUN=1` mode and confirm it works before moving on. Do not add features that are not listed here. If something is ambiguous, pick the simplest option and note the assumption in `README.md`.

---

## 1. Goal

A small automated pipeline that finds **new, beginner-to-intermediate-friendly, unclaimed GitHub issues** and sends them to my phone via Telegram, so I do not have to check repos manually.

It runs on a schedule via **GitHub Actions** (no server, no hosting cost).

### Core requirements

1. Detect only **new** issues (never re-notify old ones).
2. Skip issues that already have a PR linked, were raised together with a PR, or have been claimed.
3. Filter out issues that look too hard.
4. Optionally use an **AI model to score difficulty**.
5. **The AI step must never break the pipeline.** If it fails for any reason, the pipeline falls back to a rule-based score and continues. See Section 7.
6. A failure in one repo, one issue, or one stage must never stop the whole run.

### Non-goals (do not build)

- No web UI, database, or server.
- No auto-commenting or auto-claiming issues.
- No support for platforms other than GitHub and Telegram.

---

## 2. Tech Stack

- **Runtime:** Node.js 20+ (ESM, `"type": "module"`)
- **Dependencies:** keep to a minimum. Use built-in `fetch`. No axios. No heavy frameworks.
- **Scheduler:** GitHub Actions cron
- **Notification:** Telegram Bot API
- **State:** JSON files committed back to the repo
- **Optional AI:** any LLM HTTP API, provider chosen by env vars (see Section 7)

---

## 3. Project Structure

```
issue-watcher/
├── .github/
│   └── workflows/
│       └── watch.yml
├── src/
│   ├── index.js          # orchestrator, runs the pipeline
│   ├── config.js         # loads + validates config.json and env
│   ├── github.js         # all GitHub API calls (search, timeline, repo health)
│   ├── filters.js        # cheap + expensive filter functions
│   ├── scoring.js        # heuristic score + AI score + fallback logic
│   ├── notify.js         # Telegram sender
│   ├── state.js          # read/write seen.json and lastRun
│   └── util.js           # fetchWithRetry, withTimeout, logger, sleep
├── state/
│   ├── seen.json         # { "ids": { "<issueId>": "<isoTimestamp>" } }
│   └── meta.json         # { "lastRun": "<isoTimestamp>" }
├── config.json
├── package.json
├── .gitignore
└── README.md
```

---

## 4. Configuration

### 4.1 `config.json`

```json
{
  "discovery": {
    "languages": ["typescript", "javascript"],
    "labels": ["good first issue", "help wanted"],
    "excludeLabels": ["needs-design", "discussion", "rfc", "epic", "breaking-change", "wontfix", "duplicate"],
    "minStars": 300,
    "maxStars": 30000,
    "maxResultsPerRun": 50
  },
  "watchlist": [
    "owner/repo-one",
    "owner/repo-two"
  ],
  "filters": {
    "maxBodyChars": 2500,
    "minBodyChars": 80,
    "maxIssueAgeHours": 72,
    "repoMustHaveMergedPrWithinDays": 30,
    "skipIfCommentMatches": ["can i take", "i'd like to work", "i would like to work", "working on this", "assign me", "assigned to me", "i'll take", "i will take", "picking this up"]
  },
  "scoring": {
    "notifyThreshold": 3,
    "useAI": true,
    "ai": {
      "timeoutMs": 15000,
      "maxRetries": 1,
      "maxIssuesPerRun": 10,
      "circuitBreakerFailures": 3
    }
  },
  "notify": {
    "quietHoursIST": { "start": "01:00", "end": "07:00" },
    "maxMessagesPerRun": 10
  }
}
```

Validate this file on startup. If invalid, log a clear error and exit with a non-zero code (this is the **only** case where the run should hard-fail).

### 4.2 Environment variables (GitHub Actions secrets)

| Variable | Required | Purpose |
|---|---|---|
| `GH_TOKEN` | yes | GitHub PAT (public repo read access) or the built-in `GITHUB_TOKEN` |
| `TELEGRAM_BOT_TOKEN` | yes | From @BotFather |
| `TELEGRAM_CHAT_ID` | yes | My chat ID |
| `AI_API_KEY` | no | If missing, AI scoring is silently disabled |
| `AI_PROVIDER` | no | `anthropic` (default) or `openai` |
| `AI_MODEL` | no | Model id, example `claude-haiku-5-5` |
| `DRY_RUN` | no | If `1`: do not send Telegram messages, do not write state, print what would happen |

Never hardcode secrets. Never log secret values.

---

## 5. Pipeline

Run these stages in order. Each stage is isolated (see Section 8).

```
1. LOAD STATE        -> seen.json, meta.json
2. FETCH             -> discovery search + watchlist repos
3. DEDUPE            -> drop already-seen issue IDs
4. CHEAP FILTERS     -> no extra API calls
5. EXPENSIVE FILTERS -> extra API calls, only on survivors
6. SCORE             -> AI score with heuristic fallback
7. NOTIFY            -> Telegram
8. SAVE STATE        -> only for issues successfully handled
```

### Stage 2: Fetch

**Discovery query** (GitHub Search API: `GET /search/issues`):

```
is:issue is:open no:assignee -linked:pr comments:0
label:"good first issue" language:typescript
created:>{lastRun}
```

- Build one query per (language x label) combination, or use OR-style separate calls. Keep total search calls per run under 10 (Search API limit is 30 requests/min).
- Sort by `created`, order `desc`, `per_page=30`.
- Use `lastRun` from `meta.json`. If missing (first run), use "now minus 24 hours".
- Always use `created`, **not** `updated`, so old issues do not resurface on new comments.

**Watchlist:** for each repo in `watchlist`, call `GET /repos/{owner}/{repo}/issues?state=open&since={lastRun}&sort=created&direction=desc&per_page=30`.
- The issues endpoint also returns PRs. **Drop any item that has a `pull_request` field.**
- Drop items where `assignee` is not null.

Merge both sources into one list. Remove duplicates by issue `id`.

### Stage 3: Dedupe

Drop any issue whose `id` exists in `seen.json`.

### Stage 4: Cheap filters (no extra API calls, use only data already fetched)

Each filter is a standalone function: `(issue, ctx) => { pass: boolean, reason: string }`. Log the reason when dropped.

1. Has any label in `excludeLabels` -> drop.
2. Body length > `maxBodyChars` or < `minBodyChars` -> drop.
3. Issue age > `maxIssueAgeHours` -> drop.
4. Title or body suggests a tracking issue or mega-task (regex: `tracking issue`, `roadmap`, `umbrella`, 8 or more checklist items `- [ ]`) -> drop.
5. Repo stars outside `minStars` to `maxStars` -> drop (use repo data from the search result or watchlist call).
6. Author opened the issue **and** it references a PR in the body (`/(pull|pr)\s*#?\d+/i` or a `/pull/` URL) -> drop (issue raised together with a PR).

### Stage 5: Expensive filters (extra API calls, survivors only)

1. **Timeline check:** `GET /repos/{owner}/{repo}/issues/{number}/timeline`. If any event is `cross-referenced` where the source is a PR, or `connected`/`referenced` by a PR -> drop.
2. **Comment check:** `GET /repos/{owner}/{repo}/issues/{number}/comments?per_page=10`. If any comment matches `skipIfCommentMatches` (case-insensitive) -> drop.
3. **Repo health** (cache per repo for the duration of the run): the repo must have at least one merged PR within `repoMustHaveMergedPrWithinDays`. Use `GET /search/issues?q=repo:{owner}/{repo} is:pr is:merged merged:>{date}&per_page=1`. If none -> drop.

Order filters from cheapest to most expensive. Cache repo health results in memory so each repo is checked at most once per run.

### Stage 6: Score

See Section 7.

### Stage 7: Notify

Message format (plain text or Telegram HTML, escape special characters correctly):

```
{emoji} {owner}/{repo}  ⭐ {stars}k
{title}
Score {score}/5 · {source: AI | rules}
{reason, one line}
{url}
```

- Emoji: 🟢 score 4-5, 🟡 score 3.
- Only notify when `score >= notifyThreshold`.
- Respect `quietHoursIST`: during quiet hours, **do not drop** issues. Skip sending and **do not mark them as seen**, so they get sent on the first run after quiet hours.
- Cap at `maxMessagesPerRun`. Anything over the cap stays unseen for the next run.
- Sort by score descending before sending.

### Stage 8: Save state

- Add an issue ID to `seen.json` **only if** it was either (a) notified successfully, or (b) deliberately filtered out by a filter rule.
- **Do not** add it if Telegram sending failed or it was held back by quiet hours or the message cap. It must be retried next run.
- Update `lastRun` in `meta.json` **only if** the fetch stage completed successfully. If fetch fully failed, keep the old `lastRun` so no window of issues is lost.
- Prune `seen.json`: remove entries older than 30 days to keep the file small.

---

## 6. Heuristic scoring (the rule-based fallback)

This must work with **zero external services**. Score is an integer 1-5, starting at 3.

| Signal | Change |
|---|---|
| Body contains a stack trace or code block | +1 |
| Body mentions a specific file path (regex `[\w/.-]+\.(ts|js|tsx|jsx|json|md)`) | +1 |
| Maintainer already commented with a suggested approach | +1 |
| Label `good first issue` | +1 |
| Body mentions "refactor", "architecture", "redesign", "migrate", "performance" | -1 |
| Body mentions more than 2 distinct packages or modules | -1 |
| Body length > 1500 chars | -1 |
| Needs external credentials/infra (regex: `aws`, `gcp`, `azure`, `api key`, `kubernetes`) | -1 |

Clamp to 1-5. Produce a short `reason` string listing the top signals that fired.

---

## 7. AI scoring with guaranteed fallback

### 7.1 Behavior

For each issue that survives filters (up to `ai.maxIssuesPerRun`), try to get an AI difficulty score. **If anything goes wrong, use the heuristic score from Section 6 and continue.**

### 7.2 AI call spec

Send the issue title, the first ~2000 chars of body, repo name, and labels. Prompt:

```
You are triaging GitHub issues for a developer with strong JavaScript/TypeScript and Node.js skills
who has about 1-2 days to work on a single issue.

Rate how doable this issue is on a scale of 1 to 5:
5 = clear, small, well-scoped, can be done in a few hours
4 = clear and moderate, about a day
3 = somewhat unclear or larger, 1-2 days
2 = vague or large, needs lots of context
1 = too hard, needs design decisions, deep expertise, or huge scope

Respond with ONLY a JSON object, no markdown, no extra text:
{"score": <1-5 integer>, "reason": "<max 100 chars>", "files": ["<likely files>"]}
```

### 7.3 Failure handling (this is mandatory)

Implement all of the following:

1. **Wrap the entire AI call in try/catch.** It must never throw out of `scoring.js`.
2. **Timeout:** abort the request after `ai.timeoutMs` using `AbortController`.
3. **Retry:** at most `ai.maxRetries` retries, only on network errors, 429, and 5xx. Use short backoff (1s, 2s). Do **not** retry on 4xx auth/validation errors.
4. **Response validation:** strip markdown code fences if present, `JSON.parse` in try/catch, then check that `score` is an integer from 1 to 5. If invalid, treat as failure.
5. **Circuit breaker:** keep a counter of consecutive AI failures within the run. After `ai.circuitBreakerFailures` consecutive failures, **stop calling the AI for the rest of the run** and use heuristic scores directly. Log this once.
6. **Missing key or `useAI: false`:** skip AI entirely, with no error, using heuristic scores.
7. **Fallback result:** on any failure, return `{ score: heuristicScore, reason: heuristicReason, source: "rules" }`.
8. **Mark the source** in every result (`"AI"` or `"rules"`) and show it in the Telegram message, so I know which one produced the score.
9. **Blend rule (optional but recommended):** if AI succeeds, final score = AI score. But if the AI score is 5 and the heuristic is 1 or 2, cap the final at 3 as a sanity check.
10. If the AI is down for the whole run, add one line at the end of the **last** Telegram message of that run: `⚠️ AI scoring unavailable this run, used rule-based scores.` Send this at most once per run, never as its own message.

### 7.4 Required function shape

```js
// scoring.js
export async function scoreIssue(issue, ctx) {
  const heuristic = heuristicScore(issue);          // always computed first, cannot fail
  if (!ctx.ai.enabled || ctx.ai.circuitOpen) return { ...heuristic, source: "rules" };
  try {
    const ai = await aiScore(issue, ctx);           // may throw
    ctx.ai.consecutiveFailures = 0;
    return combine(ai, heuristic);
  } catch (err) {
    ctx.ai.consecutiveFailures++;
    if (ctx.ai.consecutiveFailures >= ctx.ai.maxFailures) ctx.ai.circuitOpen = true;
    log.warn("AI scoring failed, using rules", { issue: issue.html_url, error: err.message });
    return { ...heuristic, source: "rules" };
  }
}
```

---

## 8. Error handling and resilience (applies to the whole project)

The guiding rule: **one failure must never kill the run.**

1. **Per-item isolation:** process each issue inside its own try/catch. If one issue throws, log it, skip it, and continue with the next.
2. **Per-repo isolation:** one failing watchlist repo (404, 403, timeout) must not affect other repos.
3. **Per-stage isolation:** if an expensive filter call fails (for example the timeline API errors), **do not drop and do not notify blindly**: treat it as "unknown", skip that issue for this run, do **not** mark it seen, and it will be retried next run.
4. **`fetchWithRetry` in `util.js`:**
   - Timeout on every request (default 15s).
   - Retry up to 2 times on network errors, 5xx, and 429.
   - Respect `Retry-After` and `X-RateLimit-Reset` headers. If rate-limited and the wait is over 60s, stop making that type of call for the run and continue with what you have.
   - Never retry on other 4xx.
5. **GitHub rate limits:** read `X-RateLimit-Remaining`. If below 5, stop making further GitHub calls, process what was already fetched, and exit normally.
6. **Telegram failures:** retry sending 2 times. If it still fails, do **not** mark that issue as seen. Continue with the next message. Respect Telegram's 429 `retry_after`.
7. **State file safety:** write `seen.json` and `meta.json` atomically (write to a temp file, then rename). If a state file is missing or corrupt JSON, log a warning, start with empty state, and continue. Do not crash.
8. **Exit codes:** exit `0` for every run that completed, even with partial failures. Exit non-zero **only** for config validation errors or missing required secrets (`GH_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`).
9. **Unhandled errors:** register `process.on("unhandledRejection")` and `process.on("uncaughtException")` handlers that log the error, still try to save state for already-completed work, and exit cleanly.
10. **Run summary log** at the end of every run:

```
Run summary: fetched=42 deduped=30 dropped=22 (reasons: hasPR=8, tooLong=6, claimed=4, ...)
scored=8 (AI=6, rules=2) notified=5 errors=1
```

11. **Failure alert (optional, build last):** if the run had 3 or more consecutive fully-failed runs (tracked in `meta.json` as `consecutiveFailedRuns`), send a single Telegram message: `⚠️ Issue watcher has failed 3 runs in a row, check the Actions logs.` Reset the counter after a successful run.

---

## 9. Logging

- Simple logger in `util.js` with levels `info`, `warn`, `error`.
- Always log **why** an issue was dropped, in the format `dropped owner/repo#123: <reason>`.
- Never log tokens or full API response bodies.

---

## 10. GitHub Actions workflow (`.github/workflows/watch.yml`)

Requirements:

- Triggers: `schedule` (cron `*/15 * * * *`) and `workflow_dispatch` (manual run).
- `permissions: contents: write` (needed to commit state back).
- `concurrency: { group: issue-watcher, cancel-in-progress: false }` so two runs never overlap.
- Steps:
  1. `actions/checkout`
  2. `actions/setup-node` (Node 20, with npm cache)
  3. `npm ci`
  4. `node src/index.js` with secrets passed as env
  5. Commit and push `state/` if changed, with commit message `chore: update state [skip ci]`. Only commit when there is an actual diff. Use `git pull --rebase` before push to avoid conflicts.
- `timeout-minutes: 5` on the job.
- The commit step must run even if the Node step had a partial failure (`if: always()`), but not if secrets were missing.

---

## 11. Build Order

Do these in sequence. After each phase, test with `DRY_RUN=1`.

1. **Phase 1:** scaffolding, `config.js`, `util.js` (logger, fetchWithRetry, timeout), `state.js`.
2. **Phase 2:** `github.js` fetch (discovery + watchlist) and dedupe. Print fetched issues in dry run.
3. **Phase 3:** cheap filters, then expensive filters, with drop-reason logging.
4. **Phase 4:** heuristic scoring only. Notify via Telegram with `source: rules`.
5. **Phase 5:** GitHub Actions workflow and state commit-back.
6. **Phase 6:** AI scoring with all of Section 7.3. **Test the fallback explicitly** (see Section 12).
7. **Phase 7:** quiet hours, message cap, failure alert, README.

---

## 12. Acceptance tests

The agent must verify each of these and describe how it tested them in `README.md`.

**Correctness**
- [ ] First run with no state does not crash and does not flood more than `maxMessagesPerRun`.
- [ ] Running twice in a row sends **zero** duplicate notifications.
- [ ] An issue with a linked PR is dropped.
- [ ] An issue whose body references a PR by its author is dropped.
- [ ] An issue with a comment like "can I take this?" is dropped.
- [ ] A PR returned by the issues endpoint (has `pull_request` field) is dropped.

**Resilience**
- [ ] With `AI_API_KEY` unset, the pipeline runs and sends rule-based scores, no errors.
- [ ] With an **invalid** `AI_API_KEY` (401), the pipeline runs, falls back to rules, and does not retry endlessly.
- [ ] With the AI endpoint timing out, the run finishes and uses rules.
- [ ] With the AI returning invalid JSON or `score: 99`, the run uses rules for that issue.
- [ ] After 3 consecutive AI failures, the AI is no longer called for the rest of that run (circuit breaker).
- [ ] With one watchlist repo set to a nonexistent name, the other repos are still processed.
- [ ] With an invalid `TELEGRAM_BOT_TOKEN` format check, the run fails fast with a clear message. With a valid token but a Telegram outage, issues are **not** marked seen.
- [ ] A corrupt `seen.json` does not crash the run.
- [ ] `DRY_RUN=1` sends nothing and writes nothing.

---

## 13. Deliverables

1. All files in the structure from Section 3.
2. `README.md` with: setup steps (creating the Telegram bot, getting the chat ID, adding secrets), how to edit `config.json`, how to run locally in dry-run mode, and notes on any assumptions made.
3. A `config.example.json` if `config.json` is gitignored.
