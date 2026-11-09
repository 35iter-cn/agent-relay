import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { createCore, DELIVERY_BACKOFF_MS } from "../src/runtime/core.mjs";
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

function harness({ spawn, replies = [], adapterOverrides = {}, state = emptyState(), sessions = [], deps = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "relay-core-"));
  const sessionsDir = join(dir, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  for (const name of sessions) writeFileSync(join(sessionsDir, `2026-01-01T00-00-00_${name}.jsonl`), "{}\n");
  const promptsDir = join(dir, "prompts");
  mkdirSync(promptsDir, { recursive: true });
  const sectionsDir = join(promptsDir, "sections");
  mkdirSync(sectionsDir, { recursive: true });
  writeFileSync(join(sectionsDir, "00-header-conversation.md"), "conversation={{conversation}} user={{user_message}} root={{root_section}} platform={{platform}} surface={{surface}} chunk={{chunk_limit}} section={{stall_section}} actions={{stall_actions}}");
  writeFileSync(join(sectionsDir, "10-task.md"), "TASK");
  writeFileSync(join(sectionsDir, "20-reply.md"), "REPLY");
  writeFileSync(join(sectionsDir, "40-stall.md"), "STALL-TAIL");
  writeFileSync(join(sectionsDir, "01-header-notice.md"), "NOTICE id={{notice_id}} prompt={{notice_prompt}} user={{user_message}} root={{root_section}}");
  writeFileSync(join(sectionsDir, "11-notice-task.md"), "NOTICE-TASK");
  writeFileSync(join(promptsDir, "stall-instructions.md"), "STALL-INSTRUCTIONS");
  writeFileSync(join(promptsDir, "stall-actions.md"), "ACTIONS platform={{platform}} key=<key>");
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
    reply: async (inbound, text) => (replies.push({ key: inbound.key, text }), { messageId: `m-${replies.length}` }),
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
  assert.match(captured[0].prompt, /REPLY/);
  assert.doesNotMatch(captured[0].prompt, /\{\{/);
});

test("TC-2b an empty first-turn prompt fails the job instead of spawning a blind worker", async () => {
  let spawned = 0;
  const built = harness({ spawn: () => (spawned += 1, fakeChild({ stdout: "ok" })) });
  const sectionsDir = join(built.dir, "prompts", "sections");
  for (const name of readdirSync(sectionsDir)) rmSync(join(sectionsDir, name));
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
  assert.deepEqual(Object.keys(readJson(stateFile, {})), ["cursor", "seen", "convs", "alerts", "jobs", "inbox", "notices", "loops", "meta"]);
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

test("TC-5 a worker over an explicitly configured timeout is killed as a process group", async () => {
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

test("TC-44 without a configured timeout a long worker is left to finish", async () => {
  const { spawn } = await import("node:child_process");
  const replies = [];
  const started = Date.now();
  const { core } = harness({
    spawn,
    replies,
    adapterOverrides: {
      timeoutMs: 0,
      chunkLimit: 500,
      buildWorker: () => ({ bin: process.execPath, args: ["-e", "setTimeout(() => console.log('finished'), 400)"] }),
    },
  });
  await core.handle(inbound());
  while (!replies.length && Date.now() - started < 5000) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(Date.now() - started >= 400, "the worker was cut short");
  assert.equal(replies.length, 1);
  assert.doesNotMatch(replies[0].text, /已终止|超过/);
  assert.match(replies[0].text, /finished/);
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
        return { messageId: `m-${observed.length}` };
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

test("TC-DL1 a reply that returns no message id counts as a failure and is retried", async () => {
  let calls = 0;
  const { core } = harness({
    spawn: () => fakeChild({ stdout: "答案" }),
    deps: { deliveryRetryMs: 0 },
    adapterOverrides: {
      reply: async () => {
        calls += 1;
        return undefined;
      },
    },
  });
  await core.handle(inbound());
  await tick();
  const job = core.state.jobs[core.state.seen.m1];
  assert.equal(calls, 3, "空返回不再算发送成功，三次都试过");
  assert.equal(job.status, "failed");
  assert.equal(job.error, "reply-failed");
  assert.equal(job.answer, "答案", "内容留着，还能手动重发");
  assert.equal(job.deliveryAttempts, 3);
  assert.equal(job.deliveryError, "no-message-id: reply returned no messageId");
  assert.deepEqual(job.parts, [], "没发出去的分片不留痕迹，否则重发会跳过它");
});

test("TC-DL2 a failure that cannot succeed on a retry is attempted exactly once", async () => {
  let calls = 0;
  const { core } = harness({
    spawn: () => fakeChild({ stdout: "答案" }),
    deps: { deliveryRetryMs: 0 },
    adapterOverrides: {
      reply: async () => {
        calls += 1;
        throw Object.assign(new Error("invalid_thread_ts"), { retryable: false, code: "invalid_thread_ts" });
      },
    },
  });
  await core.handle(inbound());
  await tick();
  const job = core.state.jobs[core.state.seen.m1];
  assert.equal(calls, 1);
  assert.equal(job.status, "failed");
  assert.equal(job.deliveryAttempts, 1);
  assert.equal(job.deliveryError, "invalid_thread_ts");
});

test("TC-DL3 a failed chunk is retried without resending the chunks before it", async () => {
  const texts = [];
  let failedOnce = false;
  const answer = "a".repeat(20) + "b".repeat(20) + "c".repeat(5);
  const { core } = harness({
    spawn: () => fakeChild({ stdout: answer }),
    deps: { deliveryRetryMs: 0 },
    adapterOverrides: {
      reply: async (ctx, text) => {
        texts.push(text);
        if (text.startsWith("b") && !failedOnce) {
          failedOnce = true;
          return null;
        }
        return { messageId: `m-${texts.length}` };
      },
    },
  });
  await core.handle(inbound());
  await tick();
  const job = core.state.jobs[core.state.seen.m1];
  assert.equal(job.status, "done");
  assert.deepEqual(job.parts.map((part) => part.i), [0, 1, 2]);
  assert.equal(texts.length, 4, "第一个分片只发一次，第二个失败了重发一次，然后接着发第三个");
  assert.equal(texts[0], "a".repeat(20));
  assert.equal(texts[1], "b".repeat(20));
  assert.equal(texts[2], "b".repeat(20));
  assert.equal(texts[3], "c".repeat(5));
});

test("TC-DL4 the retry backoff grows instead of hammering the platform", async () => {
  assert.deepEqual(DELIVERY_BACKOFF_MS, [1_500, 5_000, 15_000]);
  const waits = [];
  const { core } = harness({
    spawn: () => fakeChild({ stdout: "答案" }),
    deps: { deliveryBackoffMs: [0, 0, 0] },
    adapterOverrides: {
      reply: async () => {
        waits.push(waits.length);
        return null;
      },
    },
  });
  await core.handle(inbound());
  await tick();
  assert.equal(waits.length, 3, "三次尝试之间等两次，等多久由 DELIVERY_BACKOFF_MS 决定");
});

test("TC-DL5 a reply that landed despite the error is found, not sent twice", async () => {
  const texts = [];
  let located = 0;
  const { core } = harness({
    spawn: () => fakeChild({ stdout: "答案正文" }),
    deps: { deliveryRetryMs: 0 },
    adapterOverrides: {
      reply: async (ctx, text) => {
        texts.push(text);
        return null;
      },
      locateReply: async () => {
        located += 1;
        return "m-located";
      },
    },
  });
  await core.handle(inbound());
  await tick();
  const job = core.state.jobs[core.state.seen.m1];
  assert.equal(texts.length, 1, "只发过一次，第二次靠查重收下");
  assert.equal(located, 1);
  assert.equal(job.status, "done");
  assert.equal(job.parts[0].messageId, "m-located");
  assert.equal(job.parts[0].located, true);
});

test("TC-DL5b the lookup window is anchored to the first failure, not the last retry", async () => {
  const windows = [];
  const { core } = harness({
    spawn: () => fakeChild({ stdout: "答案正文" }),
    deps: { deliveryBackoffMs: [5, 5, 5] },
    adapterOverrides: {
      reply: async () => null,
      locateReply: async (ctx, { since }) => {
        windows.push(since);
        return null;
      },
    },
  });
  await core.handle(inbound());
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(windows.length, 2, "查重只在重试时发生");
  assert.equal(new Set(windows).size, 1, "两次查重都用第一次失败的时刻，否则上一次可能已落地的消息会落在窗口外");
});

test("TC-RD1 a failed delivery is resent by redeliver once the platform is back", async () => {
  let broken = true;
  const { core } = harness({
    spawn: () => fakeChild({ stdout: "答案" }),
    deps: { deliveryRetryMs: 0 },
    adapterOverrides: {
      reply: async () => {
        if (broken) return null;
        return { messageId: "m-redelivered" };
      },
    },
  });
  await core.handle(inbound());
  await tick();
  const jobId = core.state.seen.m1;
  assert.equal(core.state.jobs[jobId].status, "failed");
  broken = false;
  const outcome = await core.redeliver({ job: jobId });
  assert.equal(outcome.outcome, "done");
  const job = core.state.jobs[jobId];
  assert.equal(job.status, "done");
  assert.equal(job.parts[0].messageId, "m-redelivered");
  assert.equal(job.answer, undefined, "发出去之后正文才回收");
});

test("TC-RD2 redeliver refuses a job whose answer is already gone", async () => {
  const { core } = harness({ spawn: () => fakeChild({ stdout: "答案" }) });
  await core.handle(inbound());
  await tick();
  const jobId = core.state.seen.m1;
  assert.equal(core.state.jobs[jobId].status, "done");
  const outcome = await core.redeliver({ job: jobId });
  assert.equal(outcome.outcome, "nothing-to-redeliver");
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
  assert.match(boot.text, /^📣📣📣 启动\n系统已启动/);
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
  const { core, replies, dir, sessionsDir, clock, job } = await runningJob({
    spawn: closingSpawn(),
    adapterOverrides: { chunkLimit: 1000 },
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

test("TC-29 a reply with one image posts the text first, then the media, and records both", async () => {
  const delivered = [];
  const posted = [];
  let shot = null;
  const { core, dir } = harness({
    spawn: () => fakeChild({ stdout: `结论\n![](${shot})` }),
    adapterOverrides: {
      reply: async (ctx, text) => {
        delivered.push({ text, replyTo: ctx.replyTo });
        return { messageId: `m-${delivered.length}` };
      },
      postMedia: async (ctx, files) => {
        posted.push({ files, replyTo: ctx.replyTo });
        return { messageId: null, degraded: false };
      },
    },
  });
  shot = join(dir, "shot.png");
  writeFileSync(shot, "png");
  await core.handle(inbound({ replyTo: "1792.0001" }));
  await tick();
  const job = core.state.jobs[core.state.seen.m1];
  assert.equal(job.status, "done");
  assert.deepEqual(delivered.map((item) => item.text), ["结论"]);
  assert.equal(delivered[0].replyTo, "1792.0001");
  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0].files.map((file) => file.path), [shot]);
  assert.equal(posted[0].files[0].mime, "image/png");
  assert.equal(posted[0].replyTo, "1792.0001");
  assert.deepEqual(job.parts.map((part) => part.kind ?? "text"), ["text", "media"]);
  assert.equal(job.parts[1].hash.length, 16);
  assert.equal(job.parts[1].messageId, null);
});

test("TC-30 a failed media step is retried without resending the text", async () => {
  const delivered = [];
  let attempts = 0;
  let shot = null;
  const { core, dir } = harness({
    spawn: () => fakeChild({ stdout: `结论\n![](${shot})` }),
    deps: { deliveryRetryMs: 0 },
    adapterOverrides: {
      reply: async (ctx, text) => {
        delivered.push(text);
        return { messageId: `m-${delivered.length}` };
      },
      postMedia: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("slack down");
        return { messageId: null };
      },
    },
  });
  shot = join(dir, "shot.png");
  writeFileSync(shot, "png");
  await core.handle(inbound());
  await tick();
  const job = core.state.jobs[core.state.seen.m1];
  assert.equal(job.status, "done");
  assert.deepEqual(delivered, ["结论"], "the text is sent exactly once");
  assert.equal(attempts, 2, "the media step is retried");
  assert.deepEqual(job.parts.map((part) => part.kind ?? "text"), ["text", "media"]);
});

test("TC-31 an adapter without postMedia keeps the image line as plain text", async () => {
  const delivered = [];
  let shot = null;
  const { core, dir } = harness({
    spawn: () => fakeChild({ stdout: `结论\n![](${shot})` }),
    adapterOverrides: {
      reply: async (ctx, text) => {
        delivered.push(text);
        return { messageId: `m-${delivered.length}` };
      },
    },
  });
  shot = join(dir, "shot.png");
  writeFileSync(shot, "png");
  await core.handle(inbound());
  await tick();
  const job = core.state.jobs[core.state.seen.m1];
  assert.equal(job.status, "done");
  const whole = delivered.join("");
  assert.match(whole, /^结论/);
  assert.equal(whole.includes(`![](${shot})`), true, "the reference stays in the text verbatim");
  assert.equal(job.parts.length, delivered.length, "every chunk is recorded as a text part");
  assert.equal(job.parts.every((part) => part.kind === undefined), true, "no media step is planned");
});

test("TC-NT7 an emit command carries its title into the posted body", async () => {
  const { core, replies, dir } = harness();
  const cmdDir = join(dir, ".config/agent-relay/relay-fake.cmd");
  mkdirSync(cmdDir, { recursive: true });
  writeFileSync(join(cmdDir, "1-emit.json"), JSON.stringify({ op: "emit", text: "今日累计 8 小时", title: "工时", at: new Date().toISOString() }));
  assert.equal(await core.drainCommands(), 1);
  assert.equal(replies[0].text, "📣📣📣 工时\n今日累计 8 小时");
  const notice = core.state.notices[Object.keys(core.state.notices)[0]];
  assert.equal(notice.text, "📣📣📣 工时\n今日累计 8 小时");
});

test("TC-NT8 inbound text is never parsed as a command: /stop queues behind the running turn", async () => {
  const spawned = [];
  const { core } = harness({
    adapterOverrides: { maxWorkers: 1 },
    spawn: () => {
      const child = controlledChild();
      spawned.push(child);
      return child;
    },
  });
  await core.handle(inbound({ dedupeId: "a", text: "做点事" }));
  assert.equal(await core.handle(inbound({ dedupeId: "b", text: "/stop" })), "accepted");
  const first = core.state.jobs[core.state.seen.a];
  assert.equal(first.status, "running", "the running turn keeps running");
  assert.equal(spawned.length, 1);
  const queued = Object.values(core.state.jobs).find((job) => job.id !== first.id);
  assert.equal(queued.status, "queued");
  assert.equal(queued.inbound.text, "/stop");
  assert.notEqual(core.state.seen.b, "legacy");
});

function fakeRpcChild({ sessionId = "fs-th-abc", isStreaming = true, answer = "答案", stopReason = "stop", aborted = false, messageCount = 3, pendingMessageCount = 0, hold = false } = {}) {
  const child = new EventEmitter();
  child.pid = 888001;
  child.written = [];
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.prompted = 0;
  let streaming = false;
  child.stdin = {
    writable: true,
    write: (chunk) => {
      const record = JSON.parse(String(chunk).trim());
      child.written.push(record);
      const respond = (data) => setImmediate(() => child.stdout.emit("data", `${JSON.stringify({ id: record.id, type: "response", command: record.type, success: true, data })}\n`));
      if (record.type === "get_state") return respond({ sessionId, messageCount, isStreaming: streaming || isStreaming, pendingMessageCount: child.pendingMessageCount ?? pendingMessageCount });
      if (record.type === "prompt") {
        child.prompted += 1;
        streaming = true;
        respond({ disposition: "started" });
        const settle = () => {
          if (answer !== null) child.stdout.emit("data", `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: answer }], stopReason } })}\n`);
          streaming = false;
          child.stdout.emit("data", `${JSON.stringify({ type: "agent_settled", aborted })}\n`);
        };
        if (hold) child.settle = settle;
        else setImmediate(settle);
        return;
      }
      if (record.type === "steer") return respond({ disposition: "queued" });
      if (record.type === "clear_queue") return respond({ steering: [], followUp: [] });
      return respond({});
    },
    end: () => {},
    on: () => {},
  };
  child.kill = () => {};
  return child;
}

test("TC-RPC6 rpc mode sends the rendered prompt over the protocol and delivers the run's answer", async () => {
  const child = fakeRpcChild({ answer: "改好了" });
  const { core, replies } = harness({ spawn: () => child, adapterOverrides: { worker: "pi", workerMode: "rpc" } });
  await core.handle(inbound({ text: "改一下" }));
  await tick();
  const prompt = child.written.find((record) => record.type === "prompt");
  assert.ok(prompt, "a prompt command was sent");
  assert.match(prompt.message, /conversation=th-abc/);
  assert.equal(replies.at(-1).text, "改好了");
});

test("TC-RPC7 images travel as image blocks with an untouched body; other files are appended as paths", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-attach-"));
  writeFileSync(join(dir, "a.png"), Buffer.from([1, 2, 3]));
  writeFileSync(join(dir, "b.pdf"), "pdf-bytes");
  const child = fakeRpcChild({ answer: "ok" });
  const { core } = harness({ spawn: () => child, adapterOverrides: { worker: "pi", workerMode: "rpc" } });
  await core.handle(inbound({ text: "看图", attachments: [{ path: join(dir, "a.png"), mime: "image/png" }, { path: join(dir, "b.pdf"), mime: "application/pdf" }] }));
  await tick();
  const prompt = child.written.find((record) => record.type === "prompt");
  assert.equal(prompt.images.length, 1);
  assert.equal(prompt.images[0].mimeType, "image/png");
  assert.equal(prompt.images[0].data, Buffer.from([1, 2, 3]).toString("base64"));
  assert.match(prompt.message, /看图/);
  assert.ok(prompt.message.endsWith("b.pdf"), "the non-image path is appended at the end");
  assert.doesNotMatch(prompt.message, /pdf-bytes/);
  assert.doesNotMatch(prompt.message, /a\.png/);
});

test("TC-RPC8 an empty run reports the stop reason and an aborted run fails", async () => {
  const empty = fakeRpcChild({ answer: null });
  const first = harness({ spawn: () => empty, adapterOverrides: { worker: "pi", workerMode: "rpc" } });
  await first.core.handle(inbound({ text: "做点事" }));
  await tick();
  assert.equal(first.replies.at(-1).text, "[无输出] stop=stop");

  const aborted = fakeRpcChild({ answer: "一半", aborted: true });
  const second = harness({ spawn: () => aborted, adapterOverrides: { worker: "pi", workerMode: "rpc" } });
  await second.core.handle(inbound({ text: "做点事" }));
  await tick();
  assert.equal(second.replies.at(-1).text, "一半");
  assert.equal(Object.values(second.core.state.jobs).at(-1).status, "failed");
});

test("TC-RPC9 a second message lands as a steer on the running job instead of a new job", async () => {
  const child = fakeRpcChild({ answer: "答案" });
  const { core, replies } = harness({ spawn: () => child, adapterOverrides: { worker: "pi", workerMode: "rpc" } });
  await core.handle(inbound({ text: "第一句" }));
  await core.handle(inbound({ text: "第二句", dedupeId: "m2" }));
  await tick();
  const jobs = Object.values(core.state.jobs);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].steers.length, 1);
  assert.equal(jobs[0].steers[0].text, "第二句");
  assert.equal(child.written.filter((record) => record.type === "steer").length, 1);
  assert.equal(replies.length, 1);
});

test("TC-RPC10 the same key reuses one rpc child across turns", async () => {
  let spawned = 0;
  const { core } = harness({
    spawn: () => (spawned += 1, fakeRpcChild({ answer: "ok" })),
    adapterOverrides: { worker: "pi", workerMode: "rpc" },
    sessions: ["fs-th-abc"],
  });
  await core.handle(inbound({ text: "一" }));
  await tick();
  await core.handle(inbound({ text: "二", dedupeId: "m2" }));
  await tick();
  assert.equal(spawned, 1);
});

test("TC-RPC12 a steer gets a receipt on the steered message and the receipt is removed after delivery", async () => {
  const child = fakeRpcChild({ answer: "答案", hold: true });
  const receipts = [];
  const removed = [];
  const { core } = harness({
    spawn: () => child,
    adapterOverrides: {
      worker: "pi",
      workerMode: "rpc",
      addReceipt: async ({ messageId }) => (receipts.push(messageId), { messageId, name: "mark" }),
      removeReceipt: async ({ receipt }) => removed.push(receipt.messageId),
    },
  });
  await core.handle(inbound({ text: "第一句", messageId: "m-1", chatId: "c1" }));
  await tick();
  await core.handle(inbound({ text: "插一句", dedupeId: "m2", messageId: "m-2", chatId: "c1" }));
  await tick();
  child.settle();
  await tick();
  assert.deepEqual(receipts, ["m-2"]);
  assert.deepEqual(removed, ["m-2"]);
  const job = Object.values(core.state.jobs)[0];
  assert.deepEqual(job.receipts, []);
  assert.equal(job.steers[0].messageId, "m-2");
});

test("TC-RPC13 an unconsumed steer drops its receipt and re-sends on the steered message", async () => {
  const child = fakeRpcChild({ answer: "答案", pendingMessageCount: 1, hold: true });
  child.pendingMessageCount = 1;
  const removed = [];
  const { core } = harness({
    spawn: () => child,
    adapterOverrides: {
      worker: "pi",
      workerMode: "rpc",
      addReceipt: async ({ messageId }) => ({ messageId, name: "mark" }),
      removeReceipt: async ({ receipt }) => removed.push(receipt.messageId),
    },
  });
  await core.handle(inbound({ text: "第一句", messageId: "m-1", chatId: "c1" }));
  await tick();
  await core.handle(inbound({ text: "插一句", dedupeId: "m2", messageId: "m-2", chatId: "c1" }));
  await tick();
  child.pendingMessageCount = 1;
  child.settle();
  await tick();
  await tick();
  const jobs = Object.values(core.state.jobs);
  const resend = jobs.find((job) => job.auto === "steer-resend");
  assert.ok(removed.includes("m-2"), "the receipt is dropped before the resend job starts");
  if (resend) assert.equal(resend.inbound.messageId, "m-2");
});
