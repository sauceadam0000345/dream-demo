/**
 * The GitHub Actions poller, run against a mock Sauce API and the mock Linear.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

import { runPoll, listRecentJobs, readConfig, isClearlyPassed } from "../sauce-poller.mjs";
import { readMeta } from "../sauce-to-linear.step.mjs";
import { createMockLinear } from "./mock-linear.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (n) => JSON.parse(readFileSync(join(here, "..", "fixtures", n), "utf8"));

const NOW = 1_800_000_000_000;
const MIN = 60 * 1000;
const TEAM = "3cad1481-1026-4b67-b73a-d6e86c856ea4";
const ENV = {
  SAUCE_USERNAME: "demo-user",
  SAUCE_ACCESS_KEY: "demo-key",
  LINEAR_API_KEY: "lin_api_fake",
  LINEAR_TEAM_ID: TEAM,
  SAUCE_LOOKBACK_MINUTES: "30",
};

/** A failed RDC job record that ended `agoMin` minutes before NOW. */
function failedJob(id, agoMin, overrides = {}) {
  const base = fixture("rdc-job-object-failed.json");
  const end = NOW - agoMin * MIN;
  return { ...base, id, start_time: end - 2 * MIN, creation_time: end - 2 * MIN, end_time: end, ...overrides };
}

function passedJob(id, agoMin) {
  const end = NOW - agoMin * MIN;
  return { id, name: "loginWorks", status: "passed", consolidated_status: "passed", passed: true, start_time: end - MIN, creation_time: end - MIN, end_time: end };
}

/** Mock of GET /v1/rdc/jobs (list, newest first) and GET /v1/rdc/jobs/:id. */
function createMockSauce(jobs, { oneIndexed = true, reportMore = true } = {}) {
  const calls = [];
  const sorted = () => [...jobs].sort((a, b) => b.creation_time - a.creation_time);
  const res = (status, body) => ({ ok: status < 300, status, json: async () => body });

  async function fetchImpl(url, options = {}) {
    const u = new URL(url);
    calls.push({ path: u.pathname, search: u.search, auth: options.headers?.Authorization });
    const one = u.pathname.match(/^\/v1\/rdc\/jobs\/([^/]+)$/);
    if (one) {
      const job = jobs.find((j) => j.id === one[1]);
      return job ? res(200, job) : res(404, { message: "not found" });
    }
    if (u.pathname === "/v1/rdc/jobs") {
      const limit = Number(u.searchParams.get("limit"));
      const offset = Number(u.searchParams.get("offset"));
      if (oneIndexed && offset < 1) return res(500, { message: "Oops, something went wrong." });
      const start = oneIndexed ? offset - 1 : offset;
      const all = sorted();
      // The list endpoint returns a slimmer object than the job record.
      const entities = all.slice(start, start + limit).map(({ tags, build, ...slim }) => slim);
      return res(200, { entities, metaData: { moreAvailable: reportMore && start + limit < all.length, offset, limit, sortDirection: "DESCENDING" } });
    }
    throw new Error(`mock sauce: unhandled ${url}`);
  }
  return { fetchImpl, calls };
}

/** Route Linear calls to the Linear mock, everything else to the Sauce mock. */
function wire(sauce, linear) {
  return (url, options) => (String(url).includes("api.linear.app") ? linear.fetchImpl(url, options) : sauce.fetchImpl(url, options));
}

const quiet = () => {};

test("poller: files a failure in the window; ignores passed, running and out-of-window jobs", async () => {
  const running = { ...failedJob("running", 1), end_time: null };
  const sauce = createMockSauce([failedJob("f1", 3), passedJob("p1", 2), failedJob("old", 90), running]);
  const linear = createMockLinear();

  const { summary, results } = await runPoll({ env: ENV, fetchImpl: wire(sauce, linear), nowMs: NOW, log: quiet });

  assert.equal(summary, "1 created, 0 commented, 0 already recorded, 0 skipped, 0 errors");
  assert.equal(results.length, 1);
  assert.equal(results[0].jobId, "f1");
  assert.equal(linear.issues.length, 1);
  assert.deepEqual(readMeta(linear.issues[0].description).jobIds, ["f1"]);

  const recordFetches = sauce.calls.filter((c) => c.path.startsWith("/v1/rdc/jobs/")).map((c) => c.path);
  assert.deepEqual(recordFetches, ["/v1/rdc/jobs/f1"], "only non-passed, finished, in-window jobs are re-read");
  assert.match(sauce.calls[0].auth, /^Basic /);
});

test("poller: overlapping windows never double-count a job", async () => {
  const sauce = createMockSauce([failedJob("f1", 3)]);
  const linear = createMockLinear();
  const fetchImpl = wire(sauce, linear);

  await runPoll({ env: ENV, fetchImpl, nowMs: NOW, log: quiet });
  const second = await runPoll({ env: ENV, fetchImpl, nowMs: NOW + 5 * MIN, log: quiet });

  assert.equal(second.results[0].action, "already-recorded");
  assert.equal(linear.issues.length, 1);
  assert.equal(linear.comments.length, 0);
  assert.equal(readMeta(linear.issues[0].description).occurrences, 1);
});

test("poller: a new job with the same failure comments on the existing issue", async () => {
  const jobs = [failedJob("f1", 20)];
  const sauce = createMockSauce(jobs);
  const linear = createMockLinear();
  const fetchImpl = wire(sauce, linear);

  await runPoll({ env: ENV, fetchImpl, nowMs: NOW, log: quiet });
  jobs.push(failedJob("f2", 1, { build: "build-2" }));
  const second = await runPoll({ env: ENV, fetchImpl, nowMs: NOW, log: quiet });

  const byJob = Object.fromEntries(second.results.map((r) => [r.jobId, r.action]));
  assert.deepEqual(byJob, { f1: "already-recorded", f2: "commented" });
  assert.equal(linear.issues.length, 1);
  assert.equal(linear.comments.length, 1);
  const meta = readMeta(linear.issues[0].description);
  assert.equal(meta.occurrences, 2);
  assert.deepEqual(meta.jobIds, ["f1", "f2"]);
});

test("poller: two jobs failing the same way in ONE poll file one issue", async () => {
  const sauce = createMockSauce([failedJob("a", 2), failedJob("b", 4)]);
  const linear = createMockLinear();
  const { results } = await runPoll({ env: ENV, fetchImpl: wire(sauce, linear), nowMs: NOW, log: quiet });

  assert.deepEqual(results.map((r) => r.action).sort(), ["commented", "created"]);
  assert.equal(linear.issues.length, 1);
});

test("poller: flaky-tagged and infra failures are skipped, not filed", async () => {
  const sauce = createMockSauce([
    failedJob("flaky", 2, { tags: ["flaky"] }),
    failedJob("infra", 3, { name: "test_login", tags: [], error: "Device is not available" }),
  ]);
  const linear = createMockLinear();
  const { summary } = await runPoll({ env: ENV, fetchImpl: wire(sauce, linear), nowMs: NOW, log: quiet });

  assert.equal(summary, "0 created, 0 commented, 0 already recorded, 2 skipped, 0 errors");
  assert.equal(linear.issues.length, 0);
});

test("poller: the job record wins over the slim list entry (tags are only on the record)", async () => {
  // The list endpoint drops tags; without the record re-read this would be filed.
  const sauce = createMockSauce([failedJob("q", 2, { tags: ["quarantine"] })]);
  const linear = createMockLinear();
  const { results } = await runPoll({ env: ENV, fetchImpl: wire(sauce, linear), nowMs: NOW, log: quiet });
  assert.equal(results[0].action, "skipped");
});

test("poller: a job not yet marked failed is skipped now and filed by a later poll", async () => {
  // The pytest reporter marks the job failed moments after it ends.
  const job = failedJob("late", 1, { passed: null, status: "complete", consolidated_status: "complete" });
  const sauce = createMockSauce([job]);
  const linear = createMockLinear();
  const fetchImpl = wire(sauce, linear);

  const first = await runPoll({ env: ENV, fetchImpl, nowMs: NOW, log: quiet });
  assert.equal(first.results[0].action, "skipped");

  job.passed = false;
  const second = await runPoll({ env: ENV, fetchImpl, nowMs: NOW + 5 * MIN, log: quiet });
  assert.equal(second.results[0].action, "created");
});

test("poller: DRY_RUN triages and writes nothing to Linear", async () => {
  const sauce = createMockSauce([failedJob("f1", 3)]);
  const linear = createMockLinear();
  const env = { ...ENV, DRY_RUN: "true", LINEAR_API_KEY: "", LINEAR_TEAM_ID: "" };
  const { summary, results } = await runPoll({ env, fetchImpl: wire(sauce, linear), nowMs: NOW, log: quiet });

  assert.equal(summary, "1 would be filed, 0 skipped, 0 errors");
  assert.match(results[0].title, /^\[Regression\] test_checkout_payment_declined/);
  assert.equal(linear.calls.length, 0);
});

test("poller: one bad job is reported as an error without stopping the others", async () => {
  const sauce = createMockSauce([failedJob("ok", 2), failedJob("boom", 3, { name: "test_other — TypeError: x" })]);
  const linear = createMockLinear();
  const flaky = (url, options) => {
    if (String(url).includes("api.linear.app") && String(options.body).includes("test_other")) throw new Error("Linear down");
    return wire(sauce, linear)(url, options);
  };
  const { results } = await runPoll({ env: ENV, fetchImpl: flaky, nowMs: NOW, log: quiet });
  const byJob = Object.fromEntries(results.map((r) => [r.jobId, r.action]));
  assert.equal(byJob.ok, "created");
  assert.equal(byJob.boom, "error");
});

test("listRecentJobs: pages until the window is passed, then stops", async () => {
  const jobs = [];
  for (let i = 0; i < 250; i++) jobs.push(passedJob(`j${i}`, i)); // one per minute, newest first
  const sauce = createMockSauce(jobs);
  const out = await listRecentJobs({ username: "u", accessKey: "k", sinceMs: NOW - 30 * MIN, fetchImpl: sauce.fetchImpl, pageSize: 20 });

  assert.equal(out.length, 31, "minutes 0..30 inclusive");
  const pages = sauce.calls.filter((c) => c.path === "/v1/rdc/jobs").length;
  assert.ok(pages < 13, `should stop well before paging all 250 jobs (made ${pages} calls)`);
});

test("listRecentJobs: starts at offset 1 (the endpoint is 1-indexed and 500s on offset=0)", async () => {
  const sauce = createMockSauce([failedJob("a", 1), failedJob("b", 2)]);
  const out = await listRecentJobs({ username: "u", accessKey: "k", sinceMs: NOW - 30 * MIN, fetchImpl: sauce.fetchImpl });
  assert.deepEqual(out.map((j) => j.id).sort(), ["a", "b"]);
  assert.match(sauce.calls[0].search, /offset=1\b/);
});

test("listRecentJobs: keeps paging on a full page even when moreAvailable says false", async () => {
  const jobs = [];
  for (let i = 0; i < 50; i++) jobs.push(passedJob(`j${i}`, i));
  const sauce = createMockSauce(jobs, { reportMore: false });
  const out = await listRecentJobs({ username: "u", accessKey: "k", sinceMs: NOW - 30 * MIN, fetchImpl: sauce.fetchImpl, pageSize: 20 });
  assert.equal(out.length, 31);
});

test("listRecentJobs: bad credentials fail loudly instead of looking like a quiet window", async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({}) });
  await assert.rejects(
    listRecentJobs({ username: "u", accessKey: "bad", sinceMs: 0, fetchImpl }),
    /HTTP 401/
  );
});

test("readConfig: names every missing variable, and DRY_RUN needs no Linear secrets", () => {
  assert.throws(() => readConfig({}), /SAUCE_USERNAME, SAUCE_ACCESS_KEY, LINEAR_API_KEY, LINEAR_TEAM_ID/);
  const cfg = readConfig({ SAUCE_USERNAME: "u", SAUCE_ACCESS_KEY: "k", DRY_RUN: "true" });
  assert.equal(cfg.dryRun, true);
  assert.equal(cfg.lookbackMinutes, 30);
  assert.equal(cfg.region, "us-west-1");
  assert.deepEqual(cfg.flakyTags, ["flaky", "quarantine", "known-flaky"]);
});

test("readConfig: empty strings from unset GitHub vars fall back to defaults", () => {
  const cfg = readConfig({ ...ENV, SAUCE_REGION: "", SAUCE_FLAKY_TAGS: "", LINEAR_ISSUE_LABELS: "", SAUCE_LOOKBACK_MINUTES: "" });
  assert.equal(cfg.region, "us-west-1");
  assert.equal(cfg.lookbackMinutes, 30);
  assert.equal(cfg.labelNames.length, 3);
});

test("isClearlyPassed: only explicit passes skip the record fetch", () => {
  assert.equal(isClearlyPassed({ consolidated_status: "passed" }), true);
  assert.equal(isClearlyPassed({ status: "complete" }), false);
  assert.equal(isClearlyPassed({ consolidated_status: "failed" }), false);
});

test("linearAuthHeader: personal API keys go bare, OAuth tokens as Bearer", async () => {
  const { linearAuthHeader } = await import("../sauce-to-linear.step.mjs");
  assert.equal(linearAuthHeader("lin_api_abc"), "lin_api_abc");
  assert.equal(linearAuthHeader("oauth-token-xyz"), "Bearer oauth-token-xyz");
});
