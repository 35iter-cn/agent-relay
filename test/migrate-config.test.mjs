import test from "node:test";
import assert from "node:assert/strict";
import { emptyState } from "../src/state/schema.mjs";
import { createJob } from "../src/jobs/model.mjs";
import { dropInflight } from "../scripts/migrate-config.mjs";

function stateWith() {
  const state = emptyState();
  const add = (key, status) => {
    const job = createJob(state, { key, session: `fs-${key}`, dedupeId: `d-${key}`, text: "x" });
    job.status = status;
    state.jobs[job.id] = job;
    state.seen[job.inbound.dedupeId] = job.id;
    return job;
  };
  const running = add("th-1", "running");
  const queued = add("th-2", "queued");
  const answered = add("th-3", "answered");
  const done = add("th-4", "done");
  add("th-5", "interrupted");
  state.inbox.push(queued.id);
  state.convs["th-1"] = { session: "fs-th-1", activeJob: running.id };
  return { state, running, queued, answered, done };
}

test("dropInflight removes running, queued and answered jobs and cleans pointers", () => {
  const { state, running, queued, answered, done } = stateWith();
  assert.equal(dropInflight(state), 3);
  assert.equal(state.jobs[running.id], undefined);
  assert.equal(state.jobs[queued.id], undefined);
  assert.equal(state.jobs[answered.id], undefined);
  assert.ok(state.jobs[done.id]);
  assert.equal(state.inbox.length, 0);
  assert.equal(state.seen["d-th-1"], "legacy");
  assert.equal(state.convs["th-1"].activeJob, null);
});

test("dropInflight keeps terminal statuses untouched", () => {
  const { state } = stateWith();
  dropInflight(state);
  const statuses = Object.values(state.jobs).map((job) => job.status).sort();
  assert.deepEqual(statuses, ["done", "interrupted"]);
});
