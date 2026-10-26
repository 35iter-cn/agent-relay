import test from "node:test";
import assert from "node:assert/strict";
import { emptyState } from "../src/state/schema.mjs";
import { JOB_RETENTION_MS, MAX_JOBS, pruneState } from "../src/state/prune.mjs";
import { createJob } from "../src/jobs/model.mjs";

const now = Date.parse("2026-10-26T12:00:00Z");
const ago = (ms) => new Date(now - ms).toISOString();

function job(state, key, status, updatedAt) {
  const created = createJob(state, { key, session: `fs-${key}`, dedupeId: `d-${key}-${status}`, text: "hi" });
  const stored = { ...created, status, updatedAt };
  state.jobs[stored.id] = stored;
  return stored;
}

function base() {
  const state = emptyState();
  const done = job(state, "th-old", "done", ago(JOB_RETENTION_MS + 86_400_000));
  const fresh = job(state, "th-new", "done", ago(60_000));
  const running = job(state, "th-run", "running", ago(JOB_RETENTION_MS * 2));
  const queued = job(state, "th-queue", "queued", ago(JOB_RETENTION_MS * 2));
  const answered = job(state, "th-answer", "answered", ago(JOB_RETENTION_MS * 2));
  state.inbox.push(queued.id);
  state.convs["th-run"] = { session: "fs-th-run", rootText: "x", activeJob: running.id };
  state.seen["d-th-old-done"] = done.id;
  return { state, done, fresh, running, queued, answered };
}

test("pruneState drops finished jobs past the retention window, keeps answered and the rest", () => {
  const { state, done, fresh, running, queued, answered } = base();
  const dropped = pruneState(state, now);
  assert.equal(dropped, 1);
  assert.equal(state.jobs[done.id], undefined);
  assert.ok(state.jobs[answered.id], "answered is still in the delivery flow, never pruned");
  assert.ok(state.jobs[fresh.id]);
  assert.ok(state.jobs[running.id]);
  assert.ok(state.jobs[queued.id]);
});

test("pruneState keeps unfinished jobs and anything still queued or active", () => {
  const { state } = base();
  pruneState(state, now);
  assert.equal(state.inbox.length, 1);
  assert.equal(state.convs["th-run"].activeJob, Object.values(state.jobs).find((item) => item.status === "running").id);
});

test("pruneState rewrites a seen pointer whose job is gone into a terminal marker", () => {
  const { state, done } = base();
  pruneState(state, now);
  assert.equal(state.jobs[done.id], undefined);
  assert.equal(state.seen["d-th-old-done"], "legacy");
});

test("pruneState caps the table at maxJobs, oldest finished first", () => {
  const state = emptyState();
  for (let i = 0; i < 8; i += 1) job(state, `th-${i}`, "done", ago((10 - i) * 60_000));
  const dropped = pruneState(state, now, { jobRetentionMs: JOB_RETENTION_MS, maxJobs: 5 });
  assert.equal(dropped, 3);
  assert.equal(Object.keys(state.jobs).length, 5);
  assert.equal(Object.values(state.jobs).some((item) => item.key === "th-0"), false);
  assert.equal(Object.values(state.jobs).some((item) => item.key === "th-7"), true);
});

test("pruneState never drops the table below maxJobs when unfinished jobs dominate", () => {
  const state = emptyState();
  for (let i = 0; i < 4; i += 1) job(state, `th-run-${i}`, "running", ago(i * 1000));
  assert.equal(pruneState(state, now, { maxJobs: 1 }), 0);
  assert.equal(Object.keys(state.jobs).length, 4);
  assert.equal(MAX_JOBS, 2000);
});
