// src/github.js
// All GitHub API calls: discovery search, watchlist fetch, timeline, comments, repo health.

import { fetchWithRetry, log, sleep } from "./util.js";

const GH_API = "https://api.github.com";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Build Authorization header. Returns empty object if no token.
 */
function authHeader(token) {
  if (!token) return {};
  return { Authorization: `token ${token}` };
}

/**
 * Common headers for every GitHub API call.
 */
function ghHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "issue-watcher/1.0",
    ...authHeader(token),
  };
}

/**
 * Check if we've exhausted rate limits. Returns true if we should stop.
 * @param {Response} res
 */
function isRateLimitExhausted(res) {
  const remaining = res.headers?.get?.("X-RateLimit-Remaining");
  return remaining !== null && parseInt(remaining, 10) < 5;
}

// ---------------------------------------------------------------------------
// Global rate-limit gate (per run)
// ---------------------------------------------------------------------------
let rateLimitHit = false;
let lastSearchTime = 0;
const MIN_SEARCH_DELAY_MS = 2500;

export function resetRateLimitGate() {
  rateLimitHit = false;
  lastSearchTime = 0;
}

export function getRateLimitHit() {
  return rateLimitHit;
}

async function throttleSearch() {
  const now = Date.now();
  const elapsed = now - lastSearchTime;
  if (lastSearchTime > 0 && elapsed < MIN_SEARCH_DELAY_MS) {
    const wait = MIN_SEARCH_DELAY_MS - elapsed;
    await sleep(wait);
  }
}

async function executeSearchFetch(url, token) {
  await throttleSearch();
  try {
    return await fetch(url, {
      headers: ghHeaders(token),
      signal: AbortSignal.timeout(15_000),
    });
  } finally {
    lastSearchTime = Date.now();
  }
}

// ---------------------------------------------------------------------------
// Stage 2a: Discovery search
//
// Builds one query per (language × label) combination.
// Sorts by created desc, per_page=30.
// ---------------------------------------------------------------------------

/**
 * Search for issues matching one (language, label) pair.
 * @returns {Array} raw issues from GitHub
 */
async function searchIssues(language, label, since, token) {
  if (rateLimitHit) return [];

  // Format date for GitHub search (YYYY-MM-DD or full ISO)
  const sinceDate = since.substring(0, 10); // YYYY-MM-DD is fine

  const query = [
    "is:issue",
    "is:open",
    "no:assignee",
    "-linked:pr",
    "comments:0",
    `label:"${label}"`,
    `language:${language}`,
    `created:>${sinceDate}`,
  ].join(" ");

  const params = new URLSearchParams({
    q: query,
    sort: "created",
    order: "desc",
    per_page: "30",
  });

  const url = `${GH_API}/search/issues?${params}`;
  log.info(`Searching: language=${language}, label="${label}", since=${sinceDate}`);

  let res;
  try {
    res = await executeSearchFetch(url, token);
  } catch (err) {
    log.warn(`Search failed for language=${language} label="${label}"`, {
      error: err.message,
    });
    return [];
  }

  // Handle 403 or 429
  if (res.status === 403 || res.status === 429) {
    let errorMsg = "";
    try {
      const errBody = await res.json();
      errorMsg = errBody?.message ?? JSON.stringify(errBody);
    } catch {
      // response wasn't JSON
    }

    if (res.status === 403) {
      log.warn(`Search API returned 403 for language=${language} label="${label}": ${errorMsg}`);
    } else {
      log.warn(`Search API returned 429 for language=${language} label="${label}": ${errorMsg}`);
    }

    // Read Retry-After / X-RateLimit-Reset
    const retryAfter = res.headers.get("Retry-After") || res.headers.get("X-RateLimit-Reset");
    let waitMs = MIN_SEARCH_DELAY_MS;
    if (retryAfter) {
      const val = parseInt(retryAfter, 10);
      if (!isNaN(val)) {
        waitMs = val > 1_000_000_000
          ? (val * 1000 - Date.now())
          : val * 1000;
      }
    }
    if (waitMs < MIN_SEARCH_DELAY_MS) waitMs = MIN_SEARCH_DELAY_MS;
    const waitTime = Math.min(waitMs, 60_000);

    log.info(`Waiting ${waitTime}ms before retrying search (query: language=${language}, label="${label}")`);
    await sleep(waitTime);

    // Retry once
    try {
      res = await executeSearchFetch(url, token);
    } catch (err) {
      log.warn(`Search retry failed for language=${language} label="${label}"`, {
        error: err.message,
      });
      return [];
    }

    if (!res.ok) {
      if (res.status === 403) {
        let retryErrorMsg = "";
        try {
          const errBody = await res.json();
          retryErrorMsg = errBody?.message ?? JSON.stringify(errBody);
        } catch {}
        log.warn(`Search API retry returned 403 for language=${language} label="${label}": ${retryErrorMsg}`);
      } else {
        log.warn(`Search API retry returned ${res.status} for language=${language} label="${label}"`);
      }
      // Give up on that query and continue
      return [];
    }
  }

  if (isRateLimitExhausted(res)) {
    log.warn("GitHub rate limit exhausted during discovery search, stopping further searches");
    rateLimitHit = true;
    return [];
  }

  if (!res.ok) {
    log.warn(`Search API returned ${res.status} for language=${language} label="${label}"`);
    return [];
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    log.warn("Failed to parse search response", { error: err.message });
    return [];
  }

  const items = data.items ?? [];
  log.info(`  → found ${items.length} issues (language=${language}, label="${label}")`);
  return items;
}

/**
 * Run all discovery searches (one per language × label combo).
 * Returns a deduplicated flat list of issues.
 * @param {object} config – the full config object
 * @param {string} since  – ISO timestamp (lastRun)
 */
export async function fetchDiscoveryIssues(config, since) {
  if (!config.discovery?.enabled) {
    log.info("Discovery is disabled (discovery.enabled=false). Skipping all Search API calls.");
    return [];
  }

  const { languages, labels } = config.discovery;
  const token = config.env.ghToken;
  const allIssues = new Map(); // id → issue
  let searchCallCount = 0;

  for (const language of languages) {
    for (const label of labels) {
      if (rateLimitHit) break;
      if (searchCallCount >= 9) {
        // Keep under 10 search calls per run (spec requirement)
        log.warn("Reached 9 discovery search calls limit, stopping further searches");
        break;
      }

      const issues = await searchIssues(language, label, since, token);
      searchCallCount++;
      for (const issue of issues) {
        if (!allIssues.has(issue.id)) {
          allIssues.set(issue.id, issue);
        }
      }
    }
    if (rateLimitHit) break;
  }

  return Array.from(allIssues.values());
}

// ---------------------------------------------------------------------------
// Stage 2b: Watchlist fetch
//
// GET /repos/{owner}/{repo}/issues?state=open&since={lastRun}&sort=created&direction=desc&per_page=30
// Drops PRs (has pull_request field) and assigned issues.
// ---------------------------------------------------------------------------

/**
 * Fetch open issues from a single watchlist repo.
 * @param {string} repoFullName  – "owner/repo"
 * @param {string} since         – ISO timestamp
 * @param {string} token
 * @returns {Array} issues (PRs and assigned already dropped)
 */
async function fetchWatchlistRepo(repoFullName, since, token) {
  if (rateLimitHit) return [];

  const params = new URLSearchParams({
    state: "open",
    since,
    sort: "created",
    direction: "desc",
    per_page: "30",
  });

  const url = `${GH_API}/repos/${repoFullName}/issues?${params}`;
  log.info(`Fetching watchlist repo: ${repoFullName}`);

  let res;
  try {
    res = await fetchWithRetry(
      url,
      { headers: ghHeaders(token) },
      { timeoutMs: 15_000, maxRetries: 2 }
    );
  } catch (err) {
    log.warn(`Watchlist fetch failed for ${repoFullName}`, { error: err.message });
    return [];
  }

  if (isRateLimitExhausted(res)) {
    log.warn("GitHub rate limit exhausted during watchlist fetch, stopping");
    rateLimitHit = true;
    return [];
  }

  if (res.status === 404 || res.status === 403) {
    log.warn(`Watchlist repo ${repoFullName} returned ${res.status}, skipping`);
    return [];
  }

  if (!res.ok) {
    log.warn(`Watchlist repo ${repoFullName} returned ${res.status}, skipping`);
    return [];
  }

  let items;
  try {
    items = await res.json();
  } catch (err) {
    log.warn(`Failed to parse response for ${repoFullName}`, { error: err.message });
    return [];
  }

  if (!Array.isArray(items)) {
    log.warn(`Unexpected response shape for ${repoFullName}`);
    return [];
  }

  // Drop PRs and assigned issues
  const filtered = items.filter((item) => {
    if (item.pull_request) return false; // it's a PR
    if (item.assignee !== null) return false; // already assigned
    item._fromWatchlist = true;
    return true;
  });

  log.info(`  → ${repoFullName}: ${items.length} items, ${filtered.length} issues after dropping PRs/assigned`);
  return filtered;
}

/**
 * Fetch all watchlist repos. Per-repo failures are isolated.
 * @param {object} config
 * @param {string} since – ISO timestamp
 */
export async function fetchWatchlistIssues(config, since) {
  const token = config.env.ghToken;
  const results = [];

  for (const repoFullName of config.watchlist) {
    if (rateLimitHit) break;
    try {
      const issues = await fetchWatchlistRepo(repoFullName, since, token);
      results.push(...issues);
    } catch (err) {
      // Per-repo isolation: one bad repo must not affect others
      log.warn(`Unexpected error for watchlist repo ${repoFullName}, skipping`, {
        error: err.message,
      });
    }
    if (!rateLimitHit) await sleep(100);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Stage 3: Merge + deduplicate by issue id
// ---------------------------------------------------------------------------

/**
 * Merge two lists and deduplicate by issue id.
 */
export function mergeAndDedupe(discoveryIssues, watchlistIssues) {
  const map = new Map();
  for (const issue of watchlistIssues) {
    issue._fromWatchlist = true;
    map.set(issue.id, issue);
  }
  for (const issue of discoveryIssues) {
    if (!map.has(issue.id)) {
      map.set(issue.id, issue);
    }
  }
  return Array.from(map.values());
}

// ---------------------------------------------------------------------------
// Stage 5a: Timeline check
// ---------------------------------------------------------------------------

/**
 * Get the timeline for an issue.
 * Returns null on error (caller treats as "unknown" and skips issue).
 */
export async function getIssueTimeline(owner, repo, number, token) {
  const url = `${GH_API}/repos/${owner}/${repo}/issues/${number}/timeline`;
  try {
    const res = await fetchWithRetry(
      url,
      {
        headers: {
          ...ghHeaders(token),
          Accept: "application/vnd.github.mockingbird-preview+json",
        },
      },
      { timeoutMs: 15_000, maxRetries: 2 }
    );
    if (!res.ok) {
      log.warn(`Timeline API returned ${res.status} for ${owner}/${repo}#${number}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    log.warn(`Timeline fetch failed for ${owner}/${repo}#${number}`, { error: err.message });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Stage 5b: Comment check
// ---------------------------------------------------------------------------

/**
 * Get the first 10 comments for an issue.
 * Returns null on error.
 */
export async function getIssueComments(owner, repo, number, token) {
  const url = `${GH_API}/repos/${owner}/${repo}/issues/${number}/comments?per_page=10`;
  try {
    const res = await fetchWithRetry(
      url,
      { headers: ghHeaders(token) },
      { timeoutMs: 15_000, maxRetries: 2 }
    );
    if (!res.ok) {
      log.warn(`Comments API returned ${res.status} for ${owner}/${repo}#${number}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    log.warn(`Comments fetch failed for ${owner}/${repo}#${number}`, { error: err.message });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Stage 5c: Repo metadata & health check (cached per repo per run)
// Uses GET /repos/{owner}/{repo} (REST API, not Search API)
// ---------------------------------------------------------------------------
const repoCache = new Map();

/**
 * Fetch repository details via GET /repos/{owner}/{repo}.
 * Cached per repo for the run.
 * Returns repo object, { notFound: true } on 404, or null on error.
 */
export async function getRepo(owner, repo, token) {
  const key = `${owner}/${repo}`.toLowerCase();
  if (repoCache.has(key)) return repoCache.get(key);

  const url = `${GH_API}/repos/${owner}/${repo}`;
  try {
    const res = await fetchWithRetry(
      url,
      { headers: ghHeaders(token) },
      { timeoutMs: 15_000, maxRetries: 2 }
    );
    if (res.status === 404) {
      log.warn(`Repo ${owner}/${repo} returned 404 (not found)`);
      const notFoundResult = { notFound: true };
      repoCache.set(key, notFoundResult);
      return notFoundResult;
    }
    if (!res.ok) {
      log.warn(`Repo fetch returned ${res.status} for ${owner}/${repo}`);
      repoCache.set(key, null);
      return null;
    }
    const data = await res.json();
    repoCache.set(key, data);
    return data;
  } catch (err) {
    log.warn(`Repo fetch error for ${owner}/${repo}`, { error: err.message });
    repoCache.set(key, null);
    return null;
  }
}

export function resetRepoCache() {
  repoCache.clear();
}

/**
 * Check if a repo is active based on pushed_at and not archived.
 * Uses GET /repos/{owner}/{repo}.
 */
export async function checkRepoHealth(owner, repo, withinDays, token) {
  const repoData = await getRepo(owner, repo, token);
  if (!repoData || repoData.notFound) return null;
  if (repoData.archived) return false;
  const cutoff = Date.now() - withinDays * 24 * 60 * 60 * 1000;
  const pushedTime = repoData.pushed_at ? new Date(repoData.pushed_at).getTime() : 0;
  return Boolean(pushedTime && pushedTime >= cutoff);
}

/**
 * Reset the in-memory repo cache (useful for testing).
 */
export function resetRepoHealthCache() {
  resetRepoCache();
}
