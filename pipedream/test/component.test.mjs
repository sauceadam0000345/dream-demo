/**
 * Runs the exact code that gets pasted into Pipedream — the component's run()
 * — against a mock Linear API and a simulated Pipedream trigger event.
 */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

import component, { readMeta } from "../sauce-to-linear.step.mjs";
import { createMockLinear } from "./mock-linear.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (n) => JSON.parse(readFileSync(join(here, "..", "fixtures", n), "utf8"));

const TEAM = "3cad1481-1026-4b67-b73a-d6e86c856ea4";

/** Drive component.run() the way Pipedream does. */
async function runStep({ body, headers = {}, query = {}, env = {}, mock }) {
  const savedFetch = globalThis.fetch;
  const savedEnv = { ...process.env };
  globalThis.fetch = mock.fetchImpl;
  Object.assign(process.env, env);

  const exports = {};
  let exited = null;
  const $ = {
    export: (k, v) => { exports[k] = v; },
    flow: { exit: (reason) => { exited = reason; return { exited: reason }; } },
  };

  const context = {
    linear: { $auth: { oauth_access_token: "lin_oauth_fake" } },
    teamId: TEAM,
  };

  try {
    const result = await component.run.call(context, { steps: { trigger: { event: { body, headers, query } } }, $ });
    return { result, exports, exited };
  } finally {
    globalThis.fetch = savedFetch;
    for (const k of Object.keys(env)) delete process.env[k];
    Object.assign(process.env, savedEnv);
  }
}

test("end-to-end: a real failure files one issue, a repeat comments on it", async () => {
  const mock = createMockLinear();
  const job = fixture("rdc-failed.json");

  const first = await runStep({ body: job, mock });
  assert.equal(first.result.results[0].action, "created");
  assert.equal(first.exports.$summary, "1 created, 0 updated, 0 skipped");

  const second = await runStep({ body: { ...job, id: "job2", build: "build-483" }, mock });
  assert.equal(second.result.results[0].action, "commented");
  assert.equal(second.exports.$summary, "0 created, 1 updated, 0 skipped");

  assert.equal(mock.issues.length, 1);
  assert.equal(mock.comments.length, 1);
  assert.equal(readMeta(mock.issues[0].description).occurrences, 2);
});

test("end-to-end: passing, flaky and infra events file nothing", async () => {
  const mock = createMockLinear();

  for (const f of ["rdc-passed.json", "rdc-flaky.json", "rdc-infra.json"]) {
    const { result, exports } = await runStep({ body: fixture(f), mock });
    assert.equal(result.results[0].action, "skipped", `${f} should be skipped`);
    assert.equal(exports.$summary, "0 created, 0 updated, 0 skipped".replace("0 skipped", "1 skipped"));
  }
  assert.equal(mock.issues.length, 0, "no issues filed for non-actionable events");
});

test("end-to-end: a batched payload is handled job by job", async () => {
  const mock = createMockLinear();
  const failed = fixture("rdc-failed.json");
  const body = [failed, fixture("rdc-passed.json"), { ...failed, name: "test_add_to_cart", error: "NoSuchElementException: #cart not found" }];

  const { result, exports } = await runStep({ body, mock });

  assert.equal(result.results.length, 3);
  assert.equal(exports.$summary, "2 created, 0 updated, 1 skipped");
  assert.equal(mock.issues.length, 2);
});

test("end-to-end: signature is verified when a secret is configured", async () => {
  const mock = createMockLinear();
  const job = fixture("rdc-failed.json");
  const secret = "sauce-signing-secret";
  const good = crypto.createHmac("sha256", secret).update(JSON.stringify(job)).digest("hex");

  const ok = await runStep({ body: job, headers: { "saucelabs-sign": good }, env: { SAUCE_WEBHOOK_SECRET: secret }, mock });
  assert.equal(ok.exports.signature.valid, true);
  assert.equal(ok.result.results[0].action, "created");

  const bad = await runStep({ body: { ...job, id: "job-bad-sig" }, headers: { "saucelabs-sign": "nope" }, env: { SAUCE_WEBHOOK_SECRET: secret }, mock });
  assert.equal(bad.exports.signature.valid, false);
  assert.equal(bad.result.results[0].action, "commented", "warn-only by default: still processes");
});

test("end-to-end: SAUCE_ENFORCE_SIGNATURE=true rejects a bad signature", async () => {
  const mock = createMockLinear();
  await assert.rejects(
    () => runStep({
      body: fixture("rdc-failed.json"),
      headers: { "saucelabs-sign": "nope" },
      env: { SAUCE_WEBHOOK_SECRET: "s", SAUCE_ENFORCE_SIGNATURE: "true" },
      mock,
    }),
    /Rejecting webhook/
  );
  assert.equal(mock.issues.length, 0);
});

test("end-to-end: an empty payload exits cleanly", async () => {
  const mock = createMockLinear();
  const { exited } = await runStep({ body: null, mock });
  assert.match(String(exited), /no job payload/);
  assert.equal(mock.issues.length, 0);
});

test("end-to-end: SAUCE_FLAKY_TAGS is honoured from the environment", async () => {
  const mock = createMockLinear();
  const job = { ...fixture("rdc-failed.json"), tags: ["checkout", "wip"] };

  const off = await runStep({ body: job, mock });
  assert.equal(off.result.results[0].action, "created");

  const on = await runStep({ body: { ...job, id: "job2" }, env: { SAUCE_FLAKY_TAGS: "wip,flaky" }, mock });
  assert.equal(on.result.results[0].action, "skipped");
});


test("end-to-end: an UNSIGNED webhook is accepted even with enforcement on (Sauce sends no saucelabs-sign)", async () => {
  const mock = createMockLinear();
  const r = await runStep({ body: fixture("rdc-failed.json"), env: { SAUCE_WEBHOOK_SECRET: "s", SAUCE_ENFORCE_SIGNATURE: "true" }, mock });
  assert.equal(r.result.results[0].action, "created");
  assert.equal(r.exports.signature.valid, false, "recorded as unsigned, but not fatal");
});

test("end-to-end: URL token is the enforceable check", async () => {
  const mock = createMockLinear();
  const env = { SAUCE_WEBHOOK_TOKEN: "t0k3n" };

  const ok = await runStep({ body: fixture("rdc-failed.json"), query: { token: "t0k3n" }, env, mock });
  assert.equal(ok.exports.url_token.valid, true);
  assert.equal(ok.result.results[0].action, "created");

  await assert.rejects(() => runStep({ body: fixture("rdc-failed.json"), query: {}, env, mock }), /wrong \?token/);
  await assert.rejects(() => runStep({ body: fixture("rdc-failed.json"), query: { token: "nope" }, env, mock }), /wrong \?token/);
  assert.equal(mock.issues.length, 1, "rejected calls filed nothing");
});


test("end-to-end: with ?pipedream_upload_body=1 the HMAC verifies over the exact raw bytes", async () => {
  const mock = createMockLinear();
  const job = fixture("rdc-failed.json");
  // Sauce serialises however it likes — spaces, key order — and signs THOSE bytes.
  const raw = JSON.stringify(job, null, 2);
  const secret = "6099770330";
  const sign = crypto.createHmac("sha256", secret).update(raw).digest("hex");

  const savedFetch = globalThis.fetch;
  const stubbed = async (url, opts) => {
    if (String(url).startsWith("https://s3.example/raw")) return { text: async () => raw };
    return mock.fetchImpl(url, opts);
  };
  const mock2 = { fetchImpl: stubbed, issues: mock.issues, comments: mock.comments };

  const r = await runStep({
    body: { raw_body_url: "https://s3.example/raw/abc" },
    headers: { "saucelabs-sign": sign },
    env: { SAUCE_WEBHOOK_SECRET: secret, SAUCE_ENFORCE_SIGNATURE: "true" },
    mock: mock2,
  });
  globalThis.fetch = savedFetch;

  assert.equal(r.exports.signature.valid, true, "verified over raw bytes");
  assert.equal(r.exports.signature.rawSource, "raw_body_url");
  assert.equal(r.result.results[0].action, "created", "body was re-parsed from the raw bytes and processed");

  // Same setup, tampered signature -> rejected, nothing filed.
  await assert.rejects(() => runStep({
    body: { raw_body_url: "https://s3.example/raw/abc" },
    headers: { "saucelabs-sign": "0".repeat(64) },
    env: { SAUCE_WEBHOOK_SECRET: secret, SAUCE_ENFORCE_SIGNATURE: "true" },
    mock: mock2,
  }), /signature mismatch/);
  assert.equal(mock.issues.length, 1);
});

test("end-to-end: without raw bytes the step says so instead of pretending", async () => {
  const mock = createMockLinear();
  const r = await runStep({ body: fixture("rdc-failed.json"), env: { SAUCE_WEBHOOK_SECRET: "s" }, mock });
  assert.match(r.exports.signature.rawSource, /reserialised/);
  assert.equal(r.result.results[0].action, "created");
});

test("end-to-end: the job record wins over a stale webhook snapshot", async () => {
  const mock = createMockLinear();
  // Webhook snapshot: bare name, no tags - exactly what Sauce sent on 2026-09-20.
  const stale = { ...fixture("rdc-real-webhook.json"), name: "test_checkout_payment_declined", tags: [] };
  // Job record moments later: carries the reason.
  const record = {
    id: stale.id, name: "test_checkout_payment_declined — Failed: AssertionError: Expected checkout confirmation screen but found error banner 'Payment declined'",
    tags: ["err:Failed"], passed: false, status: "failed", consolidated_status: "failed",
    device_name: "Google Pixel 8", os: "Android", os_version: "14", build: "webhook-demo-001755",
    automation_backend: "appium", device_type: "real_device", manual: false,
  };

  const savedFetch = globalThis.fetch;
  const stubbed = async (url, opts) => {
    if (String(url).includes("/v1/rdc/jobs/")) return { ok: true, json: async () => record };
    return mock.fetchImpl(url, opts);
  };

  const r = await runStep({ body: stale, env: { SAUCE_USERNAME: "u", SAUCE_ACCESS_KEY: "k" }, mock: { fetchImpl: stubbed, issues: mock.issues, comments: mock.comments } });
  globalThis.fetch = savedFetch;

  assert.equal(r.result.results[0].action, "created");
  const issue = mock.issues[0];
  assert.match(issue.title, /— AssertionError on Google Pixel 8 \/ Android 14/, "reason recovered from the record");
  assert.match(issue.description, /Payment declined/);
  assert.match(issue.description, /\*\*Test:\*\* test_checkout_payment_declined\n/, "bare test name in the field");
  assert.match(issue.description, /\*\*Build:\*\* webhook-demo-001755/);
});

test("end-to-end: no Sauce credentials degrades gracefully to the webhook payload", async () => {
  const mock = createMockLinear();
  const r = await runStep({ body: fixture("rdc-real-webhook.json"), mock });
  assert.equal(r.result.results[0].action, "created");
  assert.match(r.exports.enrichment, /not set/);
});
