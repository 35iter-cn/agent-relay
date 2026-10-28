import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { createCore } from "../src/runtime/core.mjs";
import { emptyState } from "../src/state/schema.mjs";
import { renderPrompt } from "../src/shared/prompt.mjs";
import { pruneOldFiles } from "../src/shared/retention.mjs";
import { readJson, writeJsonAtomic } from "../src/shared/json.mjs";
import { stallNoticePrompt, stallNoticeText } from "../src/runtime/stall-notice.mjs";
import { hashOf } from "../src/jobs/delivery.mjs";

function controlledChild() {
  const child = new EventEmitter();
  child.pid = 999999;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  child.finish = (code = 0) => child.emit("close", code);
  return child;
}

function fakeChild({ stdout = "", stderr = "", code = 0, onClose } = {}) {
  const child = new EventEmitter();
  child.pid = 999999;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  setImmediate(() => {
    if (stdout) child.stdout.emit("data", stdout);
    if (stderr) child.stderr.emit("data", stderr);
    onClose?.(child);
    child.emit("close", code);
  });
  return child;
}

function harness({ spawn, replies = [], adapterOverrides = {}, state = emptyState(), sessions = [], deps = {}, candidateRules = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "relay-core-"));
  const sessionsDir = join(dir, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  for (const name of sessions) writeFileSync(join(sessionsDir, `2026-01-01T00-00-00_${name}.jsonl`), "{}\n");
  const promptsDir = join(dir, "prompts");
  mkdirSync(promptsDir, { recursive: true });
  writeFileSync(join(promptsDir, "thread.md"), "conversation={{conversation}} user={{user_message}} root={{root_section}} platform={{platform}} surface={{surface}} rules={{reply_rules}} chunk={{chunk_limit}} candidate={{candidate_rules}} section={{stall_section}} actions={{stall_actions}}");
  writeFileSync(join(promptsDir, "notice.md"), "NOTICE id={{notice_id}} prompt={{notice_prompt}} user={{user_message}} root={{root_section}}");
  writeFileSync(join(promptsDir, "stall-instructions.md"), "STALL-INSTRUCTIONS");
  writeFileSync(join(promptsDir, "stall-actions.md"), "ACTIONS platform={{platform}} key=<key>");
  if (candidateRules) writeFileSync(join(promptsDir, "candidate-rules.md"), candidateRules);
  const configDir = join(dir, ".config/agent-relay");
  const config = {
    home: dir,
    cwd: dir,
    configDir,
    logDir: join(dir, "logs"),
    sessionsDir,
    promptsDir,
    uploadsDir: join(configDir, "uploads"),
    cli: "agent-relay",
    readEnv: () => ({}),
    envFile: (name) => join(configDir, name),
    stateFile: (platform) => join(configDir, `relay-${platform}.json`),
    commandDir: (platform) => join(configDir, `relay-${platform}.cmd`),
  };
  const stateFile = config.stateFile("fake");
  writeJsonAtomic(stateFile, state);
  const adapter = {
    name: "fake",
    allowedUser: "u-ok",
    chunkLimit: 20,
    timeoutMs: 1000,
    maxWorkers: 2,
    queueDepth: 1,
    worker: "stub",
    piBin: "/bin/true",
    replyRules: "RULES",
    sessionFor: (key) => `fs-${key}`,
    reply: async (inbound, text) => replies.push({ key: inbound.key, text }),
    postNotice: async (text) => (replies.push({ key: "notice", text }), { messageId: `notice-${replies.length}` }),
    ...adapterOverrides,
  };
  const logs = [];
  const core = createCore({
    adapter,
    config,
    deps: { spawn: spawn ?? (() => fakeChild({ stdout: "ok" })), log: (level, ...parts) => logs.push([level, ...parts].join(" ")), ...deps },
  });
  return { core, adapter, replies, logs, dir, stateFile, sessionsDir, config };
}

function inbound(overrides = {}) {
  return { key: "th-abc", session: "fs-th-abc", dedupeId: "m1", authorId: "u-ok", text: "hello", chatId: "c1", ...overrides };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

test("TC-1 first turn injects the rendered prompt template", async () => {
  const captured = [];
  const { core } = harness({
    adapterOverrides: { buildWorker: ({ prompt, full }) => (captured.push({ prompt, full }), { bin: "/bin/true", args: [] }) },
  });
  await core.handle(inbound({ text: "第一条" }));
  await tick();
  assert.equal(captured.length, 1);
  assert.equal(captured[0].full, true);
  assert.match(captured[0].prompt, /conversation=th-abc/);
  assert.match(captured[0].prompt, /rules=RULES/);
  assert.doesNotMatch(captured[0].prompt, /\{\{/);
});

test("TC-2b an empty first-turn prompt fails the job instead of spawning a blind worker", async () => {
  let spawned = 0;
  const built = harness({ spawn: () => (spawned += 1, fakeChild({ stdout: "ok" })) });
  writeFileSync(join(built.dir, "prompts", "thread.md"), "");
  await built.core.handle(inbound({ text: "第一条" }));
  await tick();
  assert.equal(spawned, 0);
  assert.match(built.replies.map((item) => item.text).join("\n"), /prompt 模板为空/);
  assert.equal(Object.values(built.core.state.jobs)[0].status, "failed");
  assert.equal(Object.values(built.core.state.jobs)[0].error, "empty-prompt");
});

test("TC-2 a message with an existing session sends only the raw text", async () => {
  const captured = [];
  const { core } = harness({
    sessions: ["fs-th-abc"],
    adapterOverrides: { buildWorker: ({ prompt, full }) => (captured.push({ prompt, full }), { bin: "/bin/true", args: [] }) },
  });
  await core.handle(inbound({ text: "续上" }));
  await tick();
  assert.equal(captured[0].full, false);
  assert.equal(captured[0].prompt, "续上");
});

test("TC-3 duplicate delivery is dropped without touching state or spawning", async () => {
  let spawned = 0;
  const { core, replies } = harness({ spawn: () => (spawned++, fakeChild({ stdout: "ok" })) });
  assert.equal(await core.handle(inbound()), "accepted");
  await tick();
  assert.equal(await core.handle(inbound()), "duplicate");
  await tick();
  assert.equal(spawned, 1);
  assert.equal(replies.length, 1);
  assert.deepEqual(Object.keys(core.state.convs), ["th-abc"]);
});

test("author outside the allow list is ignored", async () => {
  const { core, replies } = harness();
  assert.equal(await core.handle(inbound({ authorId: "u-stranger", dedupeId: "m2" })), "ignored");
  await tick();
  assert.equal(replies.length, 0);
  assert.deepEqual(core.state.convs, {});
});

test("TC-4 queue rejects beyond maxWorkers plus queueDepth", async () => {
  const blockers = [];
  const { core, replies } = harness({
    spawn: () => {
      const child = fakeChild({ stdout: "done" });
      blockers.push(child);
      return child;
    },
  });
  const never = () => new Promise(() => {});
  void never;
  const accepted = await Promise.all([
    core.handle(inbound({ dedupeId: "a", key: "k1", session: "fs-k1" })),
    core.handle(inbound({ dedupeId: "b", key: "k2", session: "fs-k2" })),
    core.handle(inbound({ dedupeId: "c", key: "k3", session: "fs-k3" })),
    core.handle(inbound({ dedupeId: "d", key: "k4", session: "fs-k4" })),
  ]);
  assert.deepEqual(accepted, ["accepted", "accepted", "accepted", "busy"]);
  assert.equal(replies.at(-1).text.includes("当前繁忙"), true);
  assert.deepEqual(core.stats(), { running: 2, pending: 1 });
  blockers.forEach((child) => child.emit("close", 0));
});

test("TC-6 state writes are atomic and leave no temp files behind", async () => {
  const { core, dir, stateFile } = harness();
  await core.handle(inbound());
  await tick();
  const leftovers = readdirSync(dir).filter((name) => name.includes(".tmp-"));
  assert.deepEqual(leftovers, []);
  assert.deepEqual(Object.keys(readJson(stateFile, {})), ["cursor", "seen", "convs", "alerts", "jobs", "inbox", "notices", "meta"]);
});

test("TC-7b pruneLogs drops stale commands, old finished jobs and asks the platform to prune", async () => {
  let pruned = 0;
  let files = 0;
  const { core, config } = harness({ adapterOverrides: { prune: () => { pruned += 1; } } });
  const cmdDir = config.commandDir("fake");
  mkdirSync(cmdDir, { recursive: true });
  const stale = join(cmdDir, "stale.json");
  writeFileSync(stale, "{}");
  const old = new Date(Date.now() - 3_600_000);
  utimesSync(stale, old, old);
  core.state.jobs["job-99"] = { id: "job-99", key: "th-old", status: "done", updatedAt: "2020-01-01T00:00:00.000Z" };
  files = core.pruneLogs().jobs;
  assert.equal(existsSync(stale), false);
  assert.equal(core.state.jobs["job-99"], undefined);
  assert.equal(files, 1);
  assert.equal(pruned, 1);
});

test("TC-7 log files older than 72h are pruned, fresh ones kept", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-prune-"));
  writeFileSync(join(dir, "old.jsonl"), "x");
  writeFileSync(join(dir, "fresh.jsonl"), "x");
  const old = (Date.now() - 73 * 3_600_000) / 1000;
  utimesSync(join(dir, "old.jsonl"), old, old);
  const removed = pruneOldFiles(dir, 72 * 3_600_000);
  assert.deepEqual(removed, ["old.jsonl"]);
  assert.deepEqual(readdirSync(dir), ["fresh.jsonl"]);
});

test("TC-5 a worker over its timeout is killed as a process group", async () => {
  const { spawn } = await import("node:child_process");
  const replies = [];
  const started = Date.now();
  const { core } = harness({
    spawn,
    replies,
    adapterOverrides: {
      timeoutMs: 300,
      chunkLimit: 500,
      buildWorker: () => ({ bin: process.execPath, args: ["-e", "setTimeout(() => {}, 60000)"] }),
    },
  });
  await core.handle(inbound());
  while (!replies.length && Date.now() - started < 5000) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(Date.now() - started < 5000, "timeout path took too long");
  assert.equal(replies.length, 1);
  assert.match(replies[0].text, /已终止/);
});

test("reply failures are logged and do not throw", async () => {
  const { core, logs } = harness({
    adapterOverrides: { reply: async () => { throw new Error("boom"); } },
  });
  await core.handle(inbound());
  await tick();
  assert.ok(logs.some((line) => line.includes("reply") && line.includes("boom")));
});

test("renderPrompt replaces every placeholder", () => {
  assert.equal(renderPrompt("{{a}}-{{b}}", { a: 1, b: "x" }), "1-x");
  assert.equal(renderPrompt("no placeholders", {}), "no placeholders");
});

test("TC-24 a duplicate for an unfinished job resumes it instead of dropping it", async () => {
  const { core, replies } = harness({ adapterOverrides: { maxWorkers: 0, queueDepth: 5 } });
  assert.equal(await core.handle(inbound()), "accepted");
  const jobId = core.state.seen.m1;
  assert.equal(core.state.jobs[jobId].status, "queued");
  assert.equal(await core.handle(inbound()), "accepted");
  assert.equal(core.state.inbox.filter((id) => id === jobId).length, 1);
  assert.equal(replies.length, 0);
});

test("TC-24 a duplicate for a finished job is dropped", async () => {
  const { core } = harness();
  assert.equal(await core.handle(inbound()), "accepted");
  await tick();
  assert.equal(core.state.jobs[core.state.seen.m1].status, "done");
  assert.equal(await core.handle(inbound()), "duplicate");
});

test("legacy seen values are treated as already answered", async () => {
  const { core } = harness({ state: { cursor: null, seen: { old: "2026-01-01T00:00:00.000Z" }, convs: {}, alerts: {}, meta: {} } });
  assert.equal(core.state.seen.old, "legacy");
  assert.equal(core.state.meta.schemaVersion, 3);
  assert.equal(await core.handle(inbound({ dedupeId: "old" })), "duplicate");
  assert.deepEqual(core.state.jobs, {});
});

test("TC-25 two messages in one conversation never run at the same time", async () => {
  const spawned = [];
  const { core } = harness({
    spawn: () => {
      const child = controlledChild();
      spawned.push(child);
      return child;
    },
  });
  assert.equal(await core.handle(inbound({ dedupeId: "m1" })), "accepted");
  assert.equal(spawned.length, 1);
  assert.equal(await core.handle(inbound({ dedupeId: "m2" })), "accepted");
  assert.equal(spawned.length, 1, "second message waits for the first to finish");
  assert.deepEqual(core.stats(), { running: 1, pending: 1 });

  spawned[0].stdout.emit("data", "first");
  spawned[0].finish(0);
  await tick();
  assert.equal(spawned.length, 2, "second message starts once the first is done");
  assert.equal(core.state.jobs[core.state.seen.m1].status, "done");
  assert.equal(core.state.jobs[core.state.seen.m2].status, "running");

  spawned[1].stdout.emit("data", "second");
  spawned[1].finish(0);
  await tick();
  assert.equal(core.state.jobs[core.state.seen.m2].status, "done");
  assert.equal(core.state.convs["th-abc"].activeJob, null);
});

test("TC-25 different conversations run in parallel up to maxWorkers", async () => {
  const spawned = [];
  const { core } = harness({
    spawn: () => {
      const child = controlledChild();
      spawned.push(child);
      return child;
    },
  });
  await core.handle(inbound({ dedupeId: "a", key: "k1", session: "fs-k1" }));
  await core.handle(inbound({ dedupeId: "b", key: "k2", session: "fs-k2" }));
  assert.equal(spawned.length, 2);
  assert.equal(core.stats().running, 2);
  spawned.forEach((child) => child.finish(0));
  await tick();
  assert.equal(core.stats().running, 0);
});

test("TC-20 a queued job walks queued → running → answered → done", async () => {
  const observed = [];
  let core;
  const built = harness({
    adapterOverrides: {
      reply: async () => {
        const job = Object.values(core.state.jobs)[0];
        observed.push({ status: job.status, answer: job.answer });
      },
    },
  });
  core = built.core;
  assert.equal(await core.handle(inbound()), "accepted");
  const job = Object.values(core.state.jobs)[0];
  assert.equal(job.status, "running");
  assert.equal(typeof job.lease.pid, "number");
  await tick();
  assert.equal(observed.length, 1);
  assert.equal(observed[0].status, "answered", "the answer is committed before it is shown");
  assert.equal(observed[0].answer, "ok");
  assert.equal(job.status, "done");
  assert.equal(job.lease, null);
});

test("TC-27 a done job drops the answer body but keeps its parts", async () => {
  const { core, stateFile } = harness();
  await core.handle(inbound());
  await tick();
  const job = core.state.jobs[core.state.seen.m1];
  assert.equal(job.status, "done");
  assert.equal(job.answer, undefined);
  assert.ok(Array.isArray(job.parts));
  const onDisk = readJson(stateFile, {});
  assert.equal(onDisk.jobs[core.state.seen.m1].answer, undefined);
});

test("TC-27 a failed job keeps its answer for diagnosis", async () => {
  const { core } = harness({ spawn: () => fakeChild({ stdout: "", code: 2 }) });
  await core.handle(inbound());
  await tick();
  const job = core.state.jobs[core.state.seen.m1];
  assert.equal(job.status, "failed");
  assert.match(job.answer, /无输出/);
});

test("TC-23 every delivered chunk is committed to parts with its hash", async () => {
  const delivered = [];
  const { core } = harness({
    spawn: () => fakeChild({ stdout: "a".repeat(45) }),
    adapterOverrides: {
      reply: async (ctx, text) => {
        delivered.push({ text, replyTo: ctx.replyTo });
        return { messageId: `m-${delivered.length}` };
      },
    },
  });
  await core.handle(inbound());
  await tick();
  const job = core.state.jobs[core.state.seen.m1];
  assert.equal(delivered.length, 3, "45 chars at 20 per chunk is three chunks");
  assert.equal(job.parts.length, 3);
  assert.deepEqual(job.parts.map((part) => part.i), [0, 1, 2]);
  assert.deepEqual(job.parts.map((part) => part.messageId), ["m-1", "m-2", "m-3"]);
  assert.equal(job.parts[0].hash.length, 16);
  assert.equal(delivered[1].replyTo, "m-1", "later chunks reply to the previous one");
  assert.equal(delivered[2].replyTo, "m-2");
});

test("TC-23 a transient reply failure is retried and the run still completes", async () => {
  let calls = 0;
  const { core } = harness({
    spawn: () => fakeChild({ stdout: "a".repeat(45) }),
    deps: { deliveryRetryMs: 0 },
    adapterOverrides: {
      reply: async () => {
        calls += 1;
        if (calls === 2) throw new Error("platform down");
        return { messageId: `m-${calls}` };
      },
    },
  });
  await core.handle(inbound());
  await tick();
  const job = core.state.jobs[core.state.seen.m1];
  assert.equal(job.status, "done");
  assert.equal(job.parts.length, 3, "the retry resumes from the first unsent chunk");
  assert.equal(job.parts.map((part) => part.i).join(","), "0,1,2");
});

test("TC-23 a permanent reply failure ends the job as failed instead of leaving it answered", async () => {
  const { core } = harness({
    spawn: () => fakeChild({ stdout: "a".repeat(45) }),
    deps: { deliveryRetryMs: 0 },
    adapterOverrides: {
      reply: async () => {
        throw new Error("platform down");
      },
    },
  });
  await core.handle(inbound());
  await tick();
  const job = core.state.jobs[core.state.seen.m1];
  assert.equal(job.status, "failed");
  assert.equal(job.error, "reply-failed");
  assert.ok(job.answer, "the answer stays for diagnosis");
  assert.equal(job.deliveryAttempts, 3);
  assert.equal(await core.handle(inbound({ dedupeId: "m2", text: "还在吗" })), "accepted");
  assert.ok(core.state.jobs[core.state.seen.m2], "the failed job does not swallow new work");
});

test("TC-23 an adapter without edit never tries to patch", async () => {
  const { core } = harness({
    adapterOverrides: {
      reply: async () => ({ messageId: "m-1" }),
    },
  });
  await core.handle(inbound());
  await tick();
  const job = core.state.jobs[core.state.seen.m1];
  assert.equal(job.status, "done");
  assert.equal(typeof core.state.jobs[core.state.seen.m1].answer, "undefined");
});

function jobState({ status = "running", lease = null, parts = [], answer = null } = {}) {
  const state = emptyState();
  state.jobs["job-1"] = {
    id: "job-1",
    key: "th-abc",
    session: "fs-th-abc",
    status,
    inbound: { text: "hello", rootText: "hello", chatId: "c1", authorId: "u-ok", dedupeId: "m1", messageId: "om_1", threadId: null, replyTo: null, channelPost: null },
    answer,
    parts,
    progress: null,
    lease,
    noticeSent: false,
    retriedBy: null,
    attempts: 1,
    createdAt: "2026-10-23T00:00:00.000Z",
    updatedAt: "2026-10-23T00:00:00.000Z",
    error: null,
  };
  state.seen.m1 = "job-1";
  state.convs["th-abc"] = { session: "fs-th-abc", rootText: "hello", lastMsgTs: "", activeJob: "job-1" };
  return state;
}

test("TC-21 a restart reports an interrupted run instead of rerunning it", async () => {
  let spawned = 0;
  const state = jobState({ lease: { pid: 999999, startTicks: "1", startedAt: 0 } });
  const { core, replies } = harness({
    state,
    spawn: () => {
      spawned += 1;
      return fakeChild({ stdout: "x" });
    },
    deps: { readStartTicks: () => null, probeAlive: () => false },
  });
  assert.equal(await core.recover(), 1);
  assert.equal(spawned, 0, "an interrupted run is never rerun automatically");
  assert.equal(replies.length, 1);
  assert.match(replies[0].text, /被 relay 重启打断/);
  assert.match(replies[0].text, /已终止/);
  assert.match(replies[0].text, /直接回复/);
  assert.doesNotMatch(replies[0].text, /\/重跑/);
  const job = core.state.jobs["job-1"];
  assert.equal(job.status, "interrupted");
  assert.equal(job.noticeSent, true);

  assert.equal(await core.recover(), 0, "the second restart stays quiet");
  assert.equal(replies.length, 1);
});

test("TC-22 a live orphan worker is stopped before the run is reported", async () => {
  const killed = [];
  let alive = true;
  const state = jobState({ lease: { pid: 4242, startTicks: "777", startedAt: 0 } });
  const { core, replies } = harness({
    state,
    deps: {
      readStartTicks: () => "777",
      kill: (target, signal) => {
        killed.push([target, signal]);
        if (signal === "SIGTERM") alive = false;
      },
      probeAlive: () => alive,
      stallGraceMs: 200,
    },
  });
  await core.recover();
  assert.deepEqual(killed, [[-4242, "SIGTERM"]]);
  assert.equal(replies.length, 1);
  assert.equal(core.state.jobs["job-1"].status, "interrupted");
  assert.equal(core.state.jobs["job-1"].lease, null);
});

test("TC-22b an orphan that ignores SIGTERM is killed once the grace runs out", async () => {
  const killed = [];
  const state = jobState({ lease: { pid: 4242, startTicks: "777", startedAt: 0 } });
  const { core } = harness({
    state,
    deps: {
      readStartTicks: () => "777",
      kill: (target, signal) => killed.push([target, signal]),
      probeAlive: () => true,
      stallGraceMs: 20,
    },
  });
  await core.recover();
  assert.deepEqual(killed, [[-4242, "SIGTERM"], [-4242, "SIGKILL"]]);
});

test("TC-22c a lease stays alive no matter how long the relay was down", async () => {
  const killed = [];
  let alive = true;
  const state = jobState({ lease: { pid: 4242, startTicks: "777", startedAt: 0 } });
  const { core } = harness({
    state,
    deps: {
      readStartTicks: () => "777",
      kill: (target, signal) => {
        killed.push([target, signal]);
        if (signal === "SIGTERM") alive = false;
      },
      probeAlive: () => alive,
      stallGraceMs: 20,
    },
  });
  await core.recover();
  assert.deepEqual(killed, [[-4242, "SIGTERM"]]);
  assert.equal(core.state.jobs["job-1"].status, "interrupted");
});

test("TC-22d a state file written by the old heartbeat code is still readable", async () => {
  const killed = [];
  let alive = true;
  const legacyLease = { pid: 4242, startTicks: "777", startedAt: 0, heartbeatAt: 1 };
  const state = jobState({ lease: legacyLease });
  const { core } = harness({
    state,
    deps: {
      readStartTicks: () => "777",
      kill: (target, signal) => {
        killed.push([target, signal]);
        if (signal === "SIGTERM") alive = false;
      },
      probeAlive: () => alive,
      stallGraceMs: 20,
    },
  });
  await core.recover();
  assert.deepEqual(killed, [[-4242, "SIGTERM"]]);
  assert.equal(core.state.jobs["job-1"].lease, null);
});

test("TC-23 a restart resends only the missing chunks without spawning", async () => {
  let spawned = 0;
  const delivered = [];
  const answer = "a".repeat(45);
  const state = jobState({
    status: "answered",
    answer,
    parts: [{ i: 0, messageId: "m-1", hash: hashOf("a".repeat(20)), sentAt: "" }],
  });
  const { core } = harness({
    state,
    spawn: () => {
      spawned += 1;
      return fakeChild({ stdout: "x" });
    },
    adapterOverrides: {
      reply: async (ctx, text) => {
        delivered.push({ text, replyTo: ctx.replyTo });
        return { messageId: "m-new" };
      },
    },
  });
  await core.recover();
  assert.equal(spawned, 0);
  assert.deepEqual(delivered.map((entry) => entry.text.length), [20, 5]);
  assert.equal(delivered[0].replyTo, "m-1");
  assert.equal(core.state.jobs["job-1"].status, "done");
});

test("TC-20 a queued job left by a crash is picked up again", async () => {
  const state = emptyState();
  state.jobs["job-1"] = {
    id: "job-1",
    key: "th-abc",
    session: "fs-th-abc",
    status: "queued",
    inbound: { text: "hello", rootText: "hello", chatId: "c1", authorId: "u-ok", dedupeId: "m1", messageId: "om_1", threadId: null, replyTo: null, channelPost: null },
    answer: null,
    parts: [],
    progress: null,
    lease: null,
    noticeSent: false,
    retriedBy: null,
    attempts: 1,
    createdAt: "2026-10-23T00:00:00.000Z",
    updatedAt: "2026-10-23T00:00:00.000Z",
    error: null,
  };
  state.seen.m1 = "job-1";
  let spawned = 0;
  const { core, replies } = harness({
    state,
    spawn: () => {
      spawned += 1;
      return fakeChild({ stdout: "resumed answer" });
    },
  });
  await core.recover();
  await tick();
  assert.equal(spawned, 1);
  assert.equal(core.state.jobs["job-1"].status, "done");
  assert.equal(replies.length, 1);
  assert.match(replies[0].text, /resumed answer/);
});

test("TC-26 /重跑 turns the last interrupted job into a new attempt", async () => {
  const state = jobState({ status: "interrupted", lease: null });
  state.jobs["job-1"].noticeSent = true;
  const { core, replies } = harness({ state, spawn: () => fakeChild({ stdout: "retried" }) });
  assert.equal(await core.handle(inbound({ dedupeId: "cmd-1", text: "/重跑" })), "accepted");
  const retried = Object.values(core.state.jobs).find((job) => job.id !== "job-1");
  assert.ok(retried, "a new job is created");
  assert.match(retried.inbound.dedupeId, /#retry1$/);
  assert.equal(retried.attempts, 2);
  assert.equal(core.state.jobs["job-1"].retriedBy, retried.id);
  await tick();
  assert.equal(retried.status, "done");
  assert.match(replies.at(-1).text, /retried/);
});

test("TC-26 /重跑 without an interrupted job replies instead of creating work", async () => {
  const { core, replies } = harness();
  assert.equal(await core.handle(inbound({ dedupeId: "cmd-2", text: "/rerun" })), "accepted");
  assert.equal(Object.keys(core.state.jobs).length, 0);
  assert.match(replies[0].text, /没有可重跑/);
});

test("TC-26 stop words cancel the running turn and answer honestly when idle", async () => {
  const spawned = [];
  const { core, replies } = harness({
    spawn: () => {
      const child = controlledChild();
      spawned.push(child);
      return child;
    },
  });
  await core.handle(inbound({ dedupeId: "a" }));
  assert.equal(await core.handle(inbound({ dedupeId: "b", text: "停" })), "accepted");
  assert.equal(core.state.jobs[core.state.seen.a].status, "cancelled");
  assert.equal(core.state.seen.b, "legacy");

  const idle = harness();
  assert.equal(await idle.core.handle(inbound({ dedupeId: "c", text: "/stop" })), "accepted");
  assert.match(idle.replies[0].text, /没有在跑的任务/);
});

test("TC-26b stop also drops the turn that is still queued in the same conversation", async () => {
  const spawned = [];
  const { core } = harness({
    maxWorkers: 1,
    adapterOverrides: { maxWorkers: 1 },
    spawn: () => {
      const child = controlledChild();
      spawned.push(child);
      return child;
    },
  });
  await core.handle(inbound({ dedupeId: "a" }));
  await core.handle(inbound({ dedupeId: "b", text: "第二个问题" }));
  const queuedId = core.state.seen.b;
  assert.equal(core.state.jobs[queuedId].status, "queued");
  assert.equal(await core.handle(inbound({ dedupeId: "c", text: "停" })), "accepted");
  assert.equal(core.state.jobs[queuedId].status, "cancelled");
  assert.equal(core.state.jobs[queuedId].error, "stopped");
  assert.deepEqual(core.state.inbox, []);
  spawned[0].finish(0);
  await tick();
  assert.equal(spawned.length, 1, "the cancelled queued turn never starts");
});

test("TC-ST14 a stall action with nothing running replies instead of staying silent", async () => {
  const state = jobState({ status: "done", lease: null });
  state.convs["th-abc"].activeJob = null;
  const { core, replies, dir } = harness({ state });
  assert.equal(await core.applyAction({ action: "cancel", key: "th-abc", text: "" }), false);
  assert.equal(replies.length, 1);
  assert.match(replies[0].text, /没有在跑的任务/);
  assert.match(replies[0].text, /完成/);
  const logDir = join(dir, "logs", "fake");
  const events = readdirSync(logDir).flatMap((name) => readFileSync(join(logDir, name), "utf8").trim().split("\n")).map((line) => JSON.parse(line));
  assert.ok(events.some((event) => event.event === "action" && event.note === "not-running"));
});

test("TC-ST15 a stall cancel drops a queued turn and says so", async () => {
  const state = jobState({ status: "done", lease: null });
  state.convs["th-abc"].activeJob = null;
  state.jobs["job-2"] = { ...state.jobs["job-1"], id: "job-2", status: "queued", lease: null, updatedAt: "2026-10-23T00:01:00.000Z" };
  state.inbox = ["job-2"];
  const { core, replies } = harness({ state });
  assert.equal(await core.applyAction({ action: "cancel", key: "th-abc", text: "" }), true);
  assert.equal(core.state.jobs["job-2"].status, "cancelled");
  assert.deepEqual(core.state.inbox, []);
  assert.match(replies[0].text, /已取消排队中的 1 个任务/);
});

test("TC-26 command words are matched against already-stripped text", async () => {
  const cases = [
    ["/重跑", "retry"],
    ["重跑", "retry"],
    ["  /rerun  ", "retry"],
    ["@_user_1 /重跑", "message"],
    ["@_user_1 重跑", "message"],
    ["停", "stop"],
    ["@_user_1 停", "message"],
    ["/stop", "stop"],
    ["我们要重跑一下这个流程", "message"],
    ["重跑了", "message"],
  ];
  for (const [text, expected] of cases) {
    const state = jobState({ status: "interrupted", lease: null });
    state.jobs["job-1"].noticeSent = true;
    const { core } = harness({ state, spawn: () => fakeChild({ stdout: "x" }) });
    await core.handle(inbound({ dedupeId: `cmd-${text}`, text }));
    const created = Object.values(core.state.jobs).find((job) => job.id !== "job-1");
    if (expected === "retry") {
      assert.ok(created, `"${text}" should retry`);
      assert.match(created.inbound.dedupeId, /#retry1$/);
    } else if (expected === "stop") {
      assert.equal(core.state.seen[`cmd-${text}`], "legacy", `"${text}" should stop`);
    } else {
      assert.ok(created, `"${text}" is ordinary text and must be accepted as a message`);
      assert.doesNotMatch(created.inbound.dedupeId, /#retry/, `"${text}" must not become a retry`);
    }
  }
});

test("TC-26 /重跑 turns the last interrupted job into a new attempt", async () => {
  const state = jobState({ status: "interrupted", lease: null });
  state.jobs["job-1"].noticeSent = true;
  const { core, replies } = harness({ state, spawn: () => fakeChild({ stdout: "retried" }) });
  assert.equal(await core.handle(inbound({ dedupeId: "cmd-1", text: "/重跑" })), "accepted");
  const retried = Object.values(core.state.jobs).find((job) => job.id !== "job-1");
  assert.ok(retried, "a new job is created");
  assert.match(retried.inbound.dedupeId, /#retry1$/);
  assert.equal(retried.attempts, 2);
  assert.equal(core.state.jobs["job-1"].retriedBy, retried.id);
  await tick();
  assert.equal(retried.status, "done");
  assert.match(replies.at(-1).text, /retried/);
});

test("TC-26 /重跑 without an interrupted job replies instead of creating work", async () => {
  const { core, replies } = harness();
  assert.equal(await core.handle(inbound({ dedupeId: "cmd-2", text: "/rerun" })), "accepted");
  assert.equal(Object.keys(core.state.jobs).length, 0);
  assert.match(replies[0].text, /没有可重跑/);
});

test("TC-26 stop words cancel the running turn and answer honestly when idle", async () => {
  const spawned = [];
  const { core, replies } = harness({
    spawn: () => {
      const child = controlledChild();
      spawned.push(child);
      return child;
    },
  });
  await core.handle(inbound({ dedupeId: "a" }));
  assert.equal(await core.handle(inbound({ dedupeId: "b", text: "停" })), "accepted");
  assert.equal(core.state.jobs[core.state.seen.a].status, "cancelled");
  assert.equal(core.state.seen.b, "legacy");

  const idle = harness();
  assert.equal(await idle.core.handle(inbound({ dedupeId: "c", text: "/stop" })), "accepted");
  assert.match(idle.replies[0].text, /没有在跑的任务/);
});

test("TC-V1 candidate root injects the candidate section", async () => {
  const captured = [];
  const { core } = harness({
    candidateRules: "## 候选任务\n\n候选规则正文",
    adapterOverrides: { buildWorker: ({ prompt, full }) => (captured.push({ prompt, full }), { bin: "/bin/true", args: [] }) },
  });
  await core.handle(inbound({ text: "go", rootText: "[20261023-0834-1] 看板新增 Todo https://x/1" }));
  await tick();
  assert.equal(captured.length, 1);
  assert.match(captured[0].prompt, /## 候选任务/);
  assert.match(captured[0].prompt, /候选规则正文/);
  assert.match(captured[0].prompt, /本会话的起点（不是你这条）：/);
});

test("TC-V2 task root skips the candidate section", async () => {
  const captured = [];
  const { core } = harness({
    candidateRules: "## 候选任务\n\n候选规则正文",
    adapterOverrides: { buildWorker: ({ prompt, full }) => (captured.push({ prompt, full }), { bin: "/bin/true", args: [] }) },
  });
  await core.handle(inbound({ text: "读一下 core.mjs", rootText: "读一下 core.mjs" }));
  await tick();
  assert.doesNotMatch(captured[0].prompt, /候选任务/);
  assert.doesNotMatch(captured[0].prompt, /本会话的起点/);
});

test("TC-V3 empty root falls back to the message text for the variant judgement", async () => {
  const captured = [];
  const { core } = harness({
    candidateRules: "## 候选任务\n\n候选规则正文",
    adapterOverrides: { buildWorker: ({ prompt, full }) => (captured.push({ prompt, full }), { bin: "/bin/true", args: [] }) },
  });
  await core.handle(inbound({ text: "[20261023-0834-9] 板外 issue https://x/9", rootText: "" }));
  await tick();
  assert.match(captured[0].prompt, /## 候选任务/);
  assert.doesNotMatch(captured[0].prompt, /本会话的起点/);
});

test("TC-V4 jev verdict wins over the regex fallback", async () => {
  const captured = [];
  const { core } = harness({
    candidateRules: "## 候选任务\n\n候选规则正文",
    deps: { jev: { judgeChoice: async () => ({ choice: "candidate_rules", confidence: 0.99, fallback: null }) } },
    adapterOverrides: { buildWorker: ({ prompt, full }) => (captured.push({ prompt, full }), { bin: "/bin/true", args: [] }) },
  });
  await core.handle(inbound({ text: "没有方括号的候选播报", rootText: "没有方括号的候选播报" }));
  await tick();
  assert.match(captured[0].prompt, /## 候选任务/);
});

test("TC-V5 jev failure falls back to the regex and does not break dispatch", async () => {
  const captured = [];
  const { core } = harness({
    candidateRules: "## 候选任务\n\n候选规则正文",
    deps: { jev: { judgeChoice: async () => ({ choice: null, confidence: null, fallback: "timeout" }) } },
    adapterOverrides: { buildWorker: ({ prompt, full }) => (captured.push({ prompt, full }), { bin: "/bin/true", args: [] }) },
  });
  await core.handle(inbound({ text: "go", rootText: "[20261023-0834-1] 候选 https://x/1" }));
  await tick();
  assert.match(captured[0].prompt, /## 候选任务/);
});

test("TC-V6 killed worker tells the user to continue instead of rerunning", async () => {
  const { spawn } = await import("node:child_process");
  const replies = [];
  const started = Date.now();
  const { core } = harness({
    spawn,
    replies,
    adapterOverrides: {
      timeoutMs: 300,
      chunkLimit: 500,
      buildWorker: () => ({ bin: process.execPath, args: ["-e", "setTimeout(() => {}, 60000)"] }),
    },
  });
  await core.handle(inbound());
  while (!replies.length && Date.now() - started < 5000) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(replies.length, 1);
  assert.match(replies[0].text, /回复「继续」/);
  assert.doesNotMatch(replies[0].text, /\/重跑/);
});

test("TC-V7 a timed-out job cannot be rerun while an interrupted one can", async () => {
  const state = emptyState();
  state.jobs["job-old"] = {
    id: "job-old",
    key: "th-abc",
    session: "fs-th-abc",
    status: "failed",
    killed: true,
    createdAt: "2026-10-23T00:00:00.000Z",
    updatedAt: "2026-10-23T00:01:00.000Z",
    inbound: { text: "第一条", dedupeId: "m0" },
  };
  const { core, replies } = harness({ state });
  await core.handle(inbound({ dedupeId: "cmd-1", text: "/重跑" }));
  assert.equal(replies.length, 1);
  assert.match(replies[0].text, /没有可重跑/);
});

test("TC-V8 usage records one run per terminal job", async () => {
  const runs = [];
  const { core } = harness({ deps: { usage: { recordRun: (args) => runs.push(args) } } });
  await core.handle(inbound({ text: "hi" }));
  await tick();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "done");
  assert.equal(runs[0].platform, "fake");
  assert.equal(runs[0].answer, "ok");
});

test("TC-40 attachments become @refs ahead of the prompt", async () => {
  const captured = [];
  const { core } = harness({
    adapterOverrides: { worker: "pi" },
    spawn: (bin, args) => {
      captured.push({ bin, args });
      return fakeChild({ stdout: "ok" });
    },
  });
  await core.handle(
    inbound({ text: "看图", attachments: [{ kind: "image", path: "/tmp/a.jpg" }, { kind: "image", path: "/tmp/b.png" }] }),
  );
  await tick();
  assert.equal(captured.length, 1);
  const args = captured[0].args;
  const dash = args.indexOf("--");
  assert.ok(dash > 0);
  assert.deepEqual(args.slice(dash + 1, dash + 3), ["@/tmp/a.jpg", "@/tmp/b.png"]);
  assert.match(args[args.length - 1], /看图/);
});

test("TC-41 no attachments keeps the argv shape unchanged", async () => {
  const captured = [];
  const { core } = harness({
    adapterOverrides: { worker: "pi" },
    spawn: (bin, args) => {
      captured.push(args);
      return fakeChild({ stdout: "ok" });
    },
  });
  await core.handle(inbound({ text: "hi" }));
  await tick();
  const args = captured[0];
  assert.equal(args.filter((arg) => arg.startsWith("@")).length, 0);
  assert.equal(args[args.length - 2], "--");
});

test("TC-BOOT a new boot id posts one boot notice and records it", async () => {
  const { core, replies } = harness({ deps: { readBootId: () => "b1" } });
  assert.equal(await core.onReady(), true);
  assert.equal(await core.onReady(), false);
  assert.equal(replies.filter((item) => item.key === "notice").length, 1);
  assert.match(replies[0].text, /系统已启动/);
  assert.equal(core.state.meta.bootNotice.bootId, "b1");
  const boot = core.state.notices[core.state.meta.bootNotice.noticeId];
  assert.match(boot.text, /系统已启动/);
  assert.equal(boot.prompt, "");
});

test("TC-BOOT a platform that opts out never announces, a machine without a boot id stays silent", async () => {
  const optedOut = harness({ adapterOverrides: { bootNotice: false }, deps: { readBootId: () => "b1" } });
  assert.equal(await optedOut.core.onReady(), false);
  assert.equal(optedOut.replies.length, 0);
  const noId = harness({ deps: { readBootId: () => null } });
  assert.equal(await noId.core.onReady(), false);
  assert.equal(noId.replies.length, 0);
  assert.ok(noId.logs.some((line) => line.includes("no-boot-id")));
});

test("TC-ST1 stall notice names the session, key, pid and restart prompt", () => {
  const text = stallNoticeText({
    key: "th-abc",
    session: "fs-th-abc",
    pid: 4242,
    silenceMs: 12 * 60_000,
    local: "2026-10-26 15:20:12",
  });
  assert.match(text, /12 分钟没有进展/);
  assert.match(text, /fs-th-abc/);
  assert.match(text, /key：th-abc/);
  assert.match(text, /pid：4242/);
  assert.match(text, /上一轮似乎卡住了，继续，不要犯相同错误/);
  assert.match(text, /回复本消息/);
  assert.match(text, /按最后一次进展截止入账/);
  assert.doesNotMatch(text, /已用时间/);
});

test("TC-ST2 a graceful terminate lets the plugin write the row and only posts the note", async () => {
  let first = null;
  const { core, replies, dir } = harness({
    deps: { stallGraceMs: 5 },
    spawn: () => {
      const child = controlledChild();
      child.kill = (signal) => {
        if (signal === "SIGTERM") setTimeout(() => child.emit("close", null), 0);
      };
      first = first ?? child;
      return child;
    },
  });
  await core.handle(inbound());
  const job = Object.values(core.state.jobs).find((item) => item.key === "th-abc");
  const ledger = join(dir, ".config/agent-hours/ledger");
  mkdirSync(ledger, { recursive: true });
  const sessionId = "fs-th-abc";
  const startedAt = new Date(job.lease.startedAt).toISOString();
  const open = { v: 1, kind: "open", id: `${sessionId}:${startedAt}`, sessionId, sessionFile: "/tmp/x.jsonl", source: "relay", startedAt };
  writeFileSync(join(ledger, `${sessionId}.jsonl`), `${JSON.stringify(open)}\n`);
  const cmdDir = join(dir, ".config/agent-relay/relay-fake.cmd");
  mkdirSync(cmdDir, { recursive: true });
  writeFileSync(join(cmdDir, "1-cancel.json"), JSON.stringify({ action: "cancel", key: "th-abc", at: new Date().toISOString() }));
  assert.equal(await core.drainCommands(), 1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(replies.map((reply) => reply.text).join(""), /已终止/);
  const rows = readFileSync(join(ledger, `${sessionId}.jsonl`), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(rows.filter((row) => row.salvaged).length, 0);
  void first;
});

test("TC-ST2H a process that ignores SIGTERM is killed after the grace period without a ledger row", async () => {
  const killed = [];
  const { core, dir } = harness({
    deps: { stallGraceMs: 5, kill: (target, signal) => killed.push([target, signal]) },
    spawn: () => controlledChild(),
  });
  await core.handle(inbound());
  const cmdDir = join(dir, ".config/agent-relay/relay-fake.cmd");
  mkdirSync(cmdDir, { recursive: true });
  writeFileSync(join(cmdDir, "1-cancel.json"), JSON.stringify({ action: "cancel", key: "th-abc", at: new Date().toISOString() }));
  assert.equal(await core.drainCommands(), 1);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(killed.map((entry) => entry[1]), ["SIGTERM", "SIGKILL"]);
  assert.equal(existsSync(join(dir, ".config/agent-hours")), false);
});

test("TC-ST3 restart command kills the stuck run and dispatches the session again with the default prompt plus the extra text", async () => {
  const { core, dir } = harness({ deps: { stallGraceMs: 5 }, spawn: () => controlledChild() });
  await core.handle(inbound());
  const cmdDir = join(dir, ".config/agent-relay/relay-fake.cmd");
  mkdirSync(cmdDir, { recursive: true });
  writeFileSync(join(cmdDir, "1-restart.json"), JSON.stringify({ action: "restart", key: "th-abc", text: "先换掉那条命令", at: new Date().toISOString() }));
  assert.equal(await core.drainCommands(), 1);
  const restarted = Object.values(core.state.jobs).find((job) => job.auto === "stall-restart");
  assert.ok(restarted, "a restarted job is queued");
  assert.match(restarted.inbound.text, /上一轮似乎卡住了，继续，不要犯相同错误/);
  assert.match(restarted.inbound.text, /先换掉那条命令/);
  assert.equal(restarted.session, "fs-th-abc");
});

test("TC-ST3R a resume command is no longer an action the relay understands", async () => {
  const { core, dir } = harness({ deps: { stallGraceMs: 5 }, spawn: () => controlledChild() });
  await core.handle(inbound());
  const cmdDir = join(dir, ".config/agent-relay/relay-fake.cmd");
  mkdirSync(cmdDir, { recursive: true });
  writeFileSync(join(cmdDir, "1-resume.json"), JSON.stringify({ action: "resume", key: "th-abc", at: new Date().toISOString() }));
  assert.equal(await core.drainCommands(), 1);
  assert.equal(Object.values(core.state.jobs).filter((job) => job.auto === "stall-restart").length, 0);
});

test("TC-ST4 replying to a stall notice opens a notice-scoped conversation", async () => {
  const prompts = [];
  const state = emptyState();
  state.notices["ntc-1"] = {
    id: "ntc-1",
    platform: "fake",
    messageId: "m-notice",
    text: "⏸ 任务疑似卡住：12 分钟没有进展\n会话：fs-th-abc\nkey：th-abc",
    prompt: stallNoticePrompt({ key: "th-abc", platform: "fake", instructions: "STALL-INSTRUCTIONS" }),
    sentAt: new Date().toISOString(),
  };
  const { core } = harness({
    state,
    spawn: () => fakeChild({ stdout: "ok" }),
    adapterOverrides: {
      buildWorker: ({ prompt }) => {
        prompts.push(prompt);
        return { bin: process.execPath, args: ["-e", "0"] };
      },
    },
  });
  await core.handle(inbound({ text: "杀掉", dedupeId: "m-reply", replyIds: ["m-notice"] }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.match(prompts[0], /NOTICE id=ntc-1/);
  assert.match(prompts[0], /STALL-INSTRUCTIONS/);
  assert.match(prompts[0], /杀掉/);
  assert.match(prompts[0], /任务疑似卡住/);
  assert.match(prompts[0], /key/);
  const job = Object.values(core.state.jobs).find((item) => item.noticeId === "ntc-1");
  assert.equal(job.key, "notice-ntc-1");
});

test("TC-ST5 an ordinary first message still uses the thread template", async () => {
  const prompts = [];
  const { core } = harness({
    spawn: () => fakeChild({ stdout: "ok" }),
    adapterOverrides: {
      buildWorker: ({ prompt }) => {
        prompts.push(prompt);
        return { bin: process.execPath, args: ["-e", "0"] };
      },
    },
  });
  await core.handle(inbound({ text: "看下这个 bug" }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.match(prompts[0], /conversation=th-abc/);
  assert.doesNotMatch(prompts[0], /STALL-TEMPLATE/);
  assert.match(prompts[0], /ACTIONS platform=fake key=<key>/);
});

const isoAt = (ms) => new Date(ms).toISOString();

function sessionAssistant(at, calls) {
  return {
    type: "message",
    id: `a-${at}`,
    parentId: null,
    timestamp: isoAt(at),
    message: {
      role: "assistant",
      content: calls.map((call) => ({ type: "toolCall", id: call.id, name: call.name ?? "bash", arguments: call.arguments ?? { command: "ls" } })),
      provider: "fake",
      model: "fake",
      usage: { input: 1, output: 1 },
      stopReason: "toolUse",
      timestamp: at,
    },
  };
}

function sessionToolResult(at, callId, text = "ok") {
  return {
    type: "message",
    id: `t-${callId}-${at}`,
    parentId: null,
    timestamp: isoAt(at),
    message: { role: "toolResult", toolCallId: callId, toolName: "bash", content: [{ type: "text", text }], isError: false, timestamp: at },
  };
}

function writeSession(sessionsDir, session, entries) {
  writeFileSync(join(sessionsDir, `2026-01-01T00-00-00_${session}.jsonl`), `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

function closingSpawn() {
  return () => {
    const child = controlledChild();
    child.kill = (signal) => {
      if (signal === "SIGTERM") setTimeout(() => child.emit("close", null), 0);
    };
    return child;
  };
}

async function runningJob(harnessArgs = {}) {
  const clock = { now: Date.parse("2026-10-26T13:00:00.000Z") };
  const { deps: extraDeps, ...rest } = harnessArgs;
  const built = harness({
    sessions: ["fs-th-abc"],
    deps: { now: () => clock.now, stallGraceMs: 5, ...(extraDeps ?? {}) },
    spawn: () => controlledChild(),
    ...rest,
  });
  await built.core.handle(inbound());
  const job = Object.values(built.core.state.jobs).find((item) => item.key === "th-abc");
  return { ...built, clock, job };
}

test("TC-ST6 an unclosed tool call over the threshold notifies once with the tool evidence", async () => {
  const { core, replies, sessionsDir, clock, job } = await runningJob();
  writeSession(sessionsDir, "fs-th-abc", [sessionAssistant(clock.now - 12 * 60_000, [{ id: "c1", arguments: { command: "dotnet build\n--no-restore" } }])]);
  await core.checkStall(job);
  const text = replies.map((reply) => reply.text).join("\n");
  assert.match(text, /工具 bash 已运行 12 分钟没有返回/);
  assert.match(text, /工具：bash · dotnet build/);
  assert.equal(job.stallReason, "tool");
  assert.equal(job.stallTool, "bash");
  assert.equal(job.stallRunningMs, 12 * 60_000);
});

test("TC-ST7 a declared bash timeout defers the notice until timeout plus grace", async () => {
  const { core, replies, sessionsDir, clock, job } = await runningJob();
  const startedAt = clock.now - 12 * 60_000;
  writeSession(sessionsDir, "fs-th-abc", [sessionAssistant(startedAt, [{ id: "c1", arguments: { command: "md up", timeout: 900 } }])]);
  await core.checkStall(job);
  assert.equal(replies.length, 0);
  clock.now = startedAt + 959_000;
  await core.checkStall(job);
  assert.equal(replies.length, 0);
  clock.now = startedAt + 960_000;
  await core.checkStall(job);
  assert.equal(replies.length, 1);
});

test("TC-ST8 a silent session notifies from the session signal alone", async () => {
  const { core, replies, sessionsDir, clock, job } = await runningJob();
  const finishedAt = clock.now - 11 * 60_000;
  writeSession(sessionsDir, "fs-th-abc", [sessionAssistant(finishedAt - 1000, [{ id: "c1" }]), sessionToolResult(finishedAt, "c1")]);
  await core.checkStall(job);
  assert.equal(replies.length, 1);
  assert.equal(job.stallReason, "silent");
  assert.match(replies[0].text, /11 分钟没有进展/);
  assert.doesNotMatch(replies[0].text, /工具：/);
});

test("TC-ST9 a missing session file falls back to the lease start", async () => {
  const { core, replies, clock, job } = await runningJob({ sessions: [] });
  clock.now = job.lease.startedAt + 11 * 60_000;
  await core.checkStall(job);
  assert.equal(replies.length, 1);
  assert.equal(job.stallReason, "fallback");
});

test("TC-ST10 a job that already notified is not notified again", async () => {
  const { core, replies, sessionsDir, clock, job } = await runningJob();
  writeSession(sessionsDir, "fs-th-abc", [sessionAssistant(clock.now - 20 * 60_000, [{ id: "c1" }])]);
  await core.checkStall(job);
  await core.checkStall(job);
  clock.now += 30 * 60_000;
  await core.checkStall(job);
  assert.equal(replies.length, 1);
});

test("TC-ST11 parallel calls report only the unclosed ones", async () => {
  const { core, replies, sessionsDir, clock, job } = await runningJob();
  const startedAt = clock.now - 15 * 60_000;
  writeSession(sessionsDir, "fs-th-abc", [sessionAssistant(startedAt, [{ id: "c1" }, { id: "c2" }, { id: "c3" }]), sessionToolResult(startedAt + 1000, "c2")]);
  await core.checkStall(job);
  assert.equal(replies.length, 1);
  assert.deepEqual(job.stallTool, "bash");
  assert.equal(job.stallReason, "tool");
});

test("TC-ST12 cancelling a notified job leaves no ledger row behind", async () => {
  const { core, dir, sessionsDir, clock, job } = await runningJob();
  writeSession(sessionsDir, "fs-th-abc", [sessionAssistant(clock.now - 30 * 60_000, [{ id: "c1" }])]);
  await core.checkStall(job);
  const cmdDir = join(dir, ".config/agent-relay/relay-fake.cmd");
  mkdirSync(cmdDir, { recursive: true });
  writeFileSync(join(cmdDir, "1-cancel.json"), JSON.stringify({ action: "cancel", key: "th-abc", at: isoAt(clock.now) }));
  await core.drainCommands();
  assert.equal(job.stallCancelled, true);
  assert.equal(existsSync(join(dir, ".config/agent-hours")), false);
});

test("TC-ST13 a restarted job starts with empty stall fields", async () => {
  const { core, dir, sessionsDir, clock, job } = await runningJob();
  writeSession(sessionsDir, "fs-th-abc", [sessionAssistant(clock.now - 30 * 60_000, [{ id: "c1" }])]);
  await core.checkStall(job);
  const cmdDir = join(dir, ".config/agent-relay/relay-fake.cmd");
  mkdirSync(cmdDir, { recursive: true });
  writeFileSync(join(cmdDir, "1-restart.json"), JSON.stringify({ action: "restart", key: "th-abc", at: isoAt(clock.now) }));
  await core.drainCommands();
  const restarted = Object.values(core.state.jobs).find((item) => item.auto === "stall-restart");
  assert.equal(restarted.stallNotifiedAt, undefined);
  assert.equal(restarted.stallReason, undefined);
  assert.equal(restarted.stallRunningMs, undefined);
});

test("TC-ST16 a stall cancel bills to the last progress, not to the notice", async () => {
  const recorded = [];
  const { core, replies, dir, sessionsDir, clock, job } = await runningJob({
    spawn: closingSpawn(),
    adapterOverrides: { chunkLimit: 1000 },
    deps: { usage: { recordRun: async (args) => { recorded.push(args); } } },
  });
  clock.now = Date.parse("2026-10-26T13:20:00.000Z");
  const toolAt = clock.now - 12 * 60_000;
  writeSession(sessionsDir, "fs-th-abc", [sessionAssistant(toolAt, [{ id: "c1" }])]);
  await core.checkStall(job);
  assert.equal(job.lastActivityAt, isoAt(toolAt));
  clock.now = Date.parse("2026-10-26T13:25:00.000Z");
  const cmdDir = join(dir, ".config/agent-relay/relay-fake.cmd");
  mkdirSync(cmdDir, { recursive: true });
  writeFileSync(join(cmdDir, "1-cancel.json"), JSON.stringify({ action: "cancel", key: "th-abc", at: isoAt(clock.now) }));
  await core.drainCommands();
  await tick();
  const text = replies.map((reply) => reply.text).join("\n");
  assert.match(text, /计入 8 分钟/);
  assert.match(text, /到 2026-10-26 21:08:00/);
  assert.equal(job.cutoffAt, isoAt(toolAt));
  assert.equal(job.stallCancelled, true);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].cutoffAt, toolAt);
  assert.equal(recorded[0].status, "cancelled");
  assert.equal(recorded[0].startedAt, Date.parse("2026-10-26T13:00:00.000Z"));
  const logDir = join(dir, "logs", "fake");
  const events = readdirSync(logDir).flatMap((name) => readFileSync(join(logDir, name), "utf8").trim().split("\n")).map((line) => JSON.parse(line));
  const done = events.find((event) => event.event === "done" && event.job === job.id);
  assert.ok(done);
  assert.equal(done.elapsedMs, Date.parse("2026-10-26T13:25:00.000Z") - Date.parse("2026-10-26T13:00:00.000Z"));
});

test("TC-ST17 a silent stall cancel bills to the last session entry", async () => {
  const { core, replies, dir, sessionsDir, clock, job } = await runningJob({ spawn: closingSpawn(), adapterOverrides: { chunkLimit: 1000 } });
  clock.now = Date.parse("2026-10-26T13:20:00.000Z");
  const finishedAt = clock.now - 11 * 60_000;
  writeSession(sessionsDir, "fs-th-abc", [sessionAssistant(finishedAt - 1000, [{ id: "c1" }]), sessionToolResult(finishedAt, "c1")]);
  await core.checkStall(job);
  assert.equal(job.lastActivityAt, isoAt(finishedAt));
  clock.now = Date.parse("2026-10-26T13:30:00.000Z");
  const cmdDir = join(dir, ".config/agent-relay/relay-fake.cmd");
  mkdirSync(cmdDir, { recursive: true });
  writeFileSync(join(cmdDir, "1-cancel.json"), JSON.stringify({ action: "cancel", key: "th-abc", at: isoAt(clock.now) }));
  await core.drainCommands();
  await tick();
  const text = replies.map((reply) => reply.text).join("\n");
  assert.match(text, /计入 9 分钟/);
  assert.match(text, /到 2026-10-26 21:09:00/);
  assert.equal(job.cutoffAt, isoAt(finishedAt));
});

test("TC-ST18 a cancel without a stall record falls back to now", async () => {
  const { core, replies, clock, job } = await runningJob({ spawn: closingSpawn() });
  clock.now = Date.parse("2026-10-26T13:10:00.000Z");
  assert.equal(await core.applyAction({ action: "cancel", key: "th-abc", text: "" }), true);
  await tick();
  const text = replies.map((reply) => reply.text).join("\n");
  assert.match(text, /计入 10 分钟/);
  assert.equal(job.cutoffAt, isoAt(clock.now));
});

test("TC-ST19 a restart cuts the old job at its last progress and leaves the new one uncut", async () => {
  const { core, dir, sessionsDir, clock, job } = await runningJob();
  clock.now = Date.parse("2026-10-26T13:20:00.000Z");
  const toolAt = clock.now - 12 * 60_000;
  writeSession(sessionsDir, "fs-th-abc", [sessionAssistant(toolAt, [{ id: "c1" }])]);
  await core.checkStall(job);
  clock.now = Date.parse("2026-10-26T13:25:00.000Z");
  const cmdDir = join(dir, ".config/agent-relay/relay-fake.cmd");
  mkdirSync(cmdDir, { recursive: true });
  writeFileSync(join(cmdDir, "1-restart.json"), JSON.stringify({ action: "restart", key: "th-abc", at: isoAt(clock.now) }));
  await core.drainCommands();
  assert.equal(job.cutoffAt, isoAt(toolAt));
  assert.equal(job.stallCancelled, true);
  const restarted = Object.values(core.state.jobs).find((item) => item.auto === "stall-restart");
  assert.ok(restarted, "a restarted job is queued");
  assert.equal(restarted.cutoffAt, undefined);
  assert.equal(restarted.stallCancelled, undefined);
});

test("TC-ST20 a finished job clears its progress only after the reaction is done", async () => {
  const seen = [];
  const { core } = harness({
    adapterOverrides: {
      onProgress: async () => ({ mode: "reaction", messageId: "m-1", name: "eyes" }),
      onProgressDone: async (ctx) => { seen.push(ctx.progress); },
    },
  });
  await core.handle(inbound());
  await tick();
  const job = Object.values(core.state.jobs).find((item) => item.key === "th-abc");
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], { mode: "reaction", messageId: "m-1", name: "eyes" });
  assert.equal(job.progress, null);
});

test("TC-42 the stall section carries only the skeleton when no job is running", async () => {
  const captured = [];
  const { core } = harness({
    adapterOverrides: { buildWorker: ({ prompt, full }) => (captured.push({ prompt, full }), { bin: "/bin/true", args: [] }) },
  });
  await core.handle(inbound({ text: "第一条" }));
  await tick();
  assert.match(captured[0].prompt, /## 处置卡住的 job/);
  assert.match(captured[0].prompt, /agent-relay stall fake cancel\|restart <key>/);
  assert.doesNotMatch(captured[0].prompt, /个 job 在跑/);
});

test("TC-43 a running job is listed with its id and elapsed minutes", async () => {
  const captured = [];
  const pending = controlledChild();
  const { core } = harness({
    spawn: () => pending,
    adapterOverrides: { buildWorker: ({ prompt, full }) => (captured.push({ prompt, full }), { bin: "/bin/true", args: [] }) },
  });
  await core.handle(inbound({ key: "th-a", session: "fs-th-a", text: "第一条" }));
  await tick();
  await core.handle(inbound({ key: "th-b", session: "fs-th-b", dedupeId: "m2", text: "第二条" }));
  await tick();
  assert.doesNotMatch(captured[0].prompt, /个 job 在跑/);
  assert.match(captured[1].prompt, /现在有 1 个 job 在跑：/);
  assert.match(captured[1].prompt, /- job-1，已跑 \d+ 分钟/);
  assert.doesNotMatch(captured[1].prompt, /job-2/);
});
