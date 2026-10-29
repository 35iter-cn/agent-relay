import test from "node:test";
import assert from "node:assert/strict";
import { chunkText } from "../src/shared/chunk.mjs";
import { createJob, ctxOf, isFinished } from "../src/jobs/model.mjs";
import { hashOf, planParts } from "../src/jobs/delivery.mjs";
import { mediaHash } from "../src/jobs/media.mjs";
import { isLeaseAlive, readProcStartTicks } from "../src/jobs/lease.mjs";
import { nextAction } from "../src/jobs/next-action.mjs";

const nowIso = () => "2026-10-23T00:00:00.000Z";
const inbound = {
  key: "th-x",
  session: "fs-th-x",
  dedupeId: "om_1",
  text: "hi",
  chatId: "oc_1",
  messageId: "om_1",
  threadId: "om_root",
  rootText: "root",
  authorId: "ou_me",
};

function job(overrides = {}) {
  return { ...createJob({ meta: {} }, inbound, nowIso), ...overrides };
}

test("createJob never reuses an id that already exists in state", () => {
  const state = { meta: {}, jobs: { "job-7": { id: "job-7" } } };
  const job = createJob(state, inbound, nowIso);
  assert.equal(job.id, "job-8");
  assert.equal(state.meta.jobSeq, 8);
});

test("createJob allocates a monotonic sequence and serializable inbound", () => {
  const state = { meta: {} };
  const first = createJob(state, inbound, nowIso);
  const second = createJob(state, inbound, nowIso);
  assert.equal(first.id, "job-1");
  assert.equal(second.id, "job-2");
  assert.equal(first.status, "queued");
  assert.deepEqual(first.parts, []);
  assert.equal(first.answer, null);
  assert.deepEqual(JSON.parse(JSON.stringify(first.inbound)), first.inbound);
});

test("TC-18 nextAction settles every status", () => {
  const opts = { chunkLimit: 10, canEdit: false, readStartTicks: () => "9", probeAlive: () => false };

  assert.deepEqual(nextAction(job({ status: "queued" }), opts), { type: "rerun" });

  const aliveLease = { pid: 42, startTicks: "9" };
  assert.deepEqual(nextAction(job({ status: "running", lease: aliveLease }), opts), { type: "reap-then-interrupt", pid: 42 });

  const goneLease = { pid: 42, startTicks: "9" };
  const goneOpts = { ...opts, probeAlive: () => false, readStartTicks: () => null };
  assert.deepEqual(nextAction(job({ status: "running", lease: goneLease }), goneOpts), { type: "interrupt" });

  const wrongTicks = { pid: 42, startTicks: "8" };
  assert.deepEqual(nextAction(job({ status: "running", lease: wrongTicks }), opts), { type: "interrupt" });

  assert.deepEqual(nextAction(job({ status: "running", lease: null }), opts), { type: "interrupt" });

  const resend = nextAction(job({ status: "answered", answer: "abcdefghijkl" }), opts);
  assert.equal(resend.type, "resend");
  assert.deepEqual(resend.parts, [
    { i: 0, text: "abcdefghij", action: "send" },
    { i: 1, text: "kl", action: "send" },
  ]);

  for (const status of ["done", "interrupted", "failed", "cancelled"]) {
    assert.deepEqual(nextAction(job({ status }), opts), { type: "finish" });
  }
});

test("TC-18 a lease lives or dies on pid identity alone, never on elapsed time", () => {
  const lease = { pid: 42, startTicks: "9" };
  assert.equal(isLeaseAlive(lease, { readStartTicks: () => "9", probeAlive: () => true }), true);
  assert.equal(isLeaseAlive(lease, { readStartTicks: () => "9", probeAlive: () => false }), true);
  assert.equal(isLeaseAlive(lease, { readStartTicks: () => "8", probeAlive: () => true }), false);
  assert.equal(isLeaseAlive(lease, { readStartTicks: () => null, probeAlive: () => true }), true);
  assert.equal(isLeaseAlive(lease, { readStartTicks: () => null, probeAlive: () => false }), false);
  assert.equal(isLeaseAlive({ ...lease, pid: null }, { readStartTicks: () => "9" }), false);
  assert.equal(isLeaseAlive({ pid: 42, startTicks: null }, { readStartTicks: () => "9", probeAlive: () => true }), true);
});

test("readProcStartTicks survives a comm containing spaces and parens", () => {
  const ticks = readProcStartTicks(process.pid);
  assert.match(String(ticks), /^\d+$/);
});

test("TC-19 planParts resends only what is missing", () => {
  const answer = "abcdefghij" + "klmnopqrst";
  assert.equal(chunkText(answer, 10).length, 2);

  const fresh = planParts({ answer, parts: [], chunkLimit: 10, canEdit: true });
  assert.deepEqual(fresh.map((part) => part.action), ["send", "send"]);

  const allSent = planParts({
    answer,
    parts: [
      { i: 0, messageId: "m0", hash: hashOf("abcdefghij") },
      { i: 1, messageId: "m1", hash: hashOf("klmnopqrst") },
    ],
    chunkLimit: 10,
    canEdit: true,
  });
  assert.deepEqual(allSent.map((part) => part.action), ["skip", "skip"]);

  const partial = planParts({
    answer,
    parts: [{ i: 0, messageId: "m0", hash: hashOf("abcdefghij") }],
    chunkLimit: 10,
    canEdit: true,
  });
  assert.deepEqual(partial, [
    { i: 0, action: "skip" },
    { i: 1, text: "klmnopqrst", action: "send" },
  ]);

  const changed = planParts({
    answer,
    parts: [{ i: 0, messageId: "m0", hash: "stale" }],
    chunkLimit: 10,
    canEdit: true,
  });
  assert.deepEqual(changed[0], { i: 0, text: "abcdefghij", action: "edit", messageId: "m0" });

  const noEdit = planParts({
    answer,
    parts: [{ i: 0, messageId: "m0", hash: "stale" }],
    chunkLimit: 10,
    canEdit: false,
  });
  assert.deepEqual(noEdit[0], { i: 0, action: "skip" });

  assert.deepEqual(planParts({ answer: null, parts: [], chunkLimit: 10 }), []);
});

const shot = (name, size = 10, mtimeMs = 1_000) => ({ path: `/tmp/${name}`, name: `${name}.png`, mime: "image/png", size, mtimeMs });

test("TC-20 without media the plan is byte-for-byte the old plan, whitespace included", () => {
  assert.deepEqual(planParts({ answer: "  ", parts: [], chunkLimit: 10 }), [{ i: 0, text: "  ", action: "send" }]);
  assert.deepEqual(planParts({ answer: "", parts: [], chunkLimit: 10 }), [{ i: 0, text: "", action: "send" }]);
});

test("TC-21 the media step lands after every text chunk and carries its own hash", () => {
  const files = [shot("a")];
  const plan = planParts({ answer: "abcdefghij" + "klmnopqrst", parts: [], chunkLimit: 10, media: { files } });
  assert.deepEqual(plan.map((step) => step.kind ?? "text"), ["text", "text", "media"]);
  assert.deepEqual(plan.map((step) => step.i), [0, 1, 2]);
  assert.deepEqual(plan[2].files, files);
  assert.equal(plan[2].action, "send");
  assert.equal(plan[2].hash, mediaHash(files));
});

test("TC-22 an image-only answer produces a single media step, never an empty text step", () => {
  for (const answer of ["", "  ", "\n\n"]) {
    const plan = planParts({ answer, parts: [], chunkLimit: 10, media: { files: [shot("a")] } });
    assert.equal(plan.length, 1, `answer ${JSON.stringify(answer)} produced ${plan.length} steps`);
    assert.equal(plan[0].kind, "media");
    assert.equal(plan[0].i, 0);
  }
});

test("TC-23 a delivered media step is skipped until the file changes", () => {
  const files = [shot("a")];
  const parts = [{ i: 0, kind: "media", hash: mediaHash(files), sentAt: "" }];
  assert.deepEqual(planParts({ answer: "", parts, chunkLimit: 10, media: { files } }), [{ i: 0, kind: "media", files, hash: mediaHash(files), action: "skip" }]);

  const changed = [shot("a", 11)];
  const plan = planParts({ answer: "", parts, chunkLimit: 10, media: { files: changed } });
  assert.equal(plan[0].action, "send");
  assert.equal(plan[0].hash, mediaHash(changed));
});

test("TC-24 sent text plus unsent media resends only the images", () => {
  const files = [shot("a")];
  const plan = planParts({
    answer: "hello",
    parts: [{ i: 0, messageId: "m0", hash: hashOf("hello") }],
    chunkLimit: 10,
    media: { files },
  });
  assert.deepEqual(plan.map((step) => step.action), ["skip", "send"]);
  assert.equal(plan[1].i, 1);
  assert.equal(plan[1].kind, "media");
});

test("ctxOf carries every field the adapter needs and stays serializable", () => {
  const base = job({ status: "answered", answer: "done text" });
  const ctx = ctxOf(base);
  assert.equal(ctx.jobId, "job-1");
  assert.deepEqual(JSON.parse(JSON.stringify(ctx)), ctx);

  const sent = { ...base, parts: [{ i: 0, messageId: "m-out", hash: "h", sentAt: "t" }] };
  assert.equal(ctxOf(sent).replyTo, "m-out");
  assert.equal(ctxOf({ ...sent, inbound: { ...sent.inbound, replyTo: "explicit" } }).replyTo, "explicit");
});

test("createJob keeps attachments and defaults to an empty list", () => {
  const state = { meta: {} };
  const attachments = [{ kind: "image", path: "/tmp/a.jpg" }];
  const withFiles = createJob(state, { ...inbound, attachments }, nowIso);
  assert.deepEqual(withFiles.inbound.attachments, attachments);
  const without = createJob(state, inbound, nowIso);
  assert.deepEqual(without.inbound.attachments, []);
});
