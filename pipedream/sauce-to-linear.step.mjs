/**
 * Sauce Labs -> Linear: V1 defect automation
 * Paste this whole file into a Pipedream Node.js code step.
 *
 * Implements:
 *   1. Webhook signature verification (saucelabs-sign, HMAC-SHA256)
 *   2. Actionability classification (skip passes, known-flaky, infra failures)
 *   3. Stable failure fingerprint
 *   4. Linear dedupe search by fingerprint
 *   5. Create new issue OR comment on + update the existing one
 *
 * Environment variables (Pipedream -> Workflow Settings -> Environment Variables):
 *   SAUCE_USERNAME           recommended; used to re-read the job record (webhook payload lags)
 *   SAUCE_ACCESS_KEY         recommended; pairs with SAUCE_USERNAME
 *   SAUCE_WEBHOOK_TOKEN      recommended; shared secret expected as ?token= on the trigger URL
 *   SAUCE_WEBHOOK_SECRET     optional; HMAC check of saucelabs-sign IF Sauce sends it (observed: it does not)
 *   SAUCE_ENFORCE_SIGNATURE  optional; "true" = reject a PRESENT but invalid saucelabs-sign
 *   SAUCE_REGION             optional; default "us-west-1"
 *   SAUCE_FLAKY_TAGS         optional; default "flaky,quarantine,known-flaky"
 *   LINEAR_ISSUE_LABELS      optional; default "Sauce Labs,Automated Test,Regression"
 */

import crypto from "crypto";

// Lets this file be imported by the local test harness, where Pipedream's
// global defineComponent() does not exist. No effect inside Pipedream.
const __component = typeof defineComponent === "function" ? defineComponent : (c) => c;

const LINEAR_API = "https://api.linear.app/graphql";

const DEFAULT_FLAKY_TAGS = ["flaky", "quarantine", "known-flaky"];
const DEFAULT_LABELS = ["Sauce Labs", "Automated Test", "Regression"];

/** Failures that are infrastructure noise, not product defects. */
const INFRA_ERROR_PATTERNS = [
  /device (is )?(not available|unavailable)/i,
  /no (matching )?devices? (are )?(available|found)/i,
  /could not (allocate|acquire|find|reserve)[^.]*device/i,
  /session (creation failed|could not be created|not created|startup failed)/i,
  /failed to create session/i,
  /appium[^.]*(did not start|failed to start|crashed)/i,
  /unable to connect to (the )?(grid|hub|device)/i,
  /tunnel[^.]*(unavailable|not available|closed|disconnected)/i,
  /timed? ?out[^.]*(acquiring|waiting for)[^.]*device/i,
  /infrastructure (error|failure)/i,
  /device cleanup (failed|error)/i,
  /app (installation|install) failed/i,
];

/* ------------------------------------------------------------------ */
/* Pure helpers (unit-tested in ./test)                                */
/* ------------------------------------------------------------------ */

export function slug(value = "") {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/**
 * Reduce a raw error/exception string to something stable across runs:
 * prefer the exception class, strip ids/numbers/hex that change every run.
 */
export function normalizeError(raw = "") {
  const text = String(raw ?? "").trim();
  if (!text) return "unknown-failure";

  const klass = text.match(/([A-Z][A-Za-z0-9_.]*(?:Error|Exception|Failure|Throwable))/);
  let base = klass ? klass[1] : text.split("\n")[0];

  base = base
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "")
    .replace(/0x[0-9a-f]+/gi, "")
    .replace(/\b[0-9a-f]{16,}\b/gi, "")
    .replace(/\d+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);

  return base || "unknown-failure";
}

/**
 * Sauce sends two different shapes depending on the event source: the webhook
 * field set (device, os_name, duration_sec, owner, data_type...) and the RDC
 * job object (device_name, os, start_time/end_time, owner_sauce, device_type,
 * nested device_descriptor). Normalise both into one canonical job so
 * everything downstream only has to know a single shape.
 */
export function normalizeJob(raw = {}) {
  if (!raw || typeof raw !== "object") return {};
  if (raw.__normalized) return raw;

  const descriptor = raw.device_descriptor || {};

  const durationSec = raw.duration_sec != null
    ? Number(raw.duration_sec)
    : (raw.start_time && raw.end_time ? Math.round((raw.end_time - raw.start_time) / 1000) : null);

  const isRealDevice = raw.device_type === "real_device" || raw.data_type === "rdc";

  // A live/manual session is a person driving a device, never a defect.
  const isManual = raw.manual === true || String(raw.test_report_type || "").toUpperCase() === "LIVE";

  return {
    __normalized: true,
    id: raw.id,
    name: raw.name,
    status: raw.status || raw.consolidated_status,
    passed: raw.passed,
    device: raw.device || raw.device_name || descriptor.name || descriptor.id,
    os_name: prettyOs(raw.os_name || raw.os || descriptor.os),
    sl_url: raw.sl_url,
    os_version: raw.os_version || descriptor.osVersion,
    browser_name: raw.browser_name,
    browser_version: raw.browser_version,
    app: raw.app || raw.application_summary?.filename || raw.application_summary?.name,
    error: raw.error,
    exception: raw.exception,
    build: raw.build,
    branch_name: raw.branch_name,
    commit_id: raw.commit_id,
    automation_backend: raw.automation_backend,
    owner: raw.owner || raw.owner_sauce,
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    duration_sec: durationSec,
    data_type: raw.data_type || (isRealDevice ? "rdc" : "vdc"),
    is_manual: isManual,
  };
}

const NAME_REASON_SEPARATOR = /\s+[—–-]{1,2}\s+/;

/** "test_checkout — AssertionError: ..." -> { testName, reason } */
export function splitName(name = "") {
  const text = String(name ?? "");
  const parts = text.split(NAME_REASON_SEPARATOR);
  return {
    testName: (parts[0] || "").trim(),
    reason: parts.slice(1).join(" - ").trim(),
  };
}

/** "AssertionError: Expected X" -> "AssertionError"; falls back to the first few words. */
export function errorClass(text = "") {
  const t = String(text ?? "").trim();
  if (!t) return "";
  const klass = t.match(/([A-Z][A-Za-z0-9_.]*(?:Error|Exception|Failure|Throwable))/);
  if (klass) return klass[1].split(".").pop();
  return t.split(/\s+/).slice(0, 4).join(" ").replace(/[:.,;]+$/, "");
}

/**
 * Sauce's RDC job API cannot accept a failure reason (it takes only name,
 * build, passed and tags), so for Appium real-device runs `error` and
 * `exception` usually arrive empty. Recover the reason from the channels the
 * test runner *can* set: a `failure:<text>` tag, or a " — <reason>" suffix on
 * the job name.
 */
export function deriveFailureText(job = {}) {
  const direct = String(job.error || job.exception || "").trim();
  if (direct) return direct;

  // Full reason rides in the job name ("test — AssertionError: ...").
  const { reason } = splitName(job.name);
  if (reason) return reason;

  // Tags can only hold a short error class (Sauce limits tags to <30 chars).
  const tags = Array.isArray(job.tags) ? job.tags : [];
  const tagged = tags.map(String).find((t) => /^(failure|err):/i.test(t));
  if (tagged) return tagged.replace(/^(failure|err):/i, "").trim();

  return "";
}

/** Major OS version only, so 18.1 -> 18.2 does not fork the fingerprint. */
export function majorVersion(version) {
  const v = String(version ?? "").trim();
  if (!v) return "";
  return v.split(".")[0];
}

/**
 * Stable identity for "this defect", independent of any single Sauce job.
 * Readable prefix for humans + short hash so distinct errors stay distinct.
 */
export function buildFingerprint(rawJob = {}) {
  const job = normalizeJob(rawJob);
  const platform = job.device || job.browser_name || "unknown-platform";
  const os = [job.os_name, majorVersion(job.os_version)].filter(Boolean).join(" ");
  const errorKey = normalizeError(deriveFailureText(job));

  const { testName } = splitName(job.name);

  const readable = [slug(testName), slug(platform), slug(os)].filter(Boolean).join(":");
  const hash = crypto
    .createHash("sha1")
    .update([testName, platform, os, errorKey].map((p) => String(p ?? "")).join("|"))
    .digest("hex")
    .slice(0, 8);

  return `${readable || "sauce-failure"}:${hash}`;
}

/** Rule-based triage: should this failure become engineering work? */
export function classifyFailure(rawJob = {}, opts = {}) {
  const job = normalizeJob(rawJob);
  const flakyTags = (opts.flakyTags || DEFAULT_FLAKY_TAGS).map((t) => String(t).toLowerCase());
  const status = String(job.status ?? "").toUpperCase();
  const errorText = deriveFailureText(job);

  if (job.is_manual) {
    return { actionable: false, reason: "live/manual device session, not an automated test" };
  }

  const isFailure = status === "FAILED" || status === "ERRORED" || job.passed === false;
  if (!isFailure) {
    return { actionable: false, reason: `status "${status || "unknown"}" is not a failure` };
  }

  const tags = (Array.isArray(job.tags) ? job.tags : []).map((t) => String(t).toLowerCase());
  const flaky = tags.find((t) => flakyTags.includes(t));
  if (flaky) {
    return { actionable: false, reason: `tagged "${flaky}" — treated as known-flaky` };
  }

  const infra = INFRA_ERROR_PATTERNS.find((re) => re.test(errorText));
  if (infra) {
    return { actionable: false, reason: `infrastructure failure, not a product defect: ${errorText.slice(0, 120)}` };
  }

  return { actionable: true, reason: status === "ERRORED" ? "test errored" : "assertion/application failure" };
}

export function prettyOs(name = "") {
  const n = String(name ?? "").trim();
  if (!n) return "";
  const known = { ANDROID: "Android", IOS: "iOS", MAC: "macOS", WINDOWS: "Windows", LINUX: "Linux" };
  return known[n.toUpperCase()] || n;
}

export function sauceJobUrl(job = {}, region = "us-west-1") {
  if (job.sl_url) return String(job.sl_url);
  if (!job.id) return "";
  const host = region && region !== "us-west-1"
    ? `https://app.${region}.saucelabs.com`
    : "https://app.saucelabs.com";
  return `${host}/tests/${job.id}`;
}

/* ---------- occurrence metadata embedded in the issue description ---------- */

const META_RE = /<!--\s*sauce-meta\s+([\s\S]*?)\s*-->/;

export function readMeta(description = "") {
  const match = String(description ?? "").match(META_RE);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

export function renderMeta(meta) {
  return `<!-- sauce-meta ${JSON.stringify(meta)} -->`;
}

export function upsertMeta(description = "", meta) {
  const block = renderMeta(meta);
  const text = String(description ?? "");
  return META_RE.test(text) ? text.replace(META_RE, block) : `${text}\n\n${block}`;
}

/** Rewrite the human-readable tracking table so it matches the metadata. */
export function renderTracking(meta) {
  return [
    "## Failure tracking",
    "",
    `- **Occurrences:** ${meta.occurrences}`,
    `- **First seen:** ${meta.firstSeen}`,
    `- **Last seen:** ${meta.lastSeen}`,
    `- **Latest build:** ${meta.latestBuild || "—"}`,
    `- **Latest commit:** ${meta.latestCommit || "—"}`,
    `- **Latest Sauce job:** ${meta.latestJobUrl || "—"}`,
    `- **Fingerprint:** \`${meta.fingerprint}\``,
  ].join("\n");
}

const TRACKING_RE = /## Failure tracking[\s\S]*?(?=\n## |\n<!-- sauce-meta|$)/;

export function upsertTracking(description = "", meta) {
  const block = renderTracking(meta);
  const text = String(description ?? "");
  return TRACKING_RE.test(text) ? text.replace(TRACKING_RE, `${block}\n`) : `${text}\n\n${block}\n`;
}

/* ---------- rendering ---------- */

export function buildTitle(rawJob = {}) {
  const job = normalizeJob(rawJob);
  const { testName } = splitName(job.name);
  const platform = job.device || job.browser_name || "unknown device";
  const os = [job.os_name, job.os_version].filter(Boolean).join(" ");
  const where = [platform, os].filter(Boolean).join(" / ");
  const klass = errorClass(deriveFailureText(job));

  const what = testName || "Unnamed test";
  const why = klass ? ` — ${klass}` : "";
  return `[Regression] ${what}${why}${where ? ` on ${where}` : ""}`.slice(0, 250);
}

export function buildDescription(job, fingerprint, meta, region) {
  const jobUrl = sauceJobUrl(job, region);
  const lines = [
    "Automated Sauce Labs regression, filed by Pipedream.",
    "",
    "## Failure",
    "",
    "```",
    (deriveFailureText(job) || "No failure text reported. See the Sauce job for logs and screenshots.").slice(0, 2000),
    "```",
    "",
    "## Environment",
    "",
    `- **Test:** ${splitName(job.name).testName || job.name || "—"}`,
    `- **Device:** ${job.device || "—"}`,
    `- **OS:** ${[job.os_name, job.os_version].filter(Boolean).join(" ") || "—"}`,
    `- **Browser:** ${[job.browser_name, job.browser_version].filter(Boolean).join(" ") || "— (native app test)"}`,
    `- **App:** ${job.app || "—"}`,
    `- **Framework:** ${job.automation_backend || "— (not reported for real device jobs)"}`,
    `- **Source:** ${String(job.data_type || "").toUpperCase() || "—"}`,
    `- **Owner:** ${job.owner || "—"}`,
    `- **Duration:** ${job.duration_sec != null ? `${job.duration_sec}s` : "—"}`,
    `- **Tags:** ${(job.tags || []).filter((t) => !/^(failure|err):/i.test(String(t))).join(", ") || "—"}`,
    "",
    "## Build",
    "",
    `- **Build:** ${job.build || "—"}`,
    `- **Branch:** ${job.branch_name || "— (not reported for real device jobs)"}`,
    `- **Commit:** ${job.commit_id || "— (not reported for real device jobs)"}`,
    `- **Sauce job:** ${jobUrl || "—"}`,
    "",
    renderTracking(meta),
    "",
    renderMeta(meta),
  ];
  return lines.join("\n");
}

export function buildRecurrenceComment(job, meta, region) {
  const os = [job.os_name, job.os_version].filter(Boolean).join(" ");
  const where = [job.device, os].filter(Boolean).join(" / ") || "—";
  const failure = deriveFailureText(job);

  const lines = [
    "Regression reproduced again.",
    "",
    `- **Occurrence:** ${meta.occurrences}`,
    `- **Build:** ${job.build || "—"}`,
    `- **Commit:** ${job.commit_id || "—"}`,
    `- **Environment:** ${where}`,
    `- **Status:** ${job.status || "—"}`,
    `- **Sauce run:** ${sauceJobUrl(job, region) || "—"}`,
  ];

  if (failure) {
    lines.push("", "```", String(failure).slice(0, 800), "```");
  }

  return lines.join("\n");
}

/* ---------- signature ---------- */

export function verifySignature({ rawBody, signature, secret }) {
  if (!secret) return { checked: false, valid: null, reason: "no SAUCE_WEBHOOK_SECRET set" };
  if (!signature) return { checked: true, valid: false, reason: "request had no saucelabs-sign header" };

  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const supplied = String(signature).replace(/^sha256=/i, "").trim();

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(supplied, "utf8");
  const valid = a.length === b.length && crypto.timingSafeEqual(a, b);

  return { checked: true, valid, reason: valid ? "signature ok" : "signature mismatch" };
}

/* ---------- Linear API ---------- */

/**
 * Linear wants OAuth tokens as "Bearer <token>" but personal API keys
 * (lin_api_...) bare - it rejects an API key sent as a Bearer token.
 */
export function linearAuthHeader(token = "") {
  const t = String(token ?? "").trim();
  return /^lin_api_/i.test(t) ? t : `Bearer ${t}`;
}

export async function linearGql(token, query, variables, fetchImpl = fetch) {
  const res = await fetchImpl(LINEAR_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: linearAuthHeader(token),
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(`Linear API error: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

const FIND_ISSUE = `
  query FindByFingerprint($teamId: ID!, $fingerprint: String!) {
    issues(
      first: 10
      filter: { team: { id: { eq: $teamId } }, description: { contains: $fingerprint } }
    ) {
      nodes { id identifier title url description state { name type } createdAt }
    }
  }
`;

// Fallback used if the server-side description filter is unavailable: pull the
// team's recent issues and match the fingerprint locally.
const RECENT_ISSUES = `
  query RecentTeamIssues($teamId: ID!) {
    issues(first: 100, filter: { team: { id: { eq: $teamId } } }, orderBy: updatedAt) {
      nodes { id identifier title url description state { name type } createdAt }
    }
  }
`;

/**
 * Find a prior issue for this fingerprint. Prefers a server-side filter and
 * degrades to client-side matching rather than filing a duplicate.
 */
export async function findExistingIssue({ token, teamId, fingerprint, fetchImpl = fetch }) {
  let nodes = [];
  let strategy = "description-filter";

  try {
    const data = await linearGql(token, FIND_ISSUE, { teamId, fingerprint }, fetchImpl);
    nodes = data?.issues?.nodes ?? [];
  } catch (err) {
    strategy = "recent-scan";
    const data = await linearGql(token, RECENT_ISSUES, { teamId }, fetchImpl);
    nodes = (data?.issues?.nodes ?? []).filter((i) => String(i.description ?? "").includes(fingerprint));
  }

  const match = nodes.find((i) => i.state?.type !== "canceled") ?? null;
  return { issue: match, strategy };
}

const ISSUE_BY_ID = `
  query IssueById($id: String!) {
    issue(id: $id) { id identifier title url description state { name type } createdAt }
  }
`;

const TEAM_LABELS = `
  query TeamLabels($teamId: String!) {
    team(id: $teamId) { labels(first: 100) { nodes { id name } } }
  }
`;

const CREATE_ISSUE = `
  mutation CreateIssue($input: IssueCreateInput!) {
    issueCreate(input: $input) { success issue { id identifier url title } }
  }
`;

const UPDATE_ISSUE = `
  mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) { success issue { id identifier url } }
  }
`;

const CREATE_COMMENT = `
  mutation CreateComment($input: CommentCreateInput!) {
    commentCreate(input: $input) { success comment { id url } }
  }
`;

/**
 * The whole V1 decision tree, pulled out so it can be run against a mock
 * Linear API in tests.
 */
/**
 * Optional memory between runs. Sauce fires its webhook on every status
 * update, so one failing job can arrive 2-3 times within seconds; two of those
 * can race past the Linear search and both create. The store answers two
 * questions faster than Linear can: "have I seen this job id?" and "which
 * issue owns this fingerprint?". Everything still works with no store, just
 * without the race protection.
 */
/** How many Sauce job ids an issue remembers in its sauce-meta block. */
const MAX_TRACKED_JOBS = 30;

async function storeGet(store, key) { try { return store ? await store.get(key) : undefined; } catch { return undefined; } }
async function storeSet(store, key, value) { try { if (store) await store.set(key, value); } catch {} }

/** Comment on an existing issue and bump its occurrence tracking. */
async function recordRecurrence({ existing, job, fingerprint, region, token, fetchImpl, store, jobKey, timestamp, strategy }) {
  const prior = readMeta(existing.description) ?? {
    fingerprint,
    occurrences: 1,
    firstSeen: existing.createdAt || timestamp,
  };

  // The issue itself remembers which Sauce jobs it has already counted, so a
  // job seen again (overlapping poll windows, webhook re-fires, a lost store)
  // never inflates the occurrence count or posts a second comment.
  const priorJobIds = Array.isArray(prior.jobIds) ? prior.jobIds.map(String) : [];
  if (job.id && priorJobIds.includes(String(job.id))) {
    const ref = { id: existing.id, identifier: existing.identifier, url: existing.url };
    if (jobKey) await storeSet(store, jobKey, { at: timestamp, action: "already-recorded", issue: ref });
    return { action: "already-recorded", fingerprint, jobId: job.id, lookupStrategy: strategy, issue: { ...ref, title: existing.title } };
  }

  const meta = {
    ...prior,
    fingerprint,
    occurrences: (prior.occurrences || 1) + 1,
    firstSeen: prior.firstSeen || existing.createdAt || timestamp,
    lastSeen: timestamp,
    latestBuild: job.build || prior.latestBuild || "",
    latestCommit: job.commit_id || prior.latestCommit || "",
    latestJobUrl: sauceJobUrl(job, region) || prior.latestJobUrl || "",
    jobIds: job.id ? [...priorJobIds, String(job.id)].slice(-MAX_TRACKED_JOBS) : priorJobIds,
  };

  const nextDescription = upsertMeta(upsertTracking(existing.description || "", meta), meta);
  await linearGql(token, UPDATE_ISSUE, { id: existing.id, input: { description: nextDescription } }, fetchImpl);

  const reopened = existing.state?.type === "completed";
  const body = reopened
    ? `⚠️ This regression reproduced **after the issue was closed**.\n\n${buildRecurrenceComment(job, meta, region)}`
    : buildRecurrenceComment(job, meta, region);

  const commented = await linearGql(token, CREATE_COMMENT, { input: { issueId: existing.id, body } }, fetchImpl);

  const ref = { id: existing.id, identifier: existing.identifier, url: existing.url };
  await storeSet(store, `fp:${fingerprint}`, { issueId: existing.id, identifier: existing.identifier, updatedAt: timestamp });
  if (jobKey) await storeSet(store, jobKey, { at: timestamp, action: "commented", issue: ref });

  return {
    action: "commented",
    fingerprint,
    lookupStrategy: strategy,
    occurrences: meta.occurrences,
    issue: { ...ref, title: existing.title },
    reopenedAfterClose: reopened,
    commentUrl: commented?.commentCreate?.comment?.url ?? null,
  };
}

export async function processFailure({ job: rawJob, teamId, token, region, labelNames, fetchImpl = fetch, store = null, now = () => new Date().toISOString(), raceDelayMs = 300 }) {
  const job = normalizeJob(rawJob);
  const fingerprint = buildFingerprint(job);
  const timestamp = now();

  // Same Sauce job delivered again (status re-fire): do nothing.
  const jobKey = job.id ? `job:${job.id}` : null;
  if (jobKey) {
    const seen = await storeGet(store, jobKey);
    if (seen) {
      return { action: "duplicate-delivery", fingerprint, jobId: job.id, issue: seen.issue ?? null, firstSeenAt: seen.at };
    }
    // Claim the job id NOW. Sauce delivers one job 2-3 times within a second,
    // while the Linear round-trip below takes seconds. Recording the claim only
    // afterwards let two deliveries both create (observed 2026-09-20: SAU-10 and
    // SAU-11, same job, same fingerprint). Claiming first shrinks the race
    // window to a single store write.
    await storeSet(store, jobKey, { at: timestamp, action: "in-progress" });
  }

  let existing = null;
  let strategy = "store";
  const cached = await storeGet(store, `fp:${fingerprint}`);
  if (cached?.issueId) {
    try {
      const data = await linearGql(token, ISSUE_BY_ID, { id: cached.issueId }, fetchImpl);
      const issue = data?.issue;
      if (issue && issue.state?.type !== "canceled") existing = issue;
    } catch { existing = null; }
  }
  if (!existing) {
    ({ issue: existing, strategy } = await findExistingIssue({ token, teamId, fingerprint, fetchImpl }));
  }

  if (existing) {
    return await recordRecurrence({ existing, job, fingerprint, region, token, fetchImpl, store, jobKey, timestamp, strategy });
  }

  // Nothing found. Claim the fingerprint and confirm we won before creating, so
  // two jobs failing the same way at the same instant still file one issue.
  const claimToken = `${job.id || "nojob"}::${Math.random().toString(36).slice(2, 10)}`;
  if (store) {
    await storeSet(store, `fp:${fingerprint}`, { claimToken, at: timestamp });
    await new Promise((r) => setTimeout(r, raceDelayMs));
    const check = await storeGet(store, `fp:${fingerprint}`);
    if (check?.claimToken && check.claimToken !== claimToken) {
      // Lost the claim. If the winner is another delivery of the SAME job this
      // is a re-fire, not a new occurrence - the claim token carries the job id.
      const winnerJobId = String(check.claimToken).split("::")[0];
      const sameJob = Boolean(job.id) && winnerJobId === String(job.id);

      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, raceDelayMs));
        const w = await storeGet(store, `fp:${fingerprint}`);
        if (w?.issueId) {
          if (sameJob) {
            const ref = { id: w.issueId, identifier: w.identifier ?? null, url: null };
            if (jobKey) await storeSet(store, jobKey, { at: timestamp, action: "duplicate-delivery", issue: ref });
            return { action: "duplicate-delivery", fingerprint, jobId: job.id, issue: ref, firstSeenAt: timestamp };
          }
          const winner = await linearGql(token, ISSUE_BY_ID, { id: w.issueId }, fetchImpl).then((d) => d?.issue).catch(() => null);
          if (winner && winner.state?.type !== "canceled") {
            return await recordRecurrence({ existing: winner, job, fingerprint, region, token, fetchImpl, store, jobKey, timestamp, strategy: "store-raced" });
          }
        }
      }
    }
  }

  const meta = {
    fingerprint,
    occurrences: 1,
    firstSeen: timestamp,
    lastSeen: timestamp,
    latestBuild: job.build || "",
    latestCommit: job.commit_id || "",
    latestJobUrl: sauceJobUrl(job, region) || "",
    jobIds: job.id ? [String(job.id)] : [],
  };

  // Labels are best effort — a missing label must never block filing the defect.
  let labelIds = [];
  try {
    const wanted = (labelNames || DEFAULT_LABELS).map((n) => n.toLowerCase());
    const labelData = await linearGql(token, TEAM_LABELS, { teamId }, fetchImpl);
    labelIds = (labelData?.team?.labels?.nodes ?? [])
      .filter((l) => wanted.includes(String(l.name).toLowerCase()))
      .map((l) => l.id);
  } catch {
    labelIds = [];
  }

  const input = {
    teamId,
    title: buildTitle(job),
    description: buildDescription(job, fingerprint, meta, region),
  };
  if (labelIds.length) input.labelIds = labelIds;

  const created = await linearGql(token, CREATE_ISSUE, { input }, fetchImpl);
  const issue = created?.issueCreate?.issue;

  if (issue) {
    const ref = { id: issue.id, identifier: issue.identifier, url: issue.url };
    await storeSet(store, `fp:${fingerprint}`, { issueId: issue.id, identifier: issue.identifier, createdAt: timestamp });
    if (jobKey) await storeSet(store, jobKey, { at: timestamp, action: "created", issue: ref });
  }

  return {
    action: "created",
    fingerprint,
    lookupStrategy: strategy,
    occurrences: 1,
    issue: issue ? { id: issue.id, identifier: issue.identifier, url: issue.url, title: issue.title } : null,
    labelsApplied: labelIds.length,
  };
}

/**
 * The webhook payload is a snapshot taken at the status transition, so fields
 * the test runner sets moments later (the failure reason in `name`, the `err:`
 * tag) are missing from it — verified 2026-09-20: the job record had both while
 * the webhook that announced it had neither. Treat the webhook as a
 * notification and the job record as the source of truth.
 *
 * Needs SAUCE_USERNAME + SAUCE_ACCESS_KEY. Without them the step still works,
 * just with whatever the webhook happened to carry.
 */
export async function fetchJobRecord({ jobId, username, accessKey, region = "us-west-1", fetchImpl = fetch }) {
  if (!jobId || !username || !accessKey) return null;
  try {
    const auth = Buffer.from(`${username}:${accessKey}`).toString("base64");
    const res = await fetchImpl(`https://api.${region}.saucelabs.com/v1/rdc/jobs/${jobId}`, {
      headers: { Authorization: `Basic ${auth}` },
    });
    if (!res.ok) return null;
    const record = await res.json();
    return record && typeof record === "object" ? record : null;
  } catch {
    return null;
  }
}

/** Webhook fields first, authoritative job-record fields on top. */
export function mergeJobRecord(webhookJob = {}, record = null) {
  if (!record) return webhookJob;
  const merged = { ...webhookJob, ...record };
  // The webhook carries a ready-made link the API record lacks.
  if (webhookJob.sl_url && !record.sl_url) merged.sl_url = webhookJob.sl_url;
  return merged;
}

/** Sauce may POST a single job object or a batch; normalise to an array. */
export function extractJobs(body) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.events)) return body.events;
  if (body && Array.isArray(body.jobs)) return body.jobs;
  if (body && typeof body === "object") return [body];
  return [];
}

/* ------------------------------------------------------------------ */
/* Pipedream component                                                 */
/* ------------------------------------------------------------------ */

export default __component({
  props: {
    linear: {
      type: "app",
      app: "linear",
    },
    teamId: {
      type: "string",
      label: "Linear Team ID",
      description: "UUID of the Linear team that should receive these defects.",
    },
    store: {
      type: "data_store",
      label: "Dedupe memory",
      description: "Remembers processed Sauce job ids and fingerprint -> issue, so re-fired webhooks never file twice.",
    },
  },
  async run({ steps, $ }) {
    const token = this.linear.$auth.oauth_access_token;
    const region = process.env.SAUCE_REGION || "us-west-1";
    const flakyTags = (process.env.SAUCE_FLAKY_TAGS || DEFAULT_FLAKY_TAGS.join(","))
      .split(",").map((t) => t.trim()).filter(Boolean);
    const labelNames = (process.env.LINEAR_ISSUE_LABELS || DEFAULT_LABELS.join(","))
      .split(",").map((t) => t.trim()).filter(Boolean);

    const headers = steps.trigger.event.headers || {};
    let body = steps.trigger.event.body;

    // 1. Verify the webhook.
    // Sauce signs the RAW request bytes (HMAC-SHA256, hex, header saucelabs-sign).
    // Pipedream parses JSON and discards the bytes, so re-serialising never
    // matches. Configure the Sauce webhook URL with ?pipedream_upload_body=1 and
    // Pipedream instead stores the exact bytes at body.raw_body_url. We verify
    // over those bytes, then parse them ourselves.
    let rawBody = null;
    let rawSource = "none";
    if (body && typeof body === "object" && body.raw_body_url) {
      const res = await fetch(body.raw_body_url);
      rawBody = await res.text();
      rawSource = "raw_body_url";
      try { body = JSON.parse(rawBody); } catch { /* leave as-is; extractJobs handles non-objects */ }
    } else if (typeof body === "string") {
      rawBody = body;
      rawSource = "string-body";
      try { body = JSON.parse(rawBody); } catch {}
    } else {
      rawBody = JSON.stringify(body);
      rawSource = "reserialised (cannot match Sauce's HMAC — add ?pipedream_upload_body=1 to the webhook URL)";
    }

    const sig = verifySignature({
      rawBody,
      signature: headers["saucelabs-sign"],
      secret: process.env.SAUCE_WEBHOOK_SECRET,
    });
    $.export("signature", { ...sig, rawSource });

    const enforce = String(process.env.SAUCE_ENFORCE_SIGNATURE).toLowerCase() === "true";
    const urlToken = process.env.SAUCE_WEBHOOK_TOKEN;
    const query = steps.trigger.event.query || {};

    if (urlToken) {
      const supplied = String(query.token ?? "");
      const a = Buffer.from(urlToken, "utf8"), b = Buffer.from(supplied, "utf8");
      const tokenOk = a.length === b.length && crypto.timingSafeEqual(a, b);
      $.export("url_token", { checked: true, valid: tokenOk });
      if (!tokenOk) throw new Error("Rejecting webhook: missing or wrong ?token in trigger URL");
    } else {
      $.export("url_token", { checked: false, valid: null, reason: "no SAUCE_WEBHOOK_TOKEN set" });
    }

    // HMAC is only enforced when Sauce actually signed the request.
    if (enforce && sig.checked && headers["saucelabs-sign"] && !sig.valid) {
      throw new Error(`Rejecting webhook: ${sig.reason}`);
    }

    const jobs = extractJobs(body);
    if (!jobs.length) return $.flow.exit("Webhook contained no job payload.");

    const sauceUser = process.env.SAUCE_USERNAME;
    const sauceKey = process.env.SAUCE_ACCESS_KEY;

    const results = [];
    for (const webhookJob of jobs) {
      // 1b. Re-read the job from Sauce; the webhook snapshot lags the runner.
      const record = await fetchJobRecord({ jobId: webhookJob?.id, username: sauceUser, accessKey: sauceKey, region });
      const job = mergeJobRecord(webhookJob, record);
      if (!record && sauceUser) $.export("enrichment", "job record fetch failed; using webhook payload");
      else if (!sauceUser) $.export("enrichment", "SAUCE_USERNAME/SAUCE_ACCESS_KEY not set; using webhook payload");

      // 2. Is it actionable?
      const verdict = classifyFailure(job, { flakyTags });
      if (!verdict.actionable) {
        results.push({ action: "skipped", test: job.name, reason: verdict.reason });
        continue;
      }

      // 3-5. Fingerprint, search, create or update
      const outcome = await processFailure({ job, teamId: this.teamId, token, region, labelNames, store: this.store });
      results.push({ ...outcome, test: job.name, triage: verdict.reason });
    }

    const created = results.filter((r) => r.action === "created").length;
    const commented = results.filter((r) => r.action === "commented").length;
    const skipped = results.filter((r) => r.action === "skipped").length;
    const dupes = results.filter((r) => r.action === "duplicate-delivery" || r.action === "already-recorded").length;

    $.export("$summary", `${created} created, ${commented} updated, ${skipped} skipped` + (dupes ? `, ${dupes} duplicate delivery` : ""));
    return { results };
  },
});
