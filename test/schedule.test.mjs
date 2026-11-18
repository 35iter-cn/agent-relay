import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCore } from "../src/runtime/core.mjs";
import { createPrompts } from "../src/runtime/prompts.mjs";
import { emptyState } from "../src/state/schema.mjs";
import { pruneState } from "../src/state/prune.mjs";
import { createJob } from "../src/jobs/model.mjs";
import { definePlatform } from "../src/platforms/contract.mjs";
import { createPlatform as createSlack } from "../src/platforms/slack.mjs";
import { writeJsonAtomic } from "../src/shared/json.mjs";

function fakeChild({ stdout = "", code = 0 } = {}) {
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

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

function harness({ state = emptyState(), spawn, sessions = [], clock } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "relay-schedule-"));
  const sessionsDir = join(dir, "sessions");
  const promptsDir = join(dir, "prompts");
  const configDir = join(dir, ".config/agent-relay");
  const sectionsDir = join(promptsDir, "sections");
  for (const path of [sessionsDir, promptsDir, sectionsDir, configDir]) mkdirSync(path, { recursive: true });
  for (const name of sessions) writeFileSync(join(sessionsDir, `2026-01-01T00-00-00_${name}.jsonl`), "{}\n");
  writeFileSync(join(sectionsDir, "10-common.md"), "COMMON");
  writeFileSync(join(sectionsDir, "30-entry-conversation.md"), "CONV {{user_message}}");
  mkdirSync(join(promptsDir, "messages"), { recursive: true });
  writeFileSync(join(promptsDir, "messages", "restart.md"), "RESTART");
  writeFileSync(join(promptsDir, "messages", "stall-notice.md"), "STALL {{job}}");
  const config = {
    home: dir,
    cwd: dir,
    configDir,
    logDir: join(dir, "logs"),
    sessionsDir,
    promptsDir,
    userPromptsDir: join(configDir, "prompts"),
    uploadsDir: join(configDir, "uploads"),
    cli: "agent-relay",
    readEnv: () => ({}),
    envFile: (name) => join(configDir, name),
    stateFile: (platform) => join(configDir, `relay-${platform}.json`),
    commandDir: (platform) => join(configDir, `relay-${platform}.cmd`),
  };
  const stateFile = config.stateFile("fake");
  writeJsonAtomic(stateFile, state);
  const replies = [];
  const logs = [];
  const prompts = [];
  const adapter = {
    name: "fake",
    allowedUser: "u-ok",
    chunkLimit: 2000,
    timeoutMs: 60_000,
    maxWorkers: 2,
    queueDepth: 1,
    worker: "stub",
    piBin: "/bin/true",
    sessionFor: (key) => `fs-${key}`,
    reply: async (ctx, text) => (replies.push({ key: ctx.key, replyTo: ctx.replyTo, text }), { messageId: `m-${replies.length}` }),
    postNotice: async (text) => (replies.push({ key: "notice", text }), { messageId: "notice-1" }),
    selfContext: (key) => ({ chatId: "c1", threadId: null, replyTo: null, boundKey: key }),
    buildWorker: ({ prompt }) => (prompts.push(prompt), { bin: "/bin/true", args: [] }),
  };
  const core = createCore({
    adapter,
    config,
    deps: {
      spawn: spawn ?? (() => fakeChild({ stdout: "ok" })),
      log: (level, ...parts) => logs.push([level, ...parts].join(" ")),
      now: clock ? () => clock.value : undefined,
    },
  });
  core.state.convs["th-1"] = { session: "fs-th-1", rootText: "起点", lastMsgTs: null, activeJob: null };
  function command(payload) {
    const dirPath = config.commandDir("fake");
    mkdirSync(dirPath, { recursive: true });
    writeFileSync(join(dirPath, `${Date.now()}-1.json`), JSON.stringify({ at: new Date().toISOString(), ...payload }));
  }
  return { core, config, replies, logs, prompts, stateFile, command, adapter };
}

const brief = (over = {}) => ({ op: "schedule", key: "th-1", name: "d1", prompt: "看进度", dueAt: null, graceMs: 6 * 3_600_000, ...over });

test("TC-SJ1 a scheduled job keeps its state and an old job without dueAt never looks scheduled", async () => {
  const state = emptyState();
  const plain = createJob(state, { key: "th-1", session: "fs-th-1", dedupeId: "old", text: "hi" });
  plain.updatedAt = new Date(Date.now() - 40 * 86_400_000).toISOString();
  plain.status = "done";
  state.jobs[plain.id] = plain;
  const pending = createJob(state, { key: "th-1", session: "fs-th-1", dedupeId: "sched", text: "later" });
  pending.status = "scheduled";
  pending.dueAt = new Date(Date.now() + 3_600_000).toISOString();
  pending.createdAt = new Date(Date.now() - 40 * 86_400_000).toISOString();
  pending.updatedAt = pending.createdAt;
  state.jobs[pending.id] = pending;

  const kept = pruneState(state, Date.now());
  assert.equal(kept, 1);
  assert.equal(state.jobs[pending.id].status, "scheduled");
  assert.equal(state.jobs[plain.id], undefined);
});

test("TC-SJ2 a due job starts once and records how late it was", async () => {
  const clock = { value: Date.parse("2026-11-05T20:00:00+08:00") };
  const { core, prompts } = harness({ clock });
  const dueAt = new Date(clock.value + 60_000).toISOString();
  await core.scheduleJob({ ...brief(), dueAt });
  clock.value += 61_000;
  assert.equal(await core.startDueJobs(), 1);
  await tick();
  assert.equal(prompts.length, 1);
  assert.equal(await core.startDueJobs(), 0);
  await tick();
  assert.equal(prompts.length, 1);
  const jobs = Object.values(core.state.jobs);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].lateMs, 1000);
});

test("TC-SJ3 a future job stays scheduled until its dueAt passes", async () => {
  const clock = { value: Date.parse("2026-11-05T20:00:00+08:00") };
  const { core, prompts } = harness({ clock });
  const job = await core.scheduleJob({ ...brief(), dueAt: new Date(clock.value + 120_000).toISOString() });
  assert.ok(job.job);
  assert.equal(core.state.jobs[job.job].status, "scheduled");
  assert.equal(await core.startDueJobs(), 0);
  await tick();
  assert.equal(prompts.length, 0);
  clock.value += 121_000;
  assert.equal(await core.startDueJobs(), 1);
  await tick();
  assert.equal(prompts.length, 1);
});

test("TC-SJ4 while the same key is busy the due job keeps waiting instead of queueing", async () => {
  const clock = { value: Date.parse("2026-11-05T20:00:00+08:00") };
  const hold = new EventEmitter();
  hold.pid = 999998;
  hold.stdout = new EventEmitter();
  hold.stderr = new EventEmitter();
  hold.kill = () => {};
  const { core, prompts } = harness({ clock, spawn: () => hold });
  await core.handle({ key: "th-1", session: "fs-th-1", dedupeId: "msg-1", authorId: "u-ok", text: "用户的活", chatId: "c1" });
  const job = await core.scheduleJob({ ...brief({ name: "d-wait" }), dueAt: new Date(clock.value + 1000).toISOString() });
  clock.value += 2000;
  await core.startDueJobs();
  assert.equal(core.state.jobs[job.job].status, "scheduled");
  assert.equal(core.state.inbox.length, 0);
  assert.ok(core.state.jobs[job.job].waitLoggedAt);
  await tick();
  assert.equal(core.state.jobs[job.job].status, "scheduled");
});

test("TC-SJ5 five due jobs are all accepted and started without any interval or quota", async () => {
  const clock = { value: Date.parse("2026-11-05T20:00:00+08:00") };
  const { core, prompts } = harness({ clock });
  for (let i = 0; i < 5; i += 1) {
    const outcome = await core.scheduleJob({ ...brief({ name: `five-${i}` }), dueAt: new Date(clock.value - 1000).toISOString() });
    assert.ok(outcome.job, JSON.stringify(outcome));
  }
  for (let i = 0; i < 6; i += 1) {
    await core.startDueJobs();
    await tick();
  }
  assert.equal(prompts.length, 5);
});

test("TC-SJ6 the thirteenth schedule inside an hour is refused as runaway", async () => {
  const clock = { value: Date.parse("2026-11-05T20:00:00+08:00") };
  const { core } = harness({ clock });
  const dueAt = new Date(clock.value + 3_600_000).toISOString();
  let refused = null;
  for (let i = 0; i < 13; i += 1) {
    const outcome = await core.scheduleJob({ ...brief({ name: `storm-${i}` }), dueAt });
    if (outcome.rejected) refused = outcome.rejected;
  }
  assert.equal(refused, "runaway");
  assert.equal(Object.values(core.state.jobs).filter((job) => job.status === "scheduled").length, 12);
});

test("TC-SJ7 a job past its grace expires without starting", async () => {
  const clock = { value: Date.parse("2026-11-05T20:00:00+08:00") };
  const { core, prompts } = harness({ clock });
  const job = await core.scheduleJob({
    ...brief({ name: "late" }),
    dueAt: new Date(clock.value + 60_000).toISOString(),
    graceMs: 6 * 3_600_000,
  });
  clock.value += 7 * 3_600_000;
  assert.equal(await core.startDueJobs(), 1);
  assert.equal(core.state.jobs[job.job].status, "cancelled");
  assert.equal(core.state.jobs[job.job].error, "expired");
  await tick();
  assert.equal(prompts.length, 0);
});

test("TC-SJ8 a scheduled turn with no output posts nothing and finishes", async () => {
  const clock = { value: Date.parse("2026-11-05T20:00:00+08:00") };
  const { core, replies, logs } = harness({ clock, spawn: () => fakeChild({ stdout: "", code: 0 }) });
  const job = await core.scheduleJob({ ...brief({ name: "quiet" }), dueAt: null });
  await tick();
  assert.deepEqual(replies, []);
  assert.equal(core.state.jobs[job.job].status, "done");
  assert.equal(core.state.jobs[job.job].answer, null);
  assert.equal(core.state.jobs[job.job].answer, null);
});

test("TC-SJ15 a scheduled turn that answers the quiet word posts nothing and finishes", async () => {
  for (const raw of ["NOOP", "`NOOP`"]) {
    const clock = { value: Date.parse("2026-11-05T20:00:00+08:00") };
    const { core, replies } = harness({ clock, spawn: () => fakeChild({ stdout: raw, code: 0 }) });
    const job = await core.scheduleJob({ ...brief({ name: "quiet-word" }), dueAt: null });
    await tick();
    assert.deepEqual(replies, [], `${JSON.stringify(raw)} is not a message: ${JSON.stringify(replies)}`);
    assert.equal(core.state.jobs[job.job].status, "done");
    assert.equal(core.state.jobs[job.job].answer, null);
  }
});

test("TC-SJ9 a scheduled turn that exits non-zero posts one line", async () => {
  const clock = { value: Date.parse("2026-11-05T20:00:00+08:00") };
  const { core, replies } = harness({ clock, spawn: () => fakeChild({ stdout: "", code: 1 }) });
  const job = await core.scheduleJob({ ...brief({ name: "boom" }), dueAt: null });
  await tick();
  assert.equal(replies.length, 1);
  assert.match(replies[0].text, /中途退出/);
  assert.equal(core.state.jobs[job.job].status, "failed");
});

test("TC-SJ10 a scheduled turn sends the origin line and the brief, no template", async () => {
  const clock = { value: Date.parse("2026-11-05T20:00:00+08:00") };
  const { core, prompts } = harness({ clock, sessions: ["fs-th-1"] });
  core.scheduleJob({ ...brief({ name: "render", prompt: "读 /tmp/x 的行数" }), dueAt: null });
  await tick();
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /^\[relay\] kind=scheduled name=render at=/);
  assert.match(prompts[0], /读 \/tmp\/x 的行数/);
  assert.doesNotMatch(prompts[0], /\{\{/);
  assert.doesNotMatch(prompts[0], /COMMON|CONV/);
});

test("TC-SJ11 a cold session gets the rules before the task", () => {
  const promptsLib = createPrompts({ dir: join(process.cwd(), "src/prompts"), userDir: "/nonexistent", configDir: undefined });
  const text = promptsLib.scheduled({
    platform: "slack",
    adapter: { surface: "本会话", chunkLimit: 8000 },
    inbound: { key: "th-1", chatId: "c1", text: "外部推来的一轮" },
    brief: "外部推来的一轮",
    full: true,
  });
  assert.match(text, /你是我的个人助理/);
  assert.ok(text.indexOf("## 回复规则") < text.indexOf("外部推来的一轮"));
  assert.doesNotMatch(text, /\{\{/);
});

test("TC-SJ12 cancel moves a scheduled job to cancelled and a started one is left alone", async () => {
  const clock = { value: Date.parse("2026-11-05T20:00:00+08:00") };
  const { core } = harness({ clock });
  const job = await core.scheduleJob({ ...brief({ name: "cancel-me" }), dueAt: new Date(clock.value + 60_000).toISOString() });
  assert.deepEqual(core.cancelScheduled({ name: "cancel-me" }), { job: job.job });
  assert.equal(core.state.jobs[job.job].status, "cancelled");
  assert.equal(core.cancelScheduled({ name: "cancel-me" }).rejected, "already-started");
});

test("TC-SJ13 a platform without selfContext cannot be scheduled", async () => {
  const clock = { value: Date.parse("2026-11-05T20:00:00+08:00") };
  const { core, adapter } = harness({ clock });
  delete adapter.selfContext;
  assert.deepEqual(await core.scheduleJob({ ...brief({ name: "no-ctx" }), dueAt: null }), { rejected: "platform" });
});

test("TC-SJ14 slack keeps the conversation key and says which keys are already message ids", () => {
  const slack = createSlack({
    config: {
      readEnv: () => ({ SLACK_APP_TOKEN: "xapp", SLACK_BOT_TOKEN: "xoxb", AGENT_RELAY_SLACK_CHANNEL: "C1", AGENT_RELAY_ALLOWED_USER: "U1" }),
      envFile: (name) => `/nonexistent/${name}`,
      home: tmpdir(),
      configDir: tmpdir(),
    },
    log: () => {},
  });
  assert.deepEqual(slack.selfContext("1793850902.242119"), { chatId: "C1", threadId: null, replyTo: null, boundKey: "1793850902.242119" });
  assert.deepEqual(slack.selfContext("sentry-fixer-slack-r82").boundKey, "sentry-fixer-slack-r82");
  assert.equal(slack.resolveThread("1793850902.242119"), "1793850902.242119");
  assert.equal(slack.resolveThread("sentry-fixer-slack-r82"), null);
  assert.equal(slack.resolveThread("notice-ntc-166"), null);

  const base = { name: "slack", start: () => {}, reply: () => {}, sessionFor: (key) => key };
  assert.doesNotThrow(() => definePlatform(base));
  assert.throws(() => definePlatform({ ...base, selfContext: "nope" }), /selfContext:function/);
  assert.throws(() => definePlatform({ ...base, resolveThread: "nope" }), /resolveThread:function/);
});

test("TC-SJ16 a scheduled turn threads under the conversation's bound message, a notice's own message, or the channel top", async () => {
  const clock = { value: Date.parse("2026-11-05T20:00:00+08:00") };
  const { core, replies } = harness({ clock });
  core.state.convs["loop-fake-1-r7"] = { session: "fs-1", rootText: "轮次", lastMsgTs: null, messageId: "1794981707.262569", activeJob: null };
  core.state.convs["notice-ntc-1"] = { session: "fs-2", rootText: "通知", lastMsgTs: null, messageId: null, activeJob: null };
  core.state.notices["ntc-1"] = { id: "ntc-1", messageId: "1794474032.795939", reply: { mode: "conversation", key: "notice-ntc-1" } };
  core.state.convs["loop-fake-1-r8"] = { session: "fs-3", rootText: "空轮", lastMsgTs: null, messageId: null, activeJob: null };

  for (const [key, name] of [["loop-fake-1-r7", "round"], ["notice-ntc-1", "notice"], ["loop-fake-1-r8", "bare"]]) {
    const made = await core.scheduleJob({ op: "schedule", key, name, prompt: "看进度", dueAt: null, graceMs: 6 * 3_600_000 });
    assert.ok(made.job, `${name} scheduled`);
    await tick();
  }

  const byKey = Object.fromEntries(replies.map((item) => [item.key, item.replyTo]));
  assert.equal(byKey["loop-fake-1-r7"], "1794981707.262569", "a round's own message is the thread root");
  assert.equal(byKey["notice-ntc-1"], "1794474032.795939", "a notice conversation threads under that notice");
  assert.equal(byKey["loop-fake-1-r8"], null, "nothing recorded and no platform answer: the channel top");
  assert.equal(Object.values(core.state.jobs).every((job) => job.status === "done"), true, "no delivery failed");
});

test("TC-SJ17 a key that is already a message id needs no recorded message", async () => {
  const clock = { value: Date.parse("2026-11-05T20:00:00+08:00") };
  const { core, replies, adapter } = harness({ clock });
  adapter.resolveThread = (key) => (/^\d{10}\.\d+$/.test(String(key)) ? String(key) : null);
  core.state.convs["1794206521.110229"] = { session: "fs-4", rootText: "真人线程", lastMsgTs: null, messageId: null, activeJob: null };
  await core.scheduleJob({ op: "schedule", key: "1794206521.110229", name: "human", prompt: "看进度", dueAt: null, graceMs: 6 * 3_600_000 });
  await tick();
  assert.equal(replies[0].replyTo, "1794206521.110229", "a user thread's key is a message id, so it is used as-is");
});

test("TC-SJ18 a job scheduled before the fix still lands on the round's message after the upgrade", async () => {
  const clock = { value: Date.parse("2026-11-16T21:56:00+08:00") };
  const seed = emptyState();
  seed.meta.schemaVersion = 3;
  seed.convs["sentry-fixer-slack-r2"] = { session: "fs-r2", rootText: "第 2 轮", lastMsgTs: null, activeJob: null };
  seed.notices["ntc-84"] = { id: "ntc-84", messageId: "1794812345.000100", sentAt: "2026-11-09T10:00:00.000Z", reply: { mode: "conversation", key: "sentry-fixer-slack-r2" } };
  const legacy = createJob(seed, { key: "sentry-fixer-slack-r2", session: "fs-r2", dedupeId: "sentry-recheck-legacy", text: "复核", chatId: "c1", replyTo: "sentry-fixer-slack-r2" });
  legacy.status = "scheduled";
  legacy.dueAt = new Date(clock.value - 60_000).toISOString();
  legacy.expiresAt = new Date(clock.value + 6 * 3_600_000).toISOString();
  seed.jobs[legacy.id] = legacy;
  seed.seen[legacy.inbound.dedupeId] = legacy.id;

  const { core, replies } = harness({ clock, state: seed });
  assert.equal(core.state.convs["sentry-fixer-slack-r2"].messageId, "1794812345.000100", "the bound notice backfills the conversation's message");
  assert.equal(core.state.jobs[legacy.id].inbound.boundKey, "sentry-fixer-slack-r2", "the legacy reply target becomes the bound key");
  assert.equal(core.state.jobs[legacy.id].inbound.replyTo, null);

  await core.startDueJobs();
  await tick();
  assert.equal(replies.length, 1);
  assert.equal(replies[0].replyTo, "1794812345.000100", "the redelivery lands in the round's thread");
  assert.equal(core.state.jobs[legacy.id].status, "done");
});

test("TC-SC1 --join turns a scheduled turn into a wake turn", async () => {
  const clock = { value: Date.parse("2026-11-05T20:00:00+08:00") };
  const { core } = harness({ clock, spawn: () => fakeChild({ stdout: "" }) });
  const job = await core.scheduleJob({ ...brief({ name: "late" }), dueAt: null, join: true });
  await tick();
  assert.equal(core.state.jobs[job.job].kind, "wake");
});

test("TC-SC2 without --join the turn stays scheduled and waits its turn", async () => {
  const clock = { value: Date.parse("2026-11-05T20:00:00+08:00") };
  const { core } = harness({ clock, spawn: () => fakeChild({ stdout: "" }) });
  const job = await core.scheduleJob({ ...brief({ name: "plain" }), dueAt: null });
  await tick();
  assert.equal(core.state.jobs[job.job].kind, "scheduled");
});

function rpcChild({ answer = "答案" } = {}) {
  const child = new EventEmitter();
  child.pid = 770001;
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
      const ok = (data) => setImmediate(() => child.stdout.emit("data", `${JSON.stringify({ id: record.id, type: "response", command: record.type, success: true, data })}\n`));
      if (record.type === "get_state") return ok({ sessionId: "fs-th-1", messageCount: 2, isStreaming: streaming, pendingMessageCount: 0 });
      if (record.type === "prompt") {
        child.prompted += 1;
        streaming = true;
        ok({ disposition: "started" });
        if (!child.hold) setImmediate(() => child.settle());
        return;
      }
      if (record.type === "steer") return ok({ disposition: "queued" });
      if (record.type === "clear_queue") return ok({ steering: [], followUp: [] });
      return ok({});
    },
    end: () => {},
    on: () => {},
  };
  child.settle = () => {
    child.stdout.emit("data", `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: answer }], stopReason: "stop" } })}\n`);
    streaming = false;
    child.stdout.emit("data", `${JSON.stringify({ type: "agent_settled", aborted: false })}\n`);
  };
  child.kill = () => {};
  return child;
}

test("TC-SC3 a --join schedule lands as a steer on the running turn instead of a new job", async () => {
  const child = rpcChild();
  child.hold = true;
  const { core, replies, adapter } = harness({ spawn: () => child });
  adapter.worker = "pi";
  adapter.workerMode = "rpc";
  await core.handle({ key: "th-1", session: "fs-th-1", dedupeId: "m1", messageId: "m1", text: "第一问", chatId: "c1", authorId: "u-ok" });
  await tick();
  assert.equal(child.prompted, 1, "the first message started the turn");
  const before = Object.keys(core.state.jobs).length;
  const made = await core.scheduleJob({ ...brief({ name: "late-wake" }), dueAt: null, join: true });
  assert.ok(made.outcome === "steered", `steered, got ${JSON.stringify(made)}`);
  assert.equal(Object.keys(core.state.jobs).length, before, "no extra job is created");
  const active = core.state.jobs[core.state.convs["th-1"].activeJob];
  assert.equal((active.steers ?? []).length, 1, "the result is queued on the running turn");
  assert.equal((active.steers ?? [])[0].kind, "wake");
  child.settle();
});

test("TC-SC4 a --join schedule on an idle conversation still starts its own round", async () => {
  const child = rpcChild();
  const { core, adapter } = harness({ spawn: () => child });
  adapter.worker = "pi";
  adapter.workerMode = "rpc";
  const made = await core.scheduleJob({ ...brief({ name: "idle-wake" }), dueAt: null, join: true });
  assert.ok(made.job, `started a round, got ${JSON.stringify(made)}`);
  assert.equal(core.state.jobs[made.job].kind, "wake");
});

test("TC-SC5 a due wake job merges into a running turn instead of queueing behind it", async () => {
  const clock = { value: Date.parse("2026-11-05T20:00:00+08:00") };
  const child = rpcChild();
  child.hold = true;
  const { core, adapter } = harness({ spawn: () => child, clock });
  adapter.worker = "pi";
  adapter.workerMode = "rpc";
  const made = await core.scheduleJob({ ...brief({ name: "due-wake" }), dueAt: new Date(clock.value + 1000).toISOString(), join: true });
  await core.handle({ key: "th-1", session: "fs-th-1", dedupeId: "m1", messageId: "m1", text: "第一问", chatId: "c1", authorId: "u-ok" });
  await tick();
  clock.value += 3000;
  await core.startDueJobs();
  await tick();
  const wakeJob = core.state.jobs[made.job];
  assert.equal(wakeJob.status, "done", "the due job closed as merged");
  assert.ok(wakeJob.mergedInto, "it recorded where it went");
  assert.equal(core.state.jobs[wakeJob.mergedInto].steers.length, 1, "the running turn picked it up");
  child.settle();
});
