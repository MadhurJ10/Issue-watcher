// src/scoring.js
// Heuristic scoring (Section 6) and AI scoring with full fallback (Section 7).

import { fetchWithRetry, log, sleep } from "./util.js";

// ---------------------------------------------------------------------------
// Section 6: Heuristic scoring
// ---------------------------------------------------------------------------

const STACK_TRACE_OR_CODE_RE = /```|at\s+\w+[\w.]*\s*\(/;
const FILE_PATH_RE = /[\w/.-]+\.(ts|js|tsx|jsx|json|md)/i;
const MAINTAINER_SUGGESTION_RE = /\b(you could|you can|try|look at|consider|suggestion:|approach:)\b/i;
const INFRA_RE = /\b(aws|gcp|azure|api\s+key|kubernetes)\b/i;
const REFACTOR_RE = /\b(refactor|architecture|redesign|migrate|performance)\b/i;
const PACKAGE_RE = /\b(require|import)\s+['"]?([\w@/-]+)/g;

/**
 * Score an issue using heuristic rules.
 * @param {object} issue – GitHub issue object
 * @returns {{ score: number, reason: string, source: "rules" }}
 */
export function heuristicScore(issue) {
  let score = 3; // baseline
  const signals = [];
  const body = issue.body ?? "";
  const title = issue.title ?? "";
  const labelNames = (issue.labels ?? []).map((l) => (l.name ?? "").toLowerCase());

  // +1: Body contains a stack trace or code block
  if (STACK_TRACE_OR_CODE_RE.test(body)) {
    score += 1;
    signals.push("+stackOrCode");
  }

  // +1: Body mentions a specific file path
  if (FILE_PATH_RE.test(body)) {
    score += 1;
    signals.push("+filePath");
  }

  // +1: Maintainer already commented with a suggested approach
  // We can only check this from issue body comments in the already-fetched data.
  // For cheap scoring, we check if the body itself contains suggestion language
  // (actual comment check is in expensive filters; this is a lightweight heuristic).
  if (MAINTAINER_SUGGESTION_RE.test(body)) {
    score += 1;
    signals.push("+maintainerSuggestion");
  }

  // +1: Label "good first issue"
  if (labelNames.includes("good first issue")) {
    score += 1;
    signals.push("+goodFirstIssue");
  }

  // -1: Body mentions refactor/architecture/etc.
  if (REFACTOR_RE.test(body) || REFACTOR_RE.test(title)) {
    score -= 1;
    signals.push("-refactorScope");
  }

  // -1: Body mentions more than 2 distinct packages/modules
  const pkgMatches = [...body.matchAll(PACKAGE_RE)];
  const uniquePkgs = new Set(pkgMatches.map((m) => m[2]));
  if (uniquePkgs.size > 2) {
    score -= 1;
    signals.push(`-manyPackages:${uniquePkgs.size}`);
  }

  // -1: Body length > 1500 chars
  if (body.length > 1500) {
    score -= 1;
    signals.push(`-longBody:${body.length}`);
  }

  // -1: Needs external credentials/infra
  if (INFRA_RE.test(body) || INFRA_RE.test(title)) {
    score -= 1;
    signals.push("-externalInfra");
  }

  // Clamp to 1-5
  score = Math.max(1, Math.min(5, score));

  // Build reason string (keep short)
  const reason = signals.slice(0, 4).join(", ") || "baseline";

  return { score, reason, source: "rules" };
}

// ---------------------------------------------------------------------------
// Section 7: AI scoring with full fallback
// ---------------------------------------------------------------------------

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const OPENAI_API = "https://api.openai.com/v1/chat/completions";

function buildPrompt(issue) {
  const repo = issue.repository_url?.split("/repos/")[1] ??
    issue.repository?.full_name ?? "unknown";
  const labels = (issue.labels ?? []).map((l) => l.name).join(", ");
  const body = (issue.body ?? "").substring(0, 2000);

  return (
    `You are triaging GitHub issues for a developer with strong JavaScript/TypeScript and Node.js skills\n` +
    `who has about 1-2 days to work on a single issue.\n\n` +
    `Rate how doable this issue is on a scale of 1 to 5:\n` +
    `5 = clear, small, well-scoped, can be done in a few hours\n` +
    `4 = clear and moderate, about a day\n` +
    `3 = somewhat unclear or larger, 1-2 days\n` +
    `2 = vague or large, needs lots of context\n` +
    `1 = too hard, needs design decisions, deep expertise, or huge scope\n\n` +
    `Respond with ONLY a JSON object, no markdown, no extra text:\n` +
    `{"score": <1-5 integer>, "reason": "<max 100 chars>", "files": ["<likely files>"]}\n\n` +
    `---\n` +
    `Repo: ${repo}\n` +
    `Labels: ${labels}\n` +
    `Title: ${issue.title}\n` +
    `Body:\n${body}`
  );
}

/**
 * Build request options for the configured AI provider.
 */
function buildAiRequest(issue, ctx) {
  const prompt = buildPrompt(issue);
  const model = ctx.env.aiModel;
  const provider = ctx.env.aiProvider;

  if (provider === "openai") {
    return {
      url: OPENAI_API,
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 200,
        temperature: 0,
      }),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ctx.env.aiApiKey}`,
      },
    };
  }

  // Default: Anthropic
  return {
    url: ANTHROPIC_API,
    body: JSON.stringify({
      model,
      max_tokens: 200,
      messages: [{ role: "user", content: prompt }],
    }),
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ctx.env.aiApiKey,
      "anthropic-version": "2023-06-01",
    },
  };
}

/**
 * Extract text content from AI response (handles both Anthropic and OpenAI formats).
 */
function extractTextFromResponse(data, provider) {
  if (provider === "openai") {
    return data?.choices?.[0]?.message?.content ?? null;
  }
  // Anthropic
  return data?.content?.[0]?.text ?? null;
}

/**
 * Parse and validate AI response JSON.
 * Strips markdown code fences if present.
 * @throws if invalid
 */
function parseAiResponse(raw) {
  if (!raw) throw new Error("Empty AI response");

  // Strip markdown code fences
  let text = raw.trim();
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`AI response is not valid JSON: ${text.substring(0, 100)}`);
  }

  const score = parsed.score;
  if (!Number.isInteger(score) || score < 1 || score > 5) {
    throw new Error(`AI score out of range or not integer: ${score}`);
  }

  return {
    score,
    reason: String(parsed.reason ?? "").substring(0, 100),
    files: Array.isArray(parsed.files) ? parsed.files : [],
  };
}

/**
 * Determine if a status code is retryable.
 */
function isRetryable(status) {
  return status === 429 || status >= 500;
}

/**
 * Call the AI API with timeout and retry.
 * @throws on any failure (caller catches)
 */
async function aiScore(issue, ctx) {
  const { url, body, headers } = buildAiRequest(issue, ctx);
  const { timeoutMs, maxRetries } = ctx.ai;

  let lastErr;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);

      // Don't retry on 4xx auth/validation errors (401, 403, 400, 422)
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        const errorText = await res.text().catch(() => "");
        throw new Error(`AI API returned ${res.status} (non-retryable): ${errorText.substring(0, 100)}`);
      }

      // Retry on 429 / 5xx
      if (isRetryable(res.status)) {
        lastErr = new Error(`AI API returned ${res.status}`);
        if (attempt < maxRetries) {
          const backoff = (attempt + 1) * 1000;
          log.warn(`AI API ${res.status}, retrying in ${backoff}ms`, { attempt });
          await sleep(backoff);
          continue;
        }
        throw lastErr;
      }

      const data = await res.json();
      const text = extractTextFromResponse(data, ctx.env.aiProvider);
      return parseAiResponse(text);
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;

      // Abort = timeout
      if (err.name === "AbortError") {
        throw new Error(`AI request timed out after ${timeoutMs}ms`);
      }

      // Non-retryable errors (4xx): rethrow immediately
      if (err.message?.includes("non-retryable")) throw err;

      // Network errors: retry
      const isNetwork = err.code === "ECONNRESET" || err.code === "ENOTFOUND";
      if (isNetwork && attempt < maxRetries) {
        const backoff = (attempt + 1) * 1000;
        log.warn(`AI network error, retrying in ${backoff}ms`, { error: err.message, attempt });
        await sleep(backoff);
        continue;
      }

      throw err;
    }
  }

  throw lastErr ?? new Error("AI scoring failed after retries");
}

/**
 * Blend AI and heuristic scores.
 * If AI score is 5 but heuristic is 1 or 2, cap final at 3 (sanity check).
 */
function combine(ai, heuristic) {
  let finalScore = ai.score;
  if (ai.score === 5 && (heuristic.score === 1 || heuristic.score === 2)) {
    finalScore = 3;
    log.info(`AI/heuristic blend: AI=5 but heuristic=${heuristic.score}, capping at 3`);
  }
  return {
    score: finalScore,
    reason: ai.reason,
    files: ai.files,
    source: "AI",
  };
}

// ---------------------------------------------------------------------------
// Public API: scoreIssue (spec Section 7.4)
// ---------------------------------------------------------------------------

/**
 * Score an issue. Uses AI if enabled/circuit-not-open, falls back to heuristic.
 * NEVER throws out of this function.
 *
 * @param {object} issue
 * @param {object} ctx – { ai: { enabled, circuitOpen, consecutiveFailures, maxFailures, ... }, env: { ... } }
 * @returns {{ score: number, reason: string, source: "AI"|"rules" }}
 */
export async function scoreIssue(issue, ctx) {
  const heuristic = heuristicScore(issue); // always computed first, cannot fail

  if (!ctx.ai.enabled || ctx.ai.circuitOpen) {
    return { ...heuristic, source: "rules" };
  }

  try {
    const ai = await aiScore(issue, ctx);
    ctx.ai.consecutiveFailures = 0;
    return combine(ai, heuristic);
  } catch (err) {
    ctx.ai.consecutiveFailures++;
    if (ctx.ai.consecutiveFailures >= ctx.ai.maxFailures) {
      if (!ctx.ai.circuitOpen) {
        ctx.ai.circuitOpen = true;
        ctx.ai.aiUnavailableThisRun = true;
        log.warn(
          `AI circuit breaker opened after ${ctx.ai.consecutiveFailures} consecutive failures. ` +
            "Using rule-based scores for the rest of this run."
        );
      }
    }
    log.warn("AI scoring failed, using rules", {
      issue: issue.html_url,
      error: err.message,
    });
    ctx.ai.aiUnavailableThisRun = true;
    return { ...heuristic, source: "rules" };
  }
}
