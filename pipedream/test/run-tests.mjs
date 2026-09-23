import test from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

import {
  buildFingerprint, classifyFailure, normalizeError, majorVersion, slug,
  readMeta, upsertMeta, upsertTracking, verifySignature, sauceJobUrl,
  buildTitle, extractJobs, processFailure, findExistingIssue,
} from "../sauce-to-linear.step.mjs";
import { createMockLinear } from "./mock-linear.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (n) => JSON.parse(readFileSync(join(here, "..", "fixtures", n), "utf8"));

const TEAM = "3cad1481-1026-4b67-b73a-d6e86c856ea4";
const TOKEN = "lin_oauth_fake";

/* ---------------- fingerprint ---------------- */

test("fingerprint is stable across runs of the same failure", () => {
  const a = fixture("rdc-failed.json");
  const b = { ...a, id: "different-job-id", build: "build-999", creation_time: "2026-09-20T01:00:00Z" };
  assert.equal(buildFingerprint(a), buildFingerprint(b));
});

test("fingerprint ignores minor OS version drift", () => {
  const a = fixture("rdc-failed.json");
  const b = { ...a, os_version: "14.2" };
  assert.equal(buildFingerprint(a), buildFingerprint(b));
});

test("fingerprint changes across device", () => {
  const a = fixture("rdc-failed.json");
  const b = { ...a, device: "Samsung Galaxy S24" };
  assert.notEqual(buildFingerprint(a), buildFingerprint(b));
});

test("fingerprint changes across a different failure mode", () => {
  const a = fixture("rdc-failed.json");
  const b = { ...a, error: "NoSuchElementException: #place-order not found", exception: "" };
  assert.notEqual(buildFingerprint(a), buildFingerprint(b));
});

test("fingerprint is human-readable at the front", () => {
  assert.match(buildFingerprint(fixture("rdc-failed.json")), /^test-checkout-complete-purchase:google-pixel-8:android-14:[0-9a-f]{8}$/);
});

test("normalizeError strips run-specific noise", () => {
  assert.equal(
    normalizeError("Timeout after 4213ms waiting for 0xAF31 session 550e8400-e29b-41d4-a716-446655440000"),
    "Timeout after ms waiting for session"
  );
});

test("majorVersion + slug helpers", () => {
  assert.equal(majorVersion("14.2.1"), "14");
  assert.equal(majorVersion(null), "");
  assert.equal(slug("Google Pixel 8!"), "google-pixel-8");
});

/* ---------------- classification ---------------- */

test("a real assertion failure is actionable", () => {
  const v = classifyFailure(fixture("rdc-failed.json"));
  assert.equal(v.actionable, true);
});

test("a passing test is not actionable", () => {
  const v = classifyFailure(fixture("rdc-passed.json"));
  assert.equal(v.actionable, false);
  assert.match(v.reason, /not a failure/);
});

test("a flaky-tagged failure is not actionable", () => {
  const v = classifyFailure(fixture("rdc-flaky.json"));
  assert.equal(v.actionable, false);
  assert.match(v.reason, /known-flaky/);
});

test("an infrastructure failure is not actionable", () => {
  const v = classifyFailure(fixture("rdc-infra.json"));
  assert.equal(v.actionable, false);
  assert.match(v.reason, /infrastructure/);
});

test("flaky tag list is configurable", () => {
  const job = { ...fixture("rdc-failed.json"), tags: ["wip"] };
  assert.equal(classifyFailure(job).actionable, true);
  assert.equal(classifyFailure(job, { flakyTags: ["wip"] }).actionable, false);
});

/* ---------------- signature ---------------- */

test("valid signature passes, tampered fails, no secret skips", () => {
  const body = { a: 1 };
  const raw = JSON.stringify(body);
  const secret = "s3cr3t";
  const good = crypto.createHmac("sha256", secret).update(raw).digest("hex");

  assert.equal(verifySignature({ rawBody: raw, signature: good, secret }).valid, true);
  assert.equal(verifySignature({ rawBody: raw, signature: `sha256=${good}`, secret }).valid, true);
  assert.equal(verifySignature({ rawBody: raw, signature: "deadbeef", secret }).valid, false);
  assert.equal(verifySignature({ rawBody: raw, signature: undefined, secret }).valid, false);
  assert.equal(verifySignature({ rawBody: raw, signature: good, secret: "" }).checked, false);
});

/* ---------------- metadata round-trip ---------------- */

test("occurrence metadata survives a description round-trip", () => {
  const meta = { fingerprint: "fp:123", occurrences: 3, firstSeen: "a", lastSeen: "b", latestBuild: "c", latestCommit: "d", latestJobUrl: "e" };
  const desc = upsertTracking(upsertMeta("Some body text", meta), meta);
  assert.deepEqual(readMeta(desc), meta);

  const next = { ...meta, occurrences: 4 };
  const desc2 = upsertMeta(upsertTracking(desc, next), next);
  assert.equal(readMeta(desc2).occurrences, 4);
  assert.equal((desc2.match(/sauce-meta/g) || []).length, 1, "exactly one meta block");
  assert.equal((desc2.match(/## Failure tracking/g) || []).length, 1, "exactly one tracking block");
  assert.match(desc2, /\*\*Occurrences:\*\* 4/);
});

/* ---------------- misc ---------------- */

test("sauce job url is region aware", () => {
  assert.equal(sauceJobUrl({ id: "abc" }), "https://app.saucelabs.com/tests/abc");
  assert.equal(sauceJobUrl({ id: "abc" }, "eu-central-1"), "https://app.eu-central-1.saucelabs.com/tests/abc");
});

test("title reads like a defect, not a log line", () => {
  assert.equal(
    buildTitle(fixture("rdc-failed.json")),
    "[Regression] test_checkout_complete_purchase — AssertionError on Google Pixel 8 / Android 14.0"
  );
});

test("a reason carried in the job name does not bloat the title, Test field or fingerprint", async () => {
  const { splitName, errorClass } = await import("../sauce-to-linear.step.mjs");
  const job = fixture("rdc-job-object-failed.json");

  assert.equal(
    buildTitle(job),
    "[Regression] test_checkout_payment_declined — AssertionError on Google Pixel 8 / Android 14"
  );
  assert.equal(splitName(job.name).testName, "test_checkout_payment_declined");
  assert.match(splitName(job.name).reason, /^AssertionError: Expected checkout/);
  assert.equal(errorClass("java.lang.AssertionError: boom"), "AssertionError");
  assert.equal(errorClass("Failed: could not log in"), "Failed: could not log");
  assert.match(buildFingerprint(job), /^test-checkout-payment-declined:google-pixel-8:android-14:[0-9a-f]{8}$/);
});

test("the description's Test and Tags lines stay clean when the reason rides in name/tags", async () => {
  const { createMockLinear: mk } = await import("./mock-linear.mjs");
  const mock = mk();
  await processFailure({ job: fixture("rdc-job-object-failed.json"), teamId: TEAM, token: TOKEN, fetchImpl: mock.fetchImpl });
  const desc = mock.issues[0].description;
  assert.match(desc, /\*\*Test:\*\* test_checkout_payment_declined\n/);
  assert.match(desc, /\*\*Tags:\*\* —/, "failure: carrier tag is hidden");
  assert.match(desc, /```\nAssertionError: Expected checkout/, "reason still shown in the Failure block");
});

test("extractJobs handles single object, array and wrapped batches", () => {
  assert.equal(extractJobs({ id: 1 }).length, 1);
  assert.equal(extractJobs([{ id: 1 }, { id: 2 }]).length, 2);
  assert.equal(extractJobs({ events: [{ id: 1 }] }).length, 1);
  assert.equal(extractJobs(null).length, 0);
});

/* ---------------- full flow against mock Linear ---------------- */

test("first failure creates an issue with labels", async () => {
  const mock = createMockLinear();
  const r = await processFailure({ job: fixture("rdc-failed.json"), teamId: TEAM, token: TOKEN, region: "us-west-1", fetchImpl: mock.fetchImpl });

  assert.equal(r.action, "created");
  assert.equal(r.occurrences, 1);
  assert.equal(r.labelsApplied, 3);
  assert.equal(mock.issues.length, 1);
  assert.match(mock.issues[0].description, /Payment declined/);
  assert.match(mock.issues[0].description, /sauce-meta/);
});

test("the same failure again comments instead of filing a duplicate", async () => {
  const mock = createMockLinear();
  const job = fixture("rdc-failed.json");

  const first = await processFailure({ job, teamId: TEAM, token: TOKEN, fetchImpl: mock.fetchImpl });
  const second = await processFailure({ job: { ...job, id: "job2", build: "build-483" }, teamId: TEAM, token: TOKEN, fetchImpl: mock.fetchImpl });
  const third = await processFailure({ job: { ...job, id: "job3", build: "build-484" }, teamId: TEAM, token: TOKEN, fetchImpl: mock.fetchImpl });

  assert.equal(first.action, "created");
  assert.equal(second.action, "commented");
  assert.equal(third.action, "commented");
  assert.equal(mock.issues.length, 1, "still exactly one issue");
  assert.equal(mock.comments.length, 2);
  assert.equal(third.occurrences, 3);
  assert.equal(second.issue.identifier, first.issue.identifier);

  const desc = mock.issues[0].description;
  assert.equal(readMeta(desc).occurrences, 3);
  assert.equal(readMeta(desc).latestBuild, "build-484");
  assert.match(desc, /\*\*Occurrences:\*\* 3/);
  assert.match(mock.comments[1].body, /Occurrence:\*\* 3/);
});

test("a different failure files its own issue", async () => {
  const mock = createMockLinear();
  const job = fixture("rdc-failed.json");

  await processFailure({ job, teamId: TEAM, token: TOKEN, fetchImpl: mock.fetchImpl });
  const other = await processFailure({
    job: { ...job, name: "test_add_to_cart", error: "NoSuchElementException: #cart-button not found" },
    teamId: TEAM, token: TOKEN, fetchImpl: mock.fetchImpl,
  });

  assert.equal(other.action, "created");
  assert.equal(mock.issues.length, 2);
});

test("a regression that reproduces after close is flagged loudly", async () => {
  const mock = createMockLinear();
  const job = fixture("rdc-failed.json");

  await processFailure({ job, teamId: TEAM, token: TOKEN, fetchImpl: mock.fetchImpl });
  mock.issues[0].state = { name: "Done", type: "completed" };

  const again = await processFailure({ job: { ...job, id: "job2" }, teamId: TEAM, token: TOKEN, fetchImpl: mock.fetchImpl });

  assert.equal(again.action, "commented");
  assert.equal(again.reopenedAfterClose, true);
  assert.match(mock.comments[0].body, /after the issue was closed/);
});

test("a canceled duplicate is ignored and a fresh issue is filed", async () => {
  const mock = createMockLinear();
  const job = fixture("rdc-failed.json");

  await processFailure({ job, teamId: TEAM, token: TOKEN, fetchImpl: mock.fetchImpl });
  mock.issues[0].state = { name: "Canceled", type: "canceled" };

  const again = await processFailure({ job: { ...job, id: "job2" }, teamId: TEAM, token: TOKEN, fetchImpl: mock.fetchImpl });
  assert.equal(again.action, "created");
  assert.equal(mock.issues.length, 2);
});

test("missing labels never block issue creation", async () => {
  const mock = createMockLinear({ labels: [] });
  const r = await processFailure({ job: fixture("rdc-failed.json"), teamId: TEAM, token: TOKEN, fetchImpl: mock.fetchImpl });
  assert.equal(r.action, "created");
  assert.equal(r.labelsApplied, 0);
});

/* ---------------- dedupe fallback ---------------- */

test("dedupe falls back to a client-side scan if the description filter is rejected", async () => {
  const { createMockLinear: mk } = await import("./mock-linear.mjs");
  const mock = mk();
  const job = fixture("rdc-failed.json");

  // First failure files the issue normally.
  const first = await processFailure({ job, teamId: TEAM, token: TOKEN, fetchImpl: mock.fetchImpl });
  assert.equal(first.action, "created");
  assert.equal(first.lookupStrategy, "description-filter");

  // Now simulate a Linear schema that rejects the description filter.
  const strict = async (url, options) => {
    const { query } = JSON.parse(options.body);
    if (query.includes("FindByFingerprint")) {
      return { json: async () => ({ errors: [{ message: "Unknown argument 'description' on IssueFilter" }] }) };
    }
    return mock.fetchImpl(url, options);
  };

  const second = await processFailure({ job: { ...job, id: "job2" }, teamId: TEAM, token: TOKEN, fetchImpl: strict });

  assert.equal(second.lookupStrategy, "recent-scan");
  assert.equal(second.action, "commented", "must still dedupe, not file a duplicate");
  assert.equal(mock.issues.length, 1);
  assert.equal(second.occurrences, 2);
});

test("a hard Linear failure surfaces rather than silently filing nothing", async () => {
  const dead = async () => ({ json: async () => ({ errors: [{ message: "Authentication required" }] }) });
  await assert.rejects(
    () => processFailure({ job: fixture("rdc-failed.json"), teamId: TEAM, token: "bad", fetchImpl: dead }),
    /Linear API error/
  );
});

/* ---------------- rendering regressions ---------------- */

test("recurrence comment keeps its blank lines and reads the environment correctly", async () => {
  const { buildRecurrenceComment } = await import("../sauce-to-linear.step.mjs");
  const job = fixture("rdc-failed.json");
  const body = buildRecurrenceComment(job, { occurrences: 2 }, "us-west-1");

  assert.match(body, /Regression reproduced again\.\n\n- \*\*Occurrence:\*\* 2/);
  assert.match(body, /\*\*Environment:\*\* Google Pixel 8 \/ Android 14\.0/);
  assert.match(body, /\n\n```\nAssertionError/);
  assert.doesNotMatch(body, /Android \/ 14/);
});

test("a failure with no error text still produces a clean comment", async () => {
  const { buildRecurrenceComment } = await import("../sauce-to-linear.step.mjs");
  const body = buildRecurrenceComment({ status: "FAILED", device: "Pixel 8" }, { occurrences: 5 }, "us-west-1");
  assert.doesNotMatch(body, /```/);
  assert.match(body, /\*\*Occurrence:\*\* 5/);
});

/* ---------------- failure text recovery (RDC has no error field) ---------------- */

test("deriveFailureText prefers the real error when Sauce supplies one", async () => {
  const { deriveFailureText } = await import("../sauce-to-linear.step.mjs");
  assert.match(deriveFailureText(fixture("rdc-failed.json")), /^AssertionError: Expected checkout/);
});

test("deriveFailureText recovers the reason from a failure: tag", async () => {
  const { deriveFailureText } = await import("../sauce-to-linear.step.mjs");
  const job = { error: "", exception: "", tags: ["checkout", "failure:AssertionError: Login did not navigate to home screen"] };
  assert.equal(deriveFailureText(job), "AssertionError: Login did not navigate to home screen");
});

test("deriveFailureText recovers the reason from the job name suffix", async () => {
  const { deriveFailureText } = await import("../sauce-to-linear.step.mjs");
  const job = { name: "test_login_and_cart — Failed: could not log in within allotted attempts" };
  assert.equal(deriveFailureText(job), "Failed: could not log in within allotted attempts");
});

test("a bare RDC failure with no reason anywhere still files a usable ticket", async () => {
  const { createMockLinear: mk } = await import("./mock-linear.mjs");
  const mock = mk();
  const job = { id: "j1", name: "test_checkout", status: "FAILED", passed: false, device: "Google Pixel 8", os_name: "Android", os_version: "14", error: "", exception: "", tags: [] };

  const r = await processFailure({ job, teamId: TEAM, token: TOKEN, fetchImpl: mock.fetchImpl });
  assert.equal(r.action, "created");
  assert.match(mock.issues[0].description, /No failure text reported\. See the Sauce job/);
});

test("two different failures of one test stay distinct once tags carry the reason", async () => {
  const base = { name: "test_checkout", device: "Google Pixel 8", os_name: "Android", os_version: "14", status: "FAILED" };
  const a = { ...base, tags: ["failure:AssertionError: payment declined"] };
  const b = { ...base, tags: ["failure:NoSuchElementException: #place-order missing"] };
  assert.notEqual(buildFingerprint(a), buildFingerprint(b));
});

/* ---------------- payload shape normalisation ---------------- */

test("the RDC job-object shape normalises to the same canonical fields", async () => {
  const { normalizeJob } = await import("../sauce-to-linear.step.mjs");
  const n = normalizeJob(fixture("rdc-job-object.json"));

  assert.equal(n.device, "Samsung Galaxy S10");
  assert.equal(n.os_name, "Android");
  assert.equal(n.os_version, "10");
  assert.equal(n.owner, "wim.selles");
  assert.equal(n.app, "my-demo-app-android.apk");
  assert.equal(n.data_type, "rdc");
  assert.equal(n.duration_sec, 45, "derived from start_time/end_time");
  assert.equal(n.is_manual, true);
});

test("the webhook shape passes through unchanged", async () => {
  const { normalizeJob } = await import("../sauce-to-linear.step.mjs");
  const n = normalizeJob(fixture("rdc-failed.json"));

  assert.equal(n.device, "Google Pixel 8");
  assert.equal(n.os_name, "Android");
  assert.equal(n.duration_sec, 137);
  assert.equal(n.data_type, "rdc");
  assert.equal(n.is_manual, false);
});

test("normalizeJob is idempotent", async () => {
  const { normalizeJob } = await import("../sauce-to-linear.step.mjs");
  const once = normalizeJob(fixture("rdc-job-object.json"));
  assert.deepEqual(normalizeJob(once), once);
});

test("a live/manual device session never files a defect", () => {
  const v = classifyFailure(fixture("rdc-job-object.json"));
  assert.equal(v.actionable, false);
  assert.match(v.reason, /live\/manual/);
});

test("an RDC job-object failure is actionable despite status 'complete'", () => {
  const v = classifyFailure(fixture("rdc-job-object-failed.json"));
  assert.equal(v.actionable, true, "passed:false must count even when status is 'complete'");
});

test("an RDC job-object failure files a ticket with recovered error text", async () => {
  const { createMockLinear: mk } = await import("./mock-linear.mjs");
  const mock = mk();
  const r = await processFailure({ job: fixture("rdc-job-object-failed.json"), teamId: TEAM, token: TOKEN, fetchImpl: mock.fetchImpl });

  assert.equal(r.action, "created");
  const desc = mock.issues[0].description;
  assert.match(desc, /Payment declined/, "reason recovered from the failure: tag");
  assert.match(desc, /\*\*Device:\*\* Google Pixel 8/);
  assert.match(desc, /\*\*OS:\*\* Android 14/);
  assert.match(desc, /\*\*Duration:\*\* 137s/, "derived from start_time\/end_time");
  assert.match(mock.issues[0].title, /\[Regression\]/);
});

test("both payload shapes of the same failure produce the same fingerprint", () => {
  const webhookShape = {
    name: "test_checkout", device: "Google Pixel 8", os_name: "Android", os_version: "14",
    status: "FAILED", error: "AssertionError: payment declined",
  };
  const jobObjectShape = {
    name: "test_checkout", device_name: "Google Pixel 8", os: "Android", os_version: "14",
    status: "complete", passed: false, device_type: "real_device",
    tags: ["failure:AssertionError: payment declined"],
  };
  assert.equal(buildFingerprint(webhookShape), buildFingerprint(jobObjectShape),
    "the same defect must dedupe across payload shapes");
});

/* ---------------- what actually happened on 2026-09-19 ---------------- */

function memoryStore() {
  const m = new Map();
  return { get: async (k) => m.get(k), set: async (k, v) => { m.set(k, v); }, has: async (k) => m.has(k), keys: async () => [...m.keys()], _m: m };
}

test("the real Sauce webhook payload files a correct ticket", async () => {
  const { createMockLinear: mk } = await import("./mock-linear.mjs");
  const mock = mk();
  const job = fixture("rdc-real-webhook.json");

  assert.equal(classifyFailure(job).actionable, true, "status FAILED with passed:null is a failure");
  const r = await processFailure({ job, teamId: TEAM, token: TOKEN, fetchImpl: mock.fetchImpl });
  assert.equal(r.action, "created");

  const issue = mock.issues[0];
  assert.equal(issue.title, "[Regression] test_checkout_payment_declined on Google Pixel 8 / Android 14");
  assert.match(issue.description, /\*\*OS:\*\* Android 14/, "ANDROID is prettified");
  assert.match(issue.description, /\*\*Sauce job:\*\* https:\/\/app\.saucelabs\.com\/tests\/cf4d9a68/, "uses sl_url from the payload");
  assert.match(issue.description, /No failure text reported/);
});

test("one job delivered three times files exactly one issue (the duplicate we saw)", async () => {
  const { createMockLinear: mk } = await import("./mock-linear.mjs");
  const mock = mk();
  const store = memoryStore();
  const job = fixture("rdc-real-webhook.json");

  const a = await processFailure({ job, teamId: TEAM, token: TOKEN, fetchImpl: mock.fetchImpl, store });
  const b = await processFailure({ job, teamId: TEAM, token: TOKEN, fetchImpl: mock.fetchImpl, store });
  const c = await processFailure({ job, teamId: TEAM, token: TOKEN, fetchImpl: mock.fetchImpl, store });

  assert.equal(a.action, "created");
  assert.equal(b.action, "duplicate-delivery");
  assert.equal(c.action, "duplicate-delivery");
  assert.equal(b.issue.identifier, a.issue.identifier);
  assert.equal(mock.issues.length, 1);
  assert.equal(mock.comments.length, 0, "a re-fire is not a new occurrence");
});

test("a genuinely new job for the same defect still comments (occurrence 2)", async () => {
  const { createMockLinear: mk } = await import("./mock-linear.mjs");
  const mock = mk();
  const store = memoryStore();
  const job = fixture("rdc-real-webhook.json");

  await processFailure({ job, teamId: TEAM, token: TOKEN, fetchImpl: mock.fetchImpl, store });
  const again = await processFailure({ job: { ...job, id: "a-different-job-id" }, teamId: TEAM, token: TOKEN, fetchImpl: mock.fetchImpl, store });

  assert.equal(again.action, "commented");
  assert.equal(again.lookupStrategy, "store", "fingerprint resolved from memory, not a Linear search");
  assert.equal(again.occurrences, 2);
});

test("a cached issue that was since canceled is ignored and a fresh one filed", async () => {
  const { createMockLinear: mk } = await import("./mock-linear.mjs");
  const mock = mk();
  const store = memoryStore();
  const job = fixture("rdc-real-webhook.json");

  await processFailure({ job, teamId: TEAM, token: TOKEN, fetchImpl: mock.fetchImpl, store });
  mock.issues[0].state = { name: "Canceled", type: "canceled" };

  const again = await processFailure({ job: { ...job, id: "job-2" }, teamId: TEAM, token: TOKEN, fetchImpl: mock.fetchImpl, store });
  assert.equal(again.action, "created");
  assert.equal(mock.issues.length, 2);
});

test("with no data store configured everything still works (just without re-fire protection)", async () => {
  const { createMockLinear: mk } = await import("./mock-linear.mjs");
  const mock = mk();
  const job = fixture("rdc-real-webhook.json");
  const a = await processFailure({ job, teamId: TEAM, token: TOKEN, fetchImpl: mock.fetchImpl, store: null });
  const b = await processFailure({ job, teamId: TEAM, token: TOKEN, fetchImpl: mock.fetchImpl, store: null });
  assert.equal(a.action, "created");
  assert.equal(b.action, "already-recorded", "falls back to Linear search; the issue's own jobIds catch a sequential re-fire");
  assert.equal(mock.comments.length, 0, "a re-fire of the same job must not post a recurrence comment");
});

/* ---------------- fingerprint stability across code versions ---------------- */
// The fingerprint is stored inside live Linear issues and in the Pipedream data
// store. If it drifts between code versions, old issues become invisible to
// dedupe and the same defect gets filed again (this happened on 2026-09-19 when
// OS-name prettifying was added before hashing). Any change to this value is a
// migration, not a refactor: bump deliberately and re-key existing issues.

test("GOLDEN: fingerprint of the real 2026-09-19 webhook is pinned", () => {
  assert.equal(
    buildFingerprint(fixture("rdc-real-webhook.json")),
    "test-checkout-payment-declined:google-pixel-8:android-14:c10df175"
  );
});

test("GOLDEN: fingerprint of the synthetic fixture is pinned", () => {
  assert.equal(
    buildFingerprint(fixture("rdc-failed.json")),
    "test-checkout-complete-purchase:google-pixel-8:android-14:c42311b8"
  );
});

test("a short err: tag (Sauce's 30-char limit) still yields an error class, and the name wins when both exist", async () => {
  const { deriveFailureText, buildTitle } = await import("../sauce-to-linear.step.mjs");
  const tagOnly = { name: "test_checkout", tags: ["err:AssertionError"], status: "FAILED", device: "Pixel 8", os_name: "Android", os_version: "14" };
  assert.equal(deriveFailureText(tagOnly), "AssertionError");
  assert.match(buildTitle(tagOnly), /— AssertionError on/);

  const both = { ...tagOnly, name: "test_checkout — AssertionError: Expected confirmation but got 'Payment declined'" };
  assert.match(deriveFailureText(both), /^AssertionError: Expected confirmation/);
});

/* ---------------- concurrency (reproduces SAU-10 / SAU-11) ---------------- */

function slowStore(latencyMs = 5) {
  const m = new Map();
  const wait = () => new Promise((r) => setTimeout(r, latencyMs));
  return {
    get: async (k) => { await wait(); return m.get(k); },
    set: async (k, v) => { await wait(); m.set(k, v); },
    _m: m,
  };
}

function slowLinear(mock, latencyMs = 40) {
  return async (url, opts) => {
    await new Promise((r) => setTimeout(r, latencyMs));
    return mock.fetchImpl(url, opts);
  };
}

test("three simultaneous deliveries of ONE job file exactly one issue", async () => {
  const { createMockLinear: mk } = await import("./mock-linear.mjs");
  const mock = mk();
  const store = slowStore();
  const job = fixture("rdc-real-webhook.json");
  const fetchImpl = slowLinear(mock);

  // Fired together, as Sauce does - previously this produced 2-3 issues.
  const results = await Promise.all([1, 2, 3].map(() =>
    processFailure({ job, teamId: TEAM, token: TOKEN, fetchImpl, store, raceDelayMs: 20 })
  ));

  assert.equal(mock.issues.length, 1, `expected 1 issue, got ${mock.issues.length}`);
  assert.equal(results.filter((r) => r.action === "created").length, 1);
  assert.equal(results.filter((r) => r.action === "duplicate-delivery").length, 2);
});

test("two DIFFERENT jobs failing identically at the same instant file one issue", async () => {
  const { createMockLinear: mk } = await import("./mock-linear.mjs");
  const mock = mk();
  const store = slowStore();
  const base = fixture("rdc-real-webhook.json");
  const fetchImpl = slowLinear(mock);

  const results = await Promise.all([
    processFailure({ job: { ...base, id: "job-aaa" }, teamId: TEAM, token: TOKEN, fetchImpl, store, raceDelayMs: 20 }),
    processFailure({ job: { ...base, id: "job-bbb" }, teamId: TEAM, token: TOKEN, fetchImpl, store, raceDelayMs: 20 }),
  ]);

  assert.equal(mock.issues.length, 1, `expected 1 issue, got ${mock.issues.length}`);
  const actions = results.map((r) => r.action).sort();
  assert.deepEqual(actions, ["commented", "created"], `got ${actions}`);
  assert.equal(readMeta(mock.issues[0].description).occurrences, 2);
});

test("sequential runs still dedupe through the fingerprint cache", async () => {
  const { createMockLinear: mk } = await import("./mock-linear.mjs");
  const mock = mk();
  const store = slowStore();
  const base = fixture("rdc-real-webhook.json");

  const a = await processFailure({ job: { ...base, id: "j1" }, teamId: TEAM, token: TOKEN, fetchImpl: mock.fetchImpl, store, raceDelayMs: 5 });
  const b = await processFailure({ job: { ...base, id: "j2" }, teamId: TEAM, token: TOKEN, fetchImpl: mock.fetchImpl, store, raceDelayMs: 5 });
  assert.equal(a.action, "created");
  assert.equal(b.action, "commented");
  assert.equal(mock.issues.length, 1);
});
