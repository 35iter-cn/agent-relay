import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { createCore } from "../src/runtime/core.mjs";
import { emptyState } from "../src/state/schema.mjs";
import { writeJsonAtomic } from "../src/shared/json.mjs";
import { listRounds } from "../src/loops/history.mjs";

function fakeChild({ stdout = "轮次输出", code = 0 } = {}) {
  const child = new EventEmitter();
  child.pid = 999999;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  setImmediate(() => {
    if (stdout) child.stdout.emit("data", stdout);
    child.emit("close", code);
  });
  return child;
}

function harness({ state, adapterOverrides = {}, spawn = () => fakeChild(), sections = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "relay-loop-"));
  const sessionsDir = join(dir, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const promptsDir = join(dir, "prompts");
  const sectionsDir = join(promptsDir, "sections");
  mkdirSync(sectionsDir, { recursive: true });
  if (sections) {
    writeFileSync(join(sectionsDir, "00-header-loop.md"), "LOOP={{loop_id}} ROUND={{loop_round}} LAST={{loop_last}} KEY={{conversation}}");
    writeFileSync(join(sectionsDir, "12-loop-task.md"), "PROMPT-BEGIN\n{{loop_prompt}}\nPROMPT-END");
    writeFileSync(join(sectionsDir, "20-reply.md"), "REPLY");
    writeFileSync(join(sectionsDir, "21-surface.md"), "SURFACE");
    writeFileSync(join(sectionsDir, "00-header-conversation.md"), "CONV={{conversation}} MSG={{user_message}} ROOT={{root_section}}");
    writeFileSync(join(sectionsDir, "10-task.md"), "TASK");
  }
  const configDir = join(dir, ".config/agent-relay");
  const config = {
    home: dir,
    cwd: dir,
    configDir,
    logDir: join(dir, "logs"),
    sessionsDir,
    promptsDir,
    uploadsDir: join(configDir, "uploads"),
    loopHistoryDir: join(configDir, "loops"),
    cli: "agent-relay",
    readEnv: () => ({}),
    envFile: (name) => join(configDir, name),
    stateFile: (platform) => join(configDir, `relay-${platform}.json`),
    commandDir: (platform) => join(configDir, `relay-${platform}.cmd`),
  };
  const seeded = { ...emptyState(), ...state };
  writeJsonAtomic(config.stateFile("fake"), seeded);
  const replies = [];
  const adapter = {
    name: "fake",
    allowedUser: "u-ok",
    chunkLimit: 4000,
    timeoutMs: 1000,
    maxWorkers: 2,
    queueDepth: 1,
    worker: "stub",
    piBin: "/bin/true",
    surface: "本会话",
    sessionFor: (key) => `fs-${key}`,
    reply: async (ctx, text) => {
      const messageId = `m-${replies.length + 1}`;
      replies.push({ key: ctx.key, text, messageId });
      return { messageId };
    },
    postNotice: async (text) => {
      replies.push({ key: "notice", text });
      return { messageId: `n-${replies.length}` };
    },
    ...adapterOverrides,
  };
  const logs = [];
  const core = createCore({
    adapter,
    config,
    deps: { spawn, log: (level, ...parts) => logs.push([level, ...parts].join(" ")) },
  });
  return { core, adapter, replies, logs, dir, config };
}

const settle = async (rounds = 6) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
};

const agoMinutes = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

function seededLoop(overrides = {}) {
  return {
    id: "loop-fake-1",
    prompt: "看我的 open PR 有没有 CI 挂掉",
    every: "10m",
    at: null,
    thread: true,
    state: "armed",
    createdAt: agoMinutes(60),
    createdBy: "k",
    lastRunAt: null,
    lastRunId: null,
    lastRound: 0,
    lastMessageId: null,
    lastOutcome: null,
    failStreak: 0,
    ...overrides,
  };
}

test("TC-LR1 a due loop starts a round in a fresh session and posts it to the channel", async () => {
  const { core, replies } = harness({ state: { loops: { "loop-fake-1": seededLoop() } } });
  assert.equal(await core.startDueLoops(), 1);
  await settle();
  const job = Object.values(core.state.jobs).find((item) => item.origin === "loop");
  assert.ok(job);
  assert.equal(job.key, "loop-fake-1-r1");
  assert.equal(job.session, "fs-loop-fake-1-r1");
  assert.equal(core.state.loops["loop-fake-1"].lastRound, 1);
  assert.equal(core.state.loops["loop-fake-1"].lastOutcome, "ok");
  assert.equal(replies.length, 1);
  assert.equal(replies[0].key, "loop-fake-1-r1");
  assert.equal(replies[0].text, "轮次输出");
  const run = core.state.loopRuns[replies[0].messageId];
  assert.equal(run.runId, "loop-fake-1-r1");
  assert.equal(run.key, "loop-fake-1-r1");
});

test("TC-LR2 the round prompt carries the loop prompt and the previous outcome but never the previous output", async () => {
  const captured = [];
  const { core, adapter } = harness({
    state: { loops: { "loop-fake-1": seededLoop({ lastRound: 4, lastRunId: "loop-fake-1-r4", lastRunAt: agoMinutes(30), lastOutcome: "ok" }) } },
    spawn: () => fakeChild({ stdout: "第二轮输出" }),
    adapterOverrides: {
      buildWorker: ({ prompt, session }) => (captured.push({ prompt, session }), { bin: "/bin/true", args: [] }),
    },
  });
  await core.startDueLoops();
  await settle();
  assert.equal(captured.length, 1);
  assert.match(captured[0].prompt, /LOOP=loop-fake-1 ROUND=5/);
  assert.match(captured[0].prompt, /PROMPT-BEGIN\n看我的 open PR 有没有 CI 挂掉\nPROMPT-END/);
  assert.match(captured[0].prompt, /loop-fake-1-r4/);
  assert.match(captured[0].prompt, /ok/);
  assert.doesNotMatch(captured[0].prompt, /第二轮输出/);
  assert.equal(captured[0].session, "fs-loop-fake-1-r5");
  assert.equal(typeof adapter.sessionFor, "function");
});

test("TC-LR3 replying to a round message continues that round's session", async () => {
  const { core, replies } = harness({ state: { loops: { "loop-fake-1": seededLoop() } } });
  await core.startDueLoops();
  await settle();
  const roundKey = "loop-fake-1-r1";
  assert.equal(replies.length, 1);
  const roundJob = Object.values(core.state.jobs).find((item) => item.origin === "loop");
  await core.handle({
    key: "t-other-thread",
    session: "fs-t-other-thread",
    dedupeId: "reply-1",
    authorId: "u-ok",
    text: "那个卡住的 PR 重试了吗？",
    chatId: "c1",
    replyIds: [replies[0].messageId],
  });
  await settle();
  const replyJob = Object.values(core.state.jobs).find((item) => item.inbound?.dedupeId === "reply-1");
  assert.ok(replyJob, "the reply became a job");
  assert.equal(replyJob.key, roundKey);
  assert.equal(replyJob.session, roundJob.session);
  assert.equal(core.state.convs[roundKey].session, roundJob.session);
  assert.equal(replyJob.origin, "user");
});

test("TC-LR4 a round still running keeps the next tick from starting another one", async () => {
  const hanging = () => {
    const child = new EventEmitter();
    child.pid = 999999;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    return child;
  };
  const { core } = harness({ state: { loops: { "loop-fake-1": seededLoop() } }, spawn: hanging });
  core.state.loops["loop-fake-1"].lastRunAt = agoMinutes(30);
  const started = await core.startDueLoops();
  assert.equal(started, 1);
  core.state.loops["loop-fake-1"].lastRunAt = agoMinutes(30);
  const second = await core.startDueLoops();
  assert.equal(second, 0);
  assert.equal(Object.values(core.state.jobs).filter((job) => job.origin === "loop").length, 1);
});

test("TC-LR5 three failed rounds pause the loop and raise one notice", async () => {
  const { core, replies } = harness({
    state: { loops: { "loop-fake-1": seededLoop() } },
    spawn: () => fakeChild({ stdout: "boom", code: 1 }),
  });
  for (let round = 0; round < 3; round += 1) {
    core.state.loops["loop-fake-1"].lastRunAt = agoMinutes(30);
    await core.startDueLoops();
    await settle();
  }
  const loop = core.state.loops["loop-fake-1"];
  assert.equal(loop.failStreak, 3);
  assert.equal(loop.state, "paused");
  assert.equal(replies.filter((item) => item.key === "notice").length, 1);
  assert.match(replies.find((item) => item.key === "notice").text, /连续 3 轮失败/);
});

test("TC-LR6 a round without a delivered message id is failed and never indexed", async () => {
  const { core } = harness({
    state: { loops: { "loop-fake-1": seededLoop() } },
    adapterOverrides: { reply: async () => null },
  });
  await core.startDueLoops();
  await settle();
  const loop = core.state.loops["loop-fake-1"];
  assert.equal(loop.lastOutcome, "failed");
  assert.equal(loop.failStreak, 1);
  assert.deepEqual(core.state.loopRuns, {});
});

test("TC-LR7 the hourly round budget skips the tick and warns once", async () => {
  const stamps = Array.from({ length: 20 }, () => agoMinutes(5));
  const { core, replies } = harness({ state: { loops: { "loop-fake-1": seededLoop() }, meta: { schemaVersion: 3, jobSeq: 0, noticeSeq: 0, loopRoundStamps: stamps } } });
  assert.equal(await core.startDueLoops(), 0);
  assert.equal(core.state.loops["loop-fake-1"].lastRound, 0);
  await settle();
  assert.equal(replies.filter((item) => item.key === "notice").length, 1);
});

test("TC-LR8 the thread hook receives the round key and is optional", async () => {
  const calls = [];
  const { core } = harness({
    state: { loops: { "loop-fake-1": seededLoop() } },
    adapterOverrides: { openRoundThread: async (args) => (calls.push(args), { threadId: "t-9", key: args.key }) },
  });
  await core.startDueLoops();
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].key, "loop-fake-1-r1");
  assert.equal(calls[0].messageId, "m-1");
  assert.match(calls[0].name, /loop-fake-1 第 1 轮/);

  const plain = harness({ state: { loops: { "loop-fake-1": seededLoop({ thread: false }) } }, adapterOverrides: { openRoundThread: async (args) => (calls.push(args), null) } });
  await plain.core.startDueLoops();
  await settle();
  assert.equal(calls.length, 1);
});

test("TC-LR9 loop commands start a manual round and mark a one-shot loop done", async () => {
  const { core, config } = harness({ state: { loops: { "loop-fake-1": seededLoop({ lastRunAt: new Date().toISOString() }) } } });
  mkdirSync(config.commandDir("fake"), { recursive: true });
  writeJsonAtomic(join(config.commandDir("fake"), "1.json"), { op: "loop-run", id: "loop-fake-1", at: new Date().toISOString() });
  await core.drainCommands();
  await settle();
  const job = Object.values(core.state.jobs).find((item) => item.origin === "loop");
  assert.ok(job);
  assert.equal(job.loop.trigger, "manual");

  const once = harness({ state: { loops: { "loop-fake-1": seededLoop({ every: null, at: agoMinutes(5) }) } } });
  assert.equal(await once.core.startDueLoops(), 1);
  await settle();
  assert.equal(once.core.state.loops["loop-fake-1"].state, "done");
});

test("TC-LR10 an empty loop prompt template fails the round instead of spawning a blind worker", async () => {
  let spawned = 0;
  const { core } = harness({
    state: { loops: { "loop-fake-1": seededLoop() } },
    sections: false,
    spawn: () => (spawned += 1, fakeChild()),
  });
  await core.startDueLoops();
  await settle();
  const job = Object.values(core.state.jobs).find((item) => item.origin === "loop");
  assert.equal(spawned, 0);
  assert.equal(job.status, "failed");
  assert.equal(job.error, "empty-prompt");
});

test("TC-LR11 the command envelope timestamp never becomes the loop's own schedule", async () => {
  const { core, config } = harness({ state: { loops: {} } });
  mkdirSync(config.commandDir("fake"), { recursive: true });
  writeJsonAtomic(join(config.commandDir("fake"), "2.json"), {
    op: "loop-create",
    id: "loop-fake-2",
    prompt: "看 CI",
    every: "10m",
    loopAt: null,
    thread: true,
    at: new Date().toISOString(),
  });
  await core.drainCommands();
  const created = core.state.loops["loop-fake-2"];
  assert.ok(created, "the loop was created");
  assert.equal(created.every, "10m");
  assert.equal(created.at, null);

  writeJsonAtomic(join(config.commandDir("fake"), "3.json"), {
    op: "loop-create",
    id: "loop-fake-3",
    prompt: "一次性",
    every: null,
    loopAt: "2026-12-01T00:00:00.000Z",
    at: new Date().toISOString(),
  });
  await core.drainCommands();
  assert.equal(core.state.loops["loop-fake-3"].at, "2026-12-01T00:00:00.000Z");
  assert.equal(core.state.loops["loop-fake-3"].every, null);
});
