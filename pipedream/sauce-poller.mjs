#!/usr/bin/env node
/**
 * Sauce Labs -> Linear poller. Runs on any cron (GitHub Actions: see
 * .github/workflows/sauce-poller.yml); no Pipedream and no webhook needed.
 *
 * Each run:
 *   1. Lists recent real-device jobs from the Sauce API (newest first).
 *   2. Ignores passed, still-running and out-of-window jobs.
 *   3. Re-reads each remaining job record (source of truth for status, tags, name).
 *   4. Triage, fingerprint, and file-or-update in Linear, using exactly the same
 *      logic as the Pipedream webhook step (sauce-to-linear.step.mjs).
 *
 * The poller keeps no state between runs. Overlapping windows are safe because
 * each Linear issue records the Sauce job ids it has already counted
 * (sauce-meta.jobIds), so a job seen by two polls is reported "already-recorded".
 *
 * Environment:
 *   SAUCE_USERNAME, SAUCE_ACCESS_KEY  required
 *   LINEAR_API_KEY, LINEAR_TEAM_ID    required unless DRY_RUN=true
 *   SAUCE_REGION                      default us-west-1
 *   SAUCE_LOOKBACK_MINUTES            default 30 (keep it > 2x the cron interval;
 *                                     GitHub can start scheduled runs late)
 *   SAUCE_FLAKY_TAGS                  default flaky,quarantine,known-flaky
 *   LINEAR_ISSUE_LABELS               default Sauce Labs,Automated Test,Regression
 *   DRY_RUN=true                      triage and print only; write nothing to Linear
 */
import { appendFileSync } from "fs";
import { pathToFileURL } from "url";
import {
  classifyFailure,
  processFailure,
  fetchJobRecord,
  buildFingerprint,
  buildTitle,
} from "./sauce-to-linear.step.mjs";

const PAGE_SIZE = 100;
const MAX_PAGES = 20;
/** Keep paging past the window start by this much, so long jobs that started earlier are still seen. */
const LONG_JOB_GRACE_MS = 2 * 60 * 60 * 1000;

const list = (value, fallback) =>
  String(value || fallback).split(",").map((t) => t.trim()).filter(Boolean);

export function sauceAuthHeader(username, accessKey) {
  return `Basic ${Buffer.from(`${username}:${accessKey}`).toString("base64")}`;
}

/** A job the list endpoint already reports as passed needs no record fetch. */
export function isClearlyPassed(job = {}) {
  const s = String(job.consolidated_status || job.status || "").toLowerCase();
  return s === "passed" || job.passed === true;
}

/**
 * Finished RDC jobs whose end_time falls inside the window. The endpoint is
 * sorted newest-first; paging stops once a page is entirely older than the
 * window (minus a grace period for long-running jobs).
 */
export async function listRecentJobs({
  username, accessKey, region = "us-west-1", sinceMs,
  fetchImpl = fetch, pageSize = PAGE_SIZE, maxPages = MAX_PAGES,
}) {
  const base = `https://api.${region}.saucelabs.com/v1/rdc/jobs`;
  const headers = { Authorization: sauceAuthHeader(username, accessKey) };
  const byId = new Map();
  // /v1/rdc/jobs is 1-indexed: offset=1 is the newest job, and offset=0 is
  // answered with HTTP 500 (seen live 2026-09-24).
  let offset = 1;

  for (let page = 0; page < maxPages; page++) {
    const res = await fetchImpl(`${base}?limit=${pageSize}&offset=${offset}`, { headers });
    if (!res.ok) throw new Error(`Sauce job list failed: HTTP ${res.status}`);

    const json = await res.json();
    const entities = Array.isArray(json?.entities) ? json.entities : [];
    for (const job of entities) if (job?.id && !byId.has(job.id)) byId.set(job.id, job);

    // metaData.moreAvailable has been observed as false on a full page, so a
    // full page also counts as "there may be more".
    const mayHaveMore = Boolean(json?.metaData?.moreAvailable) || entities.length >= pageSize;
    const oldest = Math.min(...entities.map((j) => Number(j.creation_time ?? j.start_time ?? Infinity)));
    if (!entities.length || !mayHaveMore || oldest < sinceMs - LONG_JOB_GRACE_MS) break;
    offset += entities.length;
  }

  return [...byId.values()].filter((j) => j.end_time && Number(j.end_time) >= sinceMs);
}

/** A tiny per-run store so two failures with one fingerprint in the same poll file one issue. */
export function memoryStore() {
  const m = new Map();
  return { get: async (k) => m.get(k), set: async (k, v) => { m.set(k, v); } };
}

export function readConfig(env = process.env) {
  const cfg = {
    username: env.SAUCE_USERNAME,
    accessKey: env.SAUCE_ACCESS_KEY,
    region: env.SAUCE_REGION || "us-west-1",
    lookbackMinutes: Number(env.SAUCE_LOOKBACK_MINUTES || 30),
    flakyTags: list(env.SAUCE_FLAKY_TAGS, "flaky,quarantine,known-flaky"),
    labelNames: list(env.LINEAR_ISSUE_LABELS, "Sauce Labs,Automated Test,Regression"),
    linearToken: env.LINEAR_API_KEY,
    teamId: env.LINEAR_TEAM_ID,
    dryRun: String(env.DRY_RUN || "").toLowerCase() === "true",
  };
  const missing = [];
  if (!cfg.username) missing.push("SAUCE_USERNAME");
  if (!cfg.accessKey) missing.push("SAUCE_ACCESS_KEY");
  if (!cfg.dryRun && !cfg.linearToken) missing.push("LINEAR_API_KEY");
  if (!cfg.dryRun && !cfg.teamId) missing.push("LINEAR_TEAM_ID");
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  if (!Number.isFinite(cfg.lookbackMinutes) || cfg.lookbackMinutes <= 0) {
    throw new Error(`SAUCE_LOOKBACK_MINUTES must be a positive number, got "${env.SAUCE_LOOKBACK_MINUTES}"`);
  }
  return cfg;
}

export async function runPoll({ env = process.env, fetchImpl = fetch, nowMs = Date.now(), log = console.log } = {}) {
  const cfg = readConfig(env);
  const sinceMs = nowMs - cfg.lookbackMinutes * 60 * 1000;

  const recent = await listRecentJobs({
    username: cfg.username, accessKey: cfg.accessKey, region: cfg.region, sinceMs, fetchImpl,
  });
  const candidates = recent.filter((j) => !isClearlyPassed(j));
  log(`Window: last ${cfg.lookbackMinutes} min. ${recent.length} finished job(s), ${candidates.length} not passed.${cfg.dryRun ? " DRY RUN - nothing is written to Linear." : ""}`);

  const store = memoryStore();
  const results = [];

  for (const listed of candidates) {
    try {
      const record = await fetchJobRecord({
        jobId: listed.id, username: cfg.username, accessKey: cfg.accessKey, region: cfg.region, fetchImpl,
      });
      const job = record ? { ...listed, ...record } : listed;

      const verdict = classifyFailure(job, { flakyTags: cfg.flakyTags });
      if (!verdict.actionable) {
        results.push({ action: "skipped", jobId: job.id, test: job.name, reason: verdict.reason });
        continue;
      }

      if (cfg.dryRun) {
        results.push({ action: "would-file", jobId: job.id, test: job.name, fingerprint: buildFingerprint(job), title: buildTitle(job) });
        continue;
      }

      const outcome = await processFailure({
        job, teamId: cfg.teamId, token: cfg.linearToken, region: cfg.region,
        labelNames: cfg.labelNames, fetchImpl, store, raceDelayMs: 0,
      });
      results.push({ ...outcome, jobId: job.id, test: job.name, triage: verdict.reason });
    } catch (err) {
      results.push({ action: "error", jobId: listed.id, test: listed.name, error: String(err?.message || err) });
    }
  }

  const count = (a) => results.filter((r) => r.action === a).length;
  const summary = cfg.dryRun
    ? `${count("would-file")} would be filed, ${count("skipped")} skipped, ${count("error")} errors`
    : `${count("created")} created, ${count("commented")} commented, ${count("already-recorded")} already recorded, ${count("skipped")} skipped, ${count("error")} errors`;

  return { summary, results, window: { sinceMs, nowMs, lookbackMinutes: cfg.lookbackMinutes } };
}

function describe(r) {
  const who = r.issue?.identifier ? ` ${r.issue.identifier}${r.issue.url ? ` (${r.issue.url})` : ""}` : "";
  const why = r.reason || r.error || r.title || r.triage || "";
  return `- **${r.action}**${who}: ${r.test || r.jobId}${why ? ` - ${why}` : ""}`;
}

async function main() {
  const { summary, results } = await runPoll();
  console.log(`\n${summary}`);
  for (const r of results) console.log(describe(r));

  if (process.env.GITHUB_STEP_SUMMARY) {
    const md = [`### Sauce -> Linear poll`, "", summary, "", ...results.map(describe), ""].join("\n");
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  }
  // Fail the run (so GitHub notifies) if any job could not be processed.
  if (results.some((r) => r.action === "error")) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err?.stack || err);
    process.exitCode = 1;
  });
}
