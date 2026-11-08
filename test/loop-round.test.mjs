import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { createCore } from "../src/runtime/core.mjs";
import { emptyState } from "../src/state/schema.mjs";
import { writeJsonAtomic } from "../src/shared/json.mjs";
import { listRounds } from "../src/loops/history.mjs";
import { loopDueAt, LOOP_ROUNDS_PER_HOUR } from "../src/loops/schedule.mjs";
import { cronNext, parseCron } from "../src/loops/cron.mjs";

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
      const messageId = `n-${replies.length + 1}`;
      replies.push({ key: "notice", text, messageId });
      return { messageId };
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
  assert.equal(replies[0].key, "notice");
  assert.equal(replies[0].text, "📣📣📣 轮报\n轮次输出");
  const notice = core.state.notices[Object.keys(core.state.notices)[0]];
  assert.equal(notice.messageId, replies[0].messageId);
  assert.deepEqual(notice.reply, { mode: "conversation", key: "loop-fake-1-r1" });
  assert.equal(notice.text, undefined, "a bound notice keeps no copy of the round output");
  assert.equal(notice.prompt, undefined);
  assert.equal(core.state.loops["loop-fake-1"].lastMessageId, replies[0].messageId);
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
  const pauseNotices = Object.values(core.state.notices).filter((notice) => /连续 3 轮失败/.test(notice.text ?? ""));
  assert.equal(pauseNotices.length, 1);
});

test("TC-LR6 a round whose notice has no message id is failed and never bound", async () => {
  const { core } = harness({
    state: { loops: { "loop-fake-1": seededLoop() } },
    adapterOverrides: { postNotice: async () => ({}) },
  });
  await core.startDueLoops();
  await settle();
  const loop = core.state.loops["loop-fake-1"];
  assert.equal(loop.lastOutcome, "failed");
  assert.equal(loop.failStreak, 1);
  assert.equal(loop.lastMessageId, null);
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
  assert.equal(calls[0].messageId, "n-1");
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
  const promptFile = join(config.configDir, "prompts", "loops", "loop-fake-2", "prompt.md");
  mkdirSync(dirname(promptFile), { recursive: true });
  writeFileSync(promptFile, "看 CI\n");
  mkdirSync(config.commandDir("fake"), { recursive: true });
  writeJsonAtomic(join(config.commandDir("fake"), "2.json"), {
    op: "loop-create",
    id: "loop-fake-2",
    prompt: "",
    promptFile,
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

  const promptFile3 = join(config.configDir, "prompts", "loops", "loop-fake-3", "prompt.md");
  mkdirSync(dirname(promptFile3), { recursive: true });
  writeFileSync(promptFile3, "一次性\n");
  writeJsonAtomic(join(config.commandDir("fake"), "3.json"), {
    op: "loop-create",
    id: "loop-fake-3",
    prompt: "",
    promptFile: promptFile3,
    every: null,
    loopAt: "2026-12-01T00:00:00.000Z",
    at: new Date().toISOString(),
  });
  await core.drainCommands();
  assert.equal(core.state.loops["loop-fake-3"].at, "2026-12-01T00:00:00.000Z");
  assert.equal(core.state.loops["loop-fake-3"].every, null);
});

test("TC-LR12 a NOOP round posts nothing and still counts as a healthy round", async () => {
  const { core, replies, config } = harness({
    state: { loops: { "loop-fake-1": seededLoop() } },
    spawn: () => fakeChild({ stdout: "NOOP" }),
  });
  await core.startDueLoops();
  await settle();
  const loop = core.state.loops["loop-fake-1"];
  assert.equal(replies.length, 0, `no message for a quiet round, got ${JSON.stringify(replies)}`);
  assert.equal(loop.lastOutcome, "noop");
  assert.equal(loop.lastMessageId, null);
  assert.equal(loop.failStreak, 0);
  const rounds = listRounds(config.loopHistoryDir, "loop-fake-1");
  assert.equal(rounds[0].outcome, "noop");
});

test("TC-LR13 an empty round is quiet too, and a NOOP line above a body still posts", async () => {
  const quiet = harness({ state: { loops: { "loop-fake-1": seededLoop() } }, spawn: () => fakeChild({ stdout: "   " }) });
  await quiet.core.startDueLoops();
  await settle();
  assert.equal(quiet.replies.length, 0);
  assert.equal(quiet.core.state.loops["loop-fake-1"].lastOutcome, "noop");

  const loud = harness({ state: { loops: { "loop-fake-1": seededLoop() } }, spawn: () => fakeChild({ stdout: "今天有 2 个 PR 挂了\nNOOP" }) });
  await loud.core.startDueLoops();
  await settle();
  assert.equal(loud.replies.length, 1);
  assert.equal(loud.core.state.loops["loop-fake-1"].lastOutcome, "ok");
});

test("TC-LR14 a cron round leaves the loop armed and schedules the next cron match", async () => {
  const { core, replies } = harness({
    state: { loops: { "loop-fake-1": seededLoop({ every: null, cron: "* * * * *", createdAt: agoMinutes(5) }) } },
  });
  assert.equal(await core.startDueLoops(), 1);
  await settle();
  assert.equal(replies.length, 1);
  const loop = core.state.loops["loop-fake-1"];
  assert.equal(loop.lastOutcome, "ok");
  assert.equal(loop.state, "armed", "a cron loop never becomes done");
  assert.equal(await core.startDueLoops(), 0, "the next match is in the future");
  const due = loopDueAt(loop);
  assert.ok(Number.isFinite(due));
  assert.equal(due % 60_000, 0, "the next round is scheduled on a whole minute");
  assert.ok(due > Date.now());
});

test("TC-LR15 loop-update replaces the whole schedule and revives a done loop", async () => {
  const { core, config } = harness({
    state: { loops: { "loop-fake-1": seededLoop({ every: "10m", at: null, cron: null, state: "armed" }) } },
  });
  mkdirSync(config.commandDir("fake"), { recursive: true });
  writeJsonAtomic(join(config.commandDir("fake"), "10.json"), {
    op: "loop-update",
    id: "loop-fake-1",
    every: null,
    loopAt: null,
    cron: "0 13 * * *",
    at: new Date().toISOString(),
  });
  await core.drainCommands();
  const switched = core.state.loops["loop-fake-1"];
  assert.equal(switched.cron, "0 13 * * *");
  assert.equal(switched.every, null);
  assert.equal(switched.at, null);

  writeJsonAtomic(join(config.commandDir("fake"), "11.json"), {
    op: "loop-update",
    id: "loop-fake-1",
    every: "2h",
    loopAt: null,
    at: new Date().toISOString(),
  });
  await core.drainCommands();
  const back = core.state.loops["loop-fake-1"];
  assert.equal(back.cron, null, "an every update clears the cron schedule");
  assert.equal(back.every, "2h");

  core.state.loops["loop-fake-1"].state = "done";
  writeJsonAtomic(join(config.commandDir("fake"), "12.json"), {
    op: "loop-update",
    id: "loop-fake-1",
    every: null,
    loopAt: null,
    cron: "*/30 * * * *",
    at: new Date().toISOString(),
  });
  await core.drainCommands();
  assert.equal(core.state.loops["loop-fake-1"].state, "armed", "a done loop comes back when its schedule changes");
});

test("TC-LR16 a cron loop catches up exactly once after a long stop and does not fire while busy", async () => {
  const hanging = () => {
    const child = new EventEmitter();
    child.pid = 999999;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    return child;
  };
  const busy = harness({
    state: { loops: { "loop-fake-1": seededLoop({ every: null, cron: "* * * * *", createdAt: agoMinutes(5) }) } },
    spawn: hanging,
  });
  assert.equal(await busy.core.startDueLoops(), 1);
  const anchor = agoMinutes(30);
  busy.core.state.loops["loop-fake-1"].lastRunAt = anchor;
  assert.equal(await busy.core.startDueLoops(), 0, "the previous round is still in flight");
  assert.equal(busy.core.state.loops["loop-fake-1"].lastRunAt, anchor, "a skipped tick never moves the anchor");

  const stopped = harness({
    state: { loops: { "loop-fake-1": seededLoop({ every: null, cron: "* * * * *", createdAt: agoMinutes(3 * 24 * 60) }) } },
  });
  assert.equal(await stopped.core.startDueLoops(), 1);
  await settle();
  assert.equal(await stopped.core.startDueLoops(), 0, "three days of missed minutes still start one round");
  assert.equal(listRounds(stopped.config.loopHistoryDir, "loop-fake-1").length, 1);
});

test("TC-LR17 a dense cron expression stays under the hourly round budget", () => {
  const parsed = parseCron("*/5 * * * *");
  const start = Date.parse("2026-11-07T00:00:00+08:00");
  let at = start;
  let count = 0;
  while ((at = cronNext(parsed, at)) <= start + 3_600_000) count += 1;
  assert.equal(count, 12);
  assert.ok(count < LOOP_ROUNDS_PER_HOUR);
});

test("TC-LR18 a file-backed loop reads the file at each round start", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "relay-lrfile-")), "prompt.md");
  writeFileSync(file, "第一版规则");
  const captured = [];
  const { core } = harness({
    state: { loops: { "loop-fake-1": seededLoop({ prompt: "", promptFile: file }) } },
    spawn: () => fakeChild({ stdout: "NOOP" }),
    adapterOverrides: {
      buildWorker: ({ prompt, session }) => (captured.push({ prompt, session }), { bin: "/bin/true", args: [] }),
    },
  });
  await core.startDueLoops();
  await settle();
  assert.equal(captured.length, 1);
  assert.match(captured[0].prompt, /PROMPT-BEGIN\n第一版规则\nPROMPT-END/);

  writeFileSync(file, "第二版规则");
  core.state.loops["loop-fake-1"].lastRunAt = agoMinutes(30);
  await core.startDueLoops();
  await settle();
  assert.equal(captured.length, 2);
  assert.match(captured[1].prompt, /PROMPT-BEGIN\n第二版规则\nPROMPT-END/, "the edit landed with no loop update");
});

test("TC-LR19 an unreadable prompt file fails the round, posts nothing and counts towards the pause", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "relay-lrfile-")), "prompt.md");
  const { core, replies, config } = harness({ state: { loops: { "loop-fake-1": seededLoop({ prompt: "", promptFile: file }) } } });
  await core.startDueLoops();
  await settle();
  const round = Object.values(core.state.jobs).find((item) => item.origin === "loop");
  assert.ok(round);
  assert.equal(round.status, "failed");
  assert.equal(round.error, "prompt-unreadable");
  assert.equal(replies.length, 0, "a failed prompt resolution posts nothing");
  assert.equal(core.state.loops["loop-fake-1"].lastOutcome, "failed");
  assert.equal(core.state.loops["loop-fake-1"].failStreak, 1);
  const rounds = listRounds(config.loopHistoryDir, "loop-fake-1");
  assert.equal(rounds[0].outcome, "failed");
  assert.equal(rounds[0].error, "prompt-unreadable");
});
