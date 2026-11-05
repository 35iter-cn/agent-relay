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
import { createPlatform as createDiscord } from "../src/platforms/discord.mjs";
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
  writeFileSync(join(sectionsDir, "00-header-conversation.md"), "conversation={{conversation}} user={{user_message}}");
  writeFileSync(join(sectionsDir, "45-self-wake.md"), "SELF-WAKE {{conversation}}");
  writeFileSync(join(promptsDir, "self-job.md"), "PROVENANCE {{provenance}}\nDUE {{due_at}}\nAT {{delivered_at}}\nLATE {{late_note}}\nCHAIN {{chain}}\nBRIEF {{brief}}");
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
    reply: async (ctx, text) => replies.push({ key: ctx.key, text }),
    postNotice: async (text) => (replies.push({ key: "notice", text }), { messageId: "notice-1" }),
    selfContext: (key) => ({ chatId: "c1", threadId: null, replyTo: key }),
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

const brief = (over = {}) => ({ op: "schedule", key: "th-1", dedupe: "d1", brief: "看进度", dueAt: null, graceMs: 6 * 3_600_000, ...over });

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
  core.scheduleJob({ ...brief(), dueAt });
  clock.value += 61_000;
  assert.equal(core.startDueJobs(), 1);
  await tick();
  assert.equal(prompts.length, 1);
  assert.equal(core.startDueJobs(), 0);
  await tick();
  assert.equal(prompts.length, 1);
  const jobs = Object.values(core.state.jobs);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].lateMs, 1000);
});

test("TC-SJ3 a future job stays scheduled until its dueAt passes", async () => {
  const clock = { value: Date.parse("2026-11-05T20:00:00+08:00") };
  const { core, prompts } = harness({ clock });
  const job = core.scheduleJob({ ...brief(), dueAt: new Date(clock.value + 120_000).toISOString() });
  assert.ok(job.job);
  assert.equal(core.state.jobs[job.job].status, "scheduled");
  assert.equal(core.startDueJobs(), 0);
  await tick();
  assert.equal(prompts.length, 0);
  clock.value += 121_000;
  assert.equal(core.startDueJobs(), 1);
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
  const job = core.scheduleJob({ ...brief({ dedupe: "d-wait" }), dueAt: new Date(clock.value + 1000).toISOString() });
  clock.value += 2000;
  core.startDueJobs();
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
    const outcome = core.scheduleJob({ ...brief({ dedupe: `five-${i}` }), dueAt: new Date(clock.value - 1000).toISOString() });
    assert.ok(outcome.job, JSON.stringify(outcome));
  }
  for (let i = 0; i < 6; i += 1) {
    core.startDueJobs();
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
    const outcome = core.scheduleJob({ ...brief({ dedupe: `storm-${i}` }), dueAt });
    if (outcome.rejected) refused = outcome.rejected;
  }
  assert.equal(refused, "runaway");
  assert.equal(Object.values(core.state.jobs).filter((job) => job.status === "scheduled").length, 12);
});

test("TC-SJ7 a job past its grace expires without starting", async () => {
  const clock = { value: Date.parse("2026-11-05T20:00:00+08:00") };
  const { core, prompts } = harness({ clock });
  const job = core.scheduleJob({
    ...brief({ dedupe: "late" }),
    dueAt: new Date(clock.value + 60_000).toISOString(),
    graceMs: 6 * 3_600_000,
  });
  clock.value += 7 * 3_600_000;
  assert.equal(core.startDueJobs(), 1);
  assert.equal(core.state.jobs[job.job].status, "cancelled");
  assert.equal(core.state.jobs[job.job].error, "expired");
  await tick();
  assert.equal(prompts.length, 0);
});

test("TC-SJ8 a scheduled turn with no output posts nothing and finishes", async () => {
  const clock = { value: Date.parse("2026-11-05T20:00:00+08:00") };
  const { core, replies, logs } = harness({ clock, spawn: () => fakeChild({ stdout: "", code: 0 }) });
  const job = core.scheduleJob({ ...brief({ dedupe: "quiet" }), dueAt: null });
  await tick();
  assert.deepEqual(replies, []);
  assert.equal(core.state.jobs[job.job].status, "done");
  assert.equal(core.state.jobs[job.job].answer, null);
  assert.equal(core.state.jobs[job.job].answer, null);
});

test("TC-SJ9 a scheduled turn that exits non-zero posts one line", async () => {
  const clock = { value: Date.parse("2026-11-05T20:00:00+08:00") };
  const { core, replies } = harness({ clock, spawn: () => fakeChild({ stdout: "", code: 1 }) });
  const job = core.scheduleJob({ ...brief({ dedupe: "boom" }), dueAt: null });
  await tick();
  assert.equal(replies.length, 1);
  assert.match(replies[0].text, /无输出/);
  assert.equal(core.state.jobs[job.job].status, "failed");
});

test("TC-SJ10 a scheduled turn renders the wake template with its own brief and provenance", async () => {
  const clock = { value: Date.parse("2026-11-05T20:00:00+08:00") };
  const { core, prompts } = harness({ clock, sessions: ["fs-th-1"] });
  process.env.AGENT_RELAY_SELF_CHAIN = "0";
  core.scheduleJob({ ...brief({ dedupe: "render", brief: "读 /tmp/x 的行数" }), dueAt: null });
  delete process.env.AGENT_RELAY_SELF_CHAIN;
  await tick();
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /你自己排的/);
  assert.match(prompts[0], /读 \/tmp\/x 的行数/);
  assert.match(prompts[0], /CHAIN 1/);
  assert.doesNotMatch(prompts[0], /\{\{/);
});

test("TC-SJ11 an external schedule renders the external provenance line", async () => {
  const clock = { value: Date.parse("2026-11-05T20:00:00+08:00") };
  const { prompts } = harness({ clock, sessions: ["fs-th-1"] });
  const promptsLib = createPrompts({ dir: join(process.cwd(), "src/prompts"), userDir: "/nonexistent", configDir: undefined });
  const text = promptsLib.selfJob({
    platform: "slack",
    adapter: { surface: "本会话", chunkLimit: 8000 },
    inbound: { key: "th-1", chatId: "c1", text: "外部推来的一轮" },
    root: "",
    brief: "外部推来的一轮",
    origin: "external",
    chain: 0,
    dueAt: clock.value,
    deliveredAt: clock.value,
    lateMs: 0,
  });
  assert.match(text, /外部系统排入/);
  assert.doesNotMatch(text, /这次是你自己排的/);
  assert.match(text, /```text\n外部推来的一轮\n```/);
  assert.equal(prompts.length, 0);
});

test("TC-SJ12 cancel moves a scheduled job to cancelled and a started one is left alone", async () => {
  const clock = { value: Date.parse("2026-11-05T20:00:00+08:00") };
  const { core } = harness({ clock });
  const job = core.scheduleJob({ ...brief({ dedupe: "cancel-me" }), dueAt: new Date(clock.value + 60_000).toISOString() });
  assert.deepEqual(core.cancelScheduled({ dedupe: "cancel-me" }), { job: job.job });
  assert.equal(core.state.jobs[job.job].status, "cancelled");
  assert.equal(core.cancelScheduled({ dedupe: "cancel-me" }).rejected, "not-scheduled");
});

test("TC-SJ13 a platform without selfContext cannot be scheduled", async () => {
  const clock = { value: Date.parse("2026-11-05T20:00:00+08:00") };
  const { core, adapter } = harness({ clock });
  delete adapter.selfContext;
  assert.deepEqual(core.scheduleJob({ ...brief({ dedupe: "no-ctx" }), dueAt: null }), { rejected: "platform" });
});

test("TC-SJ14 slack and discord address a thread without a message; contract keeps selfContext optional", () => {
  const slack = createSlack({
    config: {
      readEnv: () => ({ SLACK_APP_TOKEN: "xapp", SLACK_BOT_TOKEN: "xoxb", AGENT_RELAY_SLACK_CHANNEL: "C1", AGENT_RELAY_ALLOWED_USER: "U1" }),
      envFile: (name) => `/nonexistent/${name}`,
      home: tmpdir(),
      configDir: tmpdir(),
    },
    log: () => {},
  });
  assert.deepEqual(slack.selfContext("1793850902.242119"), { chatId: "C1", threadId: null, replyTo: "1793850902.242119" });

  const discord = createDiscord({
    config: {
      readEnv: () => ({ AGENT_RELAY_DISCORD_TOKEN: "token", AGENT_RELAY_DISCORD_CHANNEL: "500", AGENT_RELAY_ALLOWED_USER: "42" }),
      envFile: (name) => `/nonexistent/${name}`,
      home: tmpdir(),
      configDir: tmpdir(),
    },
    log: () => {},
  });
  assert.deepEqual(discord.selfContext("t901"), { chatId: "901", threadId: "901", replyTo: null });
  assert.equal(discord.selfContext("nonsense"), null);

  const base = { name: "slack", start: () => {}, reply: () => {}, sessionFor: (key) => key };
  assert.doesNotThrow(() => definePlatform(base));
  assert.throws(() => definePlatform({ ...base, selfContext: "nope" }), /selfContext:function/);
});
