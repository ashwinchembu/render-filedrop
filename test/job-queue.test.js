import assert from "node:assert/strict";
import test from "node:test";
import {
  claimJob,
  enqueueJob,
  heartbeatJob,
  recoverStaleJobs,
  transitionJob
} from "../src/job-queue.js";

const t0 = new Date("2026-08-03T20:00:00.000Z");

test("deduplicates reminders by stable key", () => {
  const meta = {};
  const first = enqueueJob(meta, { dedupeKey: "daily-report:2026-08-03", title: "Daily report" }, t0);
  const second = enqueueJob(meta, { dedupeKey: "daily-report:2026-08-03", title: "Reminder" }, t0);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.job.id, second.job.id);
  assert.equal(meta.jobs.length, 1);
});

test("enforces claim ownership, heartbeats, and lifecycle", () => {
  const meta = {};
  const { job } = enqueueJob(meta, { id: "job-1", dedupeKey: "job-1", title: "Test" }, t0);
  claimJob(meta, { id: job.id, device: "mac-mini", session: "session-a", leaseSeconds: 60 }, t0);
  assert.equal(job.state, "claimed");
  transitionJob(meta, { id: job.id, device: "mac-mini", session: "session-a", state: "in_progress" }, t0);
  const heartbeatAt = new Date(t0.getTime() + 30_000);
  heartbeatJob(meta, { id: job.id, device: "mac-mini", session: "session-a", leaseSeconds: 120 }, heartbeatAt);
  assert.equal(job.lease.expiresAt, "2026-08-03T20:02:30.000Z");
  assert.throws(
    () => transitionJob(meta, { id: job.id, device: "macbook", session: "session-b", state: "completed" }),
    /owned by another/
  );
  transitionJob(meta, {
    id: job.id,
    device: "mac-mini",
    session: "session-a",
    state: "completed",
    outputs: {
      status: "done",
      links: [{ label: "result", url: "https://example.com/result" }],
      files: [{ fileId: "file-1", checksum: "sha256:abc" }],
      screenshots: [{ fileId: "shot-1" }]
    }
  }, heartbeatAt);
  assert.equal(job.state, "completed");
  assert.equal(job.outputs.files[0].fileId, "file-1");
});

test("recovers stale leases and blocks exhausted attempts", () => {
  const meta = {};
  const { job } = enqueueJob(meta, { id: "retry-job", dedupeKey: "retry-job", maxAttempts: 2 }, t0);
  claimJob(meta, { id: job.id, device: "remote", session: "one", leaseSeconds: 1 }, t0);
  let recovered = recoverStaleJobs(meta, new Date(t0.getTime() + 2_000));
  assert.equal(recovered[0].state, "queued");
  claimJob(meta, { id: job.id, device: "remote", session: "two", leaseSeconds: 1 }, new Date(t0.getTime() + 3_000));
  recovered = recoverStaleJobs(meta, new Date(t0.getTime() + 5_000));
  assert.equal(recovered[0].state, "blocked");
  assert.match(job.blockedReason, /maximum attempts/);
});

test("rejects credentials in payloads and outputs", () => {
  assert.throws(
    () => enqueueJob({}, { dedupeKey: "bad", payload: { apiKey: "do-not-store" } }, t0),
    /Credentials are not allowed/
  );
  const meta = {};
  const { job } = enqueueJob(meta, { id: "safe", dedupeKey: "safe" }, t0);
  claimJob(meta, { id: job.id, device: "mini", session: "s" }, t0);
  transitionJob(meta, { id: job.id, device: "mini", session: "s", state: "in_progress" }, t0);
  assert.throws(
    () => transitionJob(meta, { id: job.id, device: "mini", session: "s", state: "completed", outputs: { data: { password: "no" } } }),
    /Credentials are not allowed/
  );
});
