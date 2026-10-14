// src/filters.js
// Cheap filters (no extra API calls) and expensive filters (extra API calls).
// Each filter returns { pass: boolean, reason: string }.

import { getIssueTimeline, getIssueComments, getRepo } from "./github.js";
import { log } from "./util.js";

// ---------------------------------------------------------------------------
// Helper: extract owner/repo from issue
// ---------------------------------------------------------------------------
export function parseRepo(issue) {
  // From search API: issue.repository_url = "https://api.github.com/repos/owner/repo"
  if (issue.repository_url) {
    const parts = issue.repository_url.split("/repos/");
    if (parts[1]) {
      const [owner, repo] = parts[1].split("/");
      return { owner, repo };
    }
  }
  // From watchlist API: issue.repository?.full_name = "owner/repo"
  if (issue.repository?.full_name) {
    const [owner, repo] = issue.repository.full_name.split("/");
    return { owner, repo };
  }
  // Fallback: parse from html_url
  // https://github.com/owner/repo/issues/123
  if (issue.html_url) {
    const m = issue.html_url.match(/github\.com\/([^/]+)\/([^/]+)\/issues/);
    if (m) return { owner: m[1], repo: m[2] };
  }
  return { owner: "unknown", repo: "unknown" };
}

// ---------------------------------------------------------------------------
// Helper: check if issue belongs to a watchlist repository
// ---------------------------------------------------------------------------
export function isWatchlistRepo(issue, config) {
  if (issue._fromWatchlist) return true;
  const { owner, repo } = parseRepo(issue);
  if (!owner || !repo || owner === "unknown") return false;
  const fullName = `${owner}/${repo}`.toLowerCase();
  const watchlist = (config.watchlist ?? []).map((w) => w.toLowerCase());
  return watchlist.includes(fullName);
}

// ---------------------------------------------------------------------------
// Repo stars helper: get star count from issue data
// ---------------------------------------------------------------------------
function getStars(issue) {
  // Search API includes repository object in some variants,
  // but usually it's in issue.repository.stargazers_count (watchlist)
  // or issue.repository_stargazers_count. Try all known paths.
  return (
    issue.repository?.stargazers_count ??
    issue.stargazers_count ??
    null
  );
}

// ---------------------------------------------------------------------------
// Cheap Filter 1: Exclude labels
// ---------------------------------------------------------------------------
export function filterExcludeLabels(issue, config) {
  const excludeSet = new Set(config.discovery.excludeLabels.map((l) => l.toLowerCase()));
  const issueLabels = (issue.labels ?? []).map((l) => (l.name ?? "").toLowerCase());
  const found = issueLabels.find((l) => excludeSet.has(l));
  if (found) {
    return { pass: false, reason: `excludeLabel:${found}` };
  }
  return { pass: true, reason: "" };
}

// ---------------------------------------------------------------------------
// Cheap Filter 2: Body length
// ---------------------------------------------------------------------------
export function filterBodyLength(issue, config) {
  const bodyLen = (issue.body ?? "").length;
  if (bodyLen > config.filters.maxBodyChars) {
    return { pass: false, reason: `bodyTooLong:${bodyLen}>${config.filters.maxBodyChars}` };
  }
  if (bodyLen < config.filters.minBodyChars) {
    return { pass: false, reason: `bodyTooShort:${bodyLen}<${config.filters.minBodyChars}` };
  }
  return { pass: true, reason: "" };
}

// ---------------------------------------------------------------------------
// Cheap Filter 3: Issue age
// ---------------------------------------------------------------------------
export function filterIssueAge(issue, config) {
  const createdAt = new Date(issue.created_at).getTime();
  const ageHours = (Date.now() - createdAt) / (1000 * 60 * 60);
  if (ageHours > config.filters.maxIssueAgeHours) {
    return { pass: false, reason: `tooOld:${Math.round(ageHours)}h>${config.filters.maxIssueAgeHours}h` };
  }
  return { pass: true, reason: "" };
}

// ---------------------------------------------------------------------------
// Cheap Filter 4: Tracking issues / mega-tasks
// ---------------------------------------------------------------------------
const TRACKING_TITLE_RE = /tracking\s*issue|roadmap|umbrella/i;
const CHECKLIST_RE = /- \[ \]/g;

export function filterTrackingIssue(issue) {
  const title = issue.title ?? "";
  const body = issue.body ?? "";

  if (TRACKING_TITLE_RE.test(title) || TRACKING_TITLE_RE.test(body)) {
    return { pass: false, reason: "trackingIssue" };
  }

  const checklistMatches = body.match(CHECKLIST_RE);
  if (checklistMatches && checklistMatches.length >= 8) {
    return { pass: false, reason: `megaTask:${checklistMatches.length}checkboxes` };
  }

  return { pass: true, reason: "" };
}

// ---------------------------------------------------------------------------
// Cheap Filter 5: Repo stars range
// ---------------------------------------------------------------------------
export function filterRepoStars(issue, config) {
  // Requirement 4: Skip star filter for watchlist repos
  if (isWatchlistRepo(issue, config)) {
    return { pass: true, reason: "" };
  }

  const stars = getStars(issue);
  if (stars === null) {
    // Can't determine stars — allow through (will be evaluated in expensive repo filter)
    return { pass: true, reason: "" };
  }
  if (stars < config.discovery.minStars) {
    return { pass: false, reason: `tooFewStars:${stars}<${config.discovery.minStars}` };
  }
  if (stars > config.discovery.maxStars) {
    return { pass: false, reason: `tooManyStars:${stars}>${config.discovery.maxStars}` };
  }
  return { pass: true, reason: "" };
}

// ---------------------------------------------------------------------------
// Cheap Filter 6: Author opened issue AND body references a PR
// ---------------------------------------------------------------------------
const PR_BODY_RE = /(pull|pr)\s*#?\d+|\/pull\//i;

export function filterAuthorPrReference(issue) {
  const body = issue.body ?? "";
  const authorLogin = issue.user?.login ?? "";
  // Check if the author of the issue is also the author of any linked PR reference
  // The spec says: author opened it AND body references a PR.
  if (!authorLogin) return { pass: true, reason: "" };

  if (PR_BODY_RE.test(body)) {
    // We consider this as "raised together with a PR"
    return { pass: false, reason: "authorLinkedPR" };
  }
  return { pass: true, reason: "" };
}

// ---------------------------------------------------------------------------
// Run all cheap filters
// Returns { passed: boolean, reason: string }
// ---------------------------------------------------------------------------
export function runCheapFilters(issue, config) {
  const filters = [
    () => filterExcludeLabels(issue, config),
    () => filterBodyLength(issue, config),
    () => filterIssueAge(issue, config),
    () => filterTrackingIssue(issue),
    () => filterRepoStars(issue, config),
    () => filterAuthorPrReference(issue),
  ];

  for (const f of filters) {
    try {
      const result = f();
      if (!result.pass) return result;
    } catch (err) {
      log.warn("Cheap filter threw unexpectedly, treating as pass", { error: err.message });
    }
  }

  return { pass: true, reason: "" };
}

// ---------------------------------------------------------------------------
// Expensive Filter 1: Timeline – check for cross-referenced/connected PRs
// ---------------------------------------------------------------------------
async function filterTimeline(issue, config) {
  const { owner, repo } = parseRepo(issue);
  const timeline = await getIssueTimeline(owner, repo, issue.number, config.env.ghToken);

  if (timeline === null) {
    // Error occurred – per spec: treat as unknown, skip this issue for this run
    return { pass: null, reason: "timelineError" };
  }

  if (!Array.isArray(timeline)) {
    return { pass: null, reason: "timelineInvalidShape" };
  }

  for (const event of timeline) {
    const eventType = event.event ?? "";
    if (
      eventType === "cross-referenced" ||
      eventType === "connected" ||
      eventType === "referenced"
    ) {
      // Check if the source is a pull request
      const sourceType = event.source?.type ?? event.source?.issue?.pull_request ? "pullrequest" : null;
      const hasPR =
        event.source?.type === "pullrequest" ||
        event.source?.issue?.pull_request !== undefined ||
        event.source?.pull_request !== undefined;

      if (hasPR) {
        return { pass: false, reason: "hasPR:timeline" };
      }
    }
  }

  return { pass: true, reason: "" };
}

// ---------------------------------------------------------------------------
// Expensive Filter 2: Comment check for claim phrases
// ---------------------------------------------------------------------------
async function filterComments(issue, config) {
  const { owner, repo } = parseRepo(issue);
  const comments = await getIssueComments(owner, repo, issue.number, config.env.ghToken);

  if (comments === null) {
    return { pass: null, reason: "commentsError" };
  }

  if (!Array.isArray(comments)) {
    return { pass: null, reason: "commentsInvalidShape" };
  }

  const skipPhrases = config.filters.skipIfCommentMatches.map((p) => p.toLowerCase());

  for (const comment of comments) {
    const body = (comment.body ?? "").toLowerCase();
    const matched = skipPhrases.find((phrase) => body.includes(phrase));
    if (matched) {
      return { pass: false, reason: `claimed:\"${matched}\"` };
    }
  }

  return { pass: true, reason: "" };
}

// ---------------------------------------------------------------------------
// Expensive Filter 1: Repo health & stars check (cached per repo per run)
// ---------------------------------------------------------------------------
export async function filterRepoHealth(issue, config) {
  // Requirement 4: Skip star and repo-health filters for issues from watchlist repos
  if (isWatchlistRepo(issue, config)) {
    return { pass: true, reason: "" };
  }

  const { owner, repo } = parseRepo(issue);
  if (owner === "unknown" || repo === "unknown") {
    return { pass: false, reason: "unknownRepo" };
  }

  const repoData = await getRepo(owner, repo, config.env.ghToken);
  if (repoData === null) {
    // Requirement 5: Error fetching repo – treat as unknown, skip ONLY this repo's issues
    return { pass: null, reason: "repoHealthError" };
  }

  if (repoData.notFound) {
    return { pass: false, reason: "repoNotFound" };
  }

  // Attach full repo data to issue for downstream scoring/notifications
  issue.repository = repoData;

  // Requirement 2: Apply minStars/maxStars using stargazers_count from that same call
  const stars = repoData.stargazers_count ?? 0;
  if (stars < config.discovery.minStars) {
    return { pass: false, reason: `tooFewStars:${stars}<${config.discovery.minStars}` };
  }
  if (stars > config.discovery.maxStars) {
    return { pass: false, reason: `tooManyStars:${stars}>${config.discovery.maxStars}` };
  }

  // Requirement 1: archived=false
  if (repoData.archived) {
    return { pass: false, reason: "inactiveRepo:archived" };
  }

  // Requirement 1: pushed_at within repoMustBePushedWithinDays
  const withinDays =
    config.filters?.repoMustBePushedWithinDays ??
    config.filters?.repoMustHaveMergedPrWithinDays ??
    30;
  const cutoff = Date.now() - withinDays * 24 * 60 * 60 * 1000;
  const pushedTime = repoData.pushed_at ? new Date(repoData.pushed_at).getTime() : 0;
  if (!pushedTime || pushedTime < cutoff) {
    return { pass: false, reason: `inactiveRepo:notPushedWithin${withinDays}days` };
  }

  log.info(`Repo health & stars ${owner}/${repo}: ✓ active (stars=${stars}, pushed=${repoData.pushed_at})`);
  return { pass: true, reason: "" };
}

// ---------------------------------------------------------------------------
// Run all expensive filters for a single issue.
// Returns { passed: boolean, reason: string, skip: boolean }
//   skip=true means: don't notify AND don't mark seen, retry next run
// ---------------------------------------------------------------------------
export async function runExpensiveFilters(issue, config) {
  const filterFns = [
    () => filterRepoHealth(issue, config), // cheapest of the expensive
    () => filterTimeline(issue, config),
    () => filterComments(issue, config),
  ];

  for (const fn of filterFns) {
    try {
      const result = await fn();
      if (result.pass === null) {
        // Unknown result due to error – skip issue for this run
        return { pass: false, reason: result.reason, skip: true };
      }
      if (!result.pass) {
        return { pass: false, reason: result.reason, skip: false };
      }
    } catch (err) {
      log.warn("Expensive filter threw unexpectedly, skipping issue", { error: err.message });
      return { pass: false, reason: "expensiveFilterError", skip: true };
    }
  }

  return { pass: true, reason: "", skip: false };
}
