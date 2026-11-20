import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createCore } from "../src/runtime/core.mjs";
import { DEFAULTS } from "../src/config.mjs";
import { handleRestartCommand } from "../src/cli.mjs";
import { executeRestart } from "../src/restart/execute.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROMPTS = join(HERE, "..", "src", "prompts");

function harness({ state = {}, restart = {}, deps = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "relay-restart-"));
  const configDir = join(dir, ".config/agent-relay");
  mkdirSync(configDir, { recursive: true });
  const config = {
    home: dir,
    cwd: dir,
    configDir,
    logDir: join(dir, "logs"),
    sessionsDir: join(dir, "sessions"),
    promptsDir: PROMPTS,
    userPromptsDir: join(configDir, "prompts"),
    uploadsDir: join(configDir, "uploads"),
    loopHistoryDir: join(dir, "loops"),
    cli: "agent-relay",
    readEnv: () => ({}),
    envFile: (name) => join(configDir, name),
    stateFile: (platform) => join(configDir, `relay-${platform}.json`),
    commandDir: (platform) => join(configDir, `relay-${platform}.cmd`),
    options: { relay: { ...DEFAULTS.relay, restart: { ...DEFAULTS.relay.restart, ...restart } } },
  };
  const clock = { now: Date.parse("2026-11-20T02:00:00.000Z") };
  const notices = [];
  const spawned = [];
  const adapter = {
    name: "fake",
    allowedUser: "u-ok",
    chunkLimit: 3500,
    maxWorkers: 2,
    queueDepth: 1,
    worker: "stub",
    piBin: "/bin/true",
    sessionFor: (key) => `fs-${key}`,
    reply: async (inbound, text) => (notices.push({ key: inbound.key, text }), { messageId: `m-${notices.length}` }),
    postNotice: async (text, options = {}) => (notices.push({ key: "notice", text, group: options.group ?? "" }), { messageId: `notice-${notices.length}` }),
  };
  writeFileSync(config.stateFile("fake"), JSON.stringify({ ...emptyStateLike(), ...state }));
  const core = createCore({
    adapter,
    config,
    deps: {
      now: () => clock.now,
      readBootId: () => "b1",
      log: () => {},
      spawn: (bin, args) => {
        spawned.push({ bin, args });
        return { on: () => {}, unref: () => {} };
      },
      ...deps,
    },
  });
  function logEvents() {
    const dir = join(config.logDir, "fake");
    try {
      return readdirSync(dir)
        .flatMap((name) => readFileSync(join(dir, name), "utf8").trim().split("\n"))
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  }

  async function send(command) {
    const dir = config.commandDir("fake");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `cmd-${Math.random().toString(16).slice(2)}.json`);
    writeFileSync(file, JSON.stringify({ ...command, at: new Date(clock.now).toISOString() }));
    await core.drainCommands();
    return JSON.parse(readFileSync(`${file}.result`, "utf8"));
  }
  return { core, config, clock, notices, spawned, dir, adapter, send, logEvents };
}

function emptyStateLike() {
  return { cursor: null, seen: {}, convs: {}, alerts: {}, jobs: {}, inbox: [], notices: {}, loops: {}, meta: { schemaVersion: 5, jobSeq: 0, noticeSeq: 0, loopRoundStamps: [] } };
}

function runningJob(id = "job-1") {
  return { id, status: "running", createdAt: "2026-11-20T01:50:00.000Z", updatedAt: "2026-11-20T01:59:00.000Z", kind: "conversation", key: "th-1" };
}

const noticeText = (notices) => notices.filter((item) => item.key === "notice").map((item) => item.text).join("\n");

test("TC-RS1 a running round keeps the request pending and restarts nothing", async () => {
  const { core, notices, spawned, send, logEvents } = harness({ state: { jobs: { "job-1": runningJob() } } });
  const outcome = core.state.restart;
  assert.equal(outcome, undefined);
  const sent = await send({ op: "restart", waitMs: 3_600_000 });
  assert.equal(sent.request, 1);
  assert.equal(core.state.restart.status, "pending");
  assert.equal(await core.checkRestart(), null);
  assert.equal(spawned.length, 0, "nothing is restarted while a round runs");
  const request = logEvents().find((event) => event.event === "restart-request");
  assert.equal(request.request, 1);
  assert.equal(request.replaced, null);
  assert.equal(request.active, 1);
  assert.equal(noticeText(notices), "", "a queued request is not pushed to the user");
});

test("TC-RS2 an idle platform logs the restart and spawns the one-shot unit", async () => {
  const { core, notices, spawned, send, logEvents } = harness();
  await send({ op: "restart", waitMs: 3_600_000 });
  assert.equal(await core.checkRestart(), "stopping");
  assert.equal(core.state.restart.status, "stopping");
  assert.equal(logEvents().filter((event) => event.event === "restart-stopping").length, 1);
  assert.equal(noticeText(notices), "", "the new instance's boot notice is the receipt, not a second message");
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].bin, "systemd-run");
  assert.ok(spawned[0].args.includes("--unit=relay-restart-fake"));
  assert.deepEqual(spawned[0].args.slice(-8), ["restart", "--execute", "--platform", "fake", "--unit", "agent-relay@fake", "--request", "1"]);
});

test("TC-RS3 a newer request replaces the older one: one slot, seq grows, deadline resets", async () => {
  const { core, clock, logEvents, send } = harness();
  await send({ op: "restart", waitMs: 3_600_000 });
  const first = core.state.restart;
  clock.now += 5 * 60_000;
  const sent = await send({ op: "restart", waitMs: 30 * 60_000 });
  assert.equal(sent.request, 2);
  assert.equal(sent.superseded, 1);
  assert.equal(core.state.restart.seq, 2);
  assert.notEqual(core.state.restart.deadlineAt, first.deadlineAt);
  assert.equal(core.state.restart.deadlineAt, "2026-11-20T02:35:00.000Z");
  const requests = logEvents().filter((event) => event.event === "restart-request");
  assert.deepEqual(requests.map((event) => [event.request, event.replaced]), [[1, null], [2, 1]]);
});

test("TC-RS4 --wait 0 has no deadline and never expires", async () => {
  const { core, clock, spawned, send } = harness();
  await send({ op: "restart", waitMs: 0 });
  assert.equal(core.state.restart.deadlineAt, null);
  clock.now += 7 * 3_600_000;
  assert.equal(core.state.restart.status, "pending");
  assert.equal(spawned.length, 0);
});

test("TC-RS5 a request that never finds an idle platform expires and restarts nothing", async () => {
  const { core, clock, notices, spawned, send } = harness({ state: { jobs: { "job-1": runningJob() } } });
  await send({ op: "restart", waitMs: 60 * 60_000 });
  clock.now += 61 * 60_000;
  assert.equal(await core.checkRestart(), "expired");
  assert.equal(core.state.restart.status, "expired");
  assert.match(noticeText(notices), /Restart dropped \(request 1\): 1 round\(s\) still running after 61 min/);
  assert.ok(notices.some((item) => item.group === "system"), "expiry goes to the system group");
  assert.equal(spawned.length, 0);
});

test("TC-RS6 a round that finished inside the settle window still blocks the restart", async () => {
  const { core, clock, spawned, send } = harness({
    state: { jobs: { "job-1": { ...runningJob(), status: "done", updatedAt: "2026-11-20T02:00:05.000Z" } } },
  });
  await send({ op: "restart", waitMs: 3_600_000 });
  assert.equal(await core.checkRestart(), null, "a reply that is still on its way out holds the restart");
  clock.now += 20_000;
  assert.equal(await core.checkRestart(), "stopping");
  assert.equal(spawned.length, 1);
});

test("TC-RS7 cancel drops a pending request and refuses one already stopping", async () => {
  const { core, notices, send, logEvents } = harness();
  const pending = await send({ op: "restart", waitMs: 3_600_000 });
  assert.equal(pending.request, 1);
  const cancelled = await send({ op: "restart-cancel" });
  assert.equal(cancelled.outcome, "cancelled");
  assert.equal(core.state.restart.status, "cancelled");
  assert.equal(await core.checkRestart(), null);
  assert.equal(logEvents().filter((event) => event.event === "restart-cancel").length, 1);
  assert.equal(noticeText(notices), "", "cancelling is the caller's own action");

  await send({ op: "restart", waitMs: 3_600_000 });
  await core.checkRestart();
  const refused = await send({ op: "restart-cancel" });
  assert.equal(refused.refused, "already-stopping");
});

test("TC-RS8 a request that arrives during a restart becomes the next one", async () => {
  const { core, send } = harness();
  await send({ op: "restart", waitMs: 3_600_000 });
  await core.checkRestart();
  assert.equal(core.state.restart.status, "stopping");
  const sent = await send({ op: "restart", waitMs: 3_600_000 });
  assert.equal(sent.request, 2);
  assert.equal(sent.superseded, 1);
  assert.equal(core.state.restart.status, "pending");
});

test("TC-RS9 the boot notice closes a requested restart", async () => {
  const { core, notices, send } = harness();
  await send({ op: "restart", waitMs: 3_600_000 });
  await core.checkRestart();
  assert.equal(await core.onReady(), true);
  assert.match(noticeText(notices), /relay is up[\s\S]*restart of request 1 completed \(waited 0 min, 0 round\(s\) finished\)/);
  assert.equal(core.state.restart.status, "done");
});

test("TC-RS10 the executor reports a dead unit and a healthy one", async () => {
  const calls = [];
  const systemctl = async (...args) => {
    calls.push(args.join(" "));
    if (args[0] === "restart") return "";
    if (args[0] === "is-active") return "active";
    return calls.filter((line) => line.startsWith("show")).length > 1 ? "9001" : "9000";
  };
  const ok = await executeRestart({ unit: "agent-relay@fake", request: 3, systemctl, healthMs: 50, sleep: () => {} });
  assert.equal(ok.code, 0);
  assert.equal(ok.before, "9000");
  assert.equal(ok.pid, "9001");

  const stuck = async (...args) => (args[0] === "is-active" ? "active" : "9000");
  const failed = await executeRestart({ unit: "agent-relay@fake", request: 4, systemctl: stuck, healthMs: 30, sleep: () => {} });
  assert.equal(failed.code, 1, "an unchanged MainPID never counts as a restart");
});

function runCli(argv, config, deps) {
  const out = [];
  const err = [];
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  process.stdout.write = (chunk) => (out.push(String(chunk)), true);
  process.stderr.write = (chunk) => (err.push(String(chunk)), true);
  process.exitCode = 0;
  return handleRestartCommand(argv, config, () => {}, deps)
    .then(() => {
      const code = process.exitCode;
      process.exitCode = 0;
      return { code, out: out.join(""), err: err.join("") };
    })
    .finally(() => {
      process.stdout.write = stdout;
      process.stderr.write = stderr;
      process.exitCode = 0;
    });
}

test("TC-RS11 one restart command fans out to every platform, one line each", async () => {
  const { config } = harness();
  const sent = [];
  const dispatch = async (cfg, platform, command) => {
    sent.push({ platform, command });
    return { delivered: true, result: { ok: true, request: platform === "feishu" ? 4 : 12, superseded: null } };
  };
  const result = await runCli(["--wait", "30m"], config, { sendCommand: dispatch, PLATFORMS: ["feishu", "slack"] });
  assert.equal(result.code, 0);
  assert.equal(result.out, "feishu: queued (request 4)\nslack: queued (request 12)\n");
  assert.deepEqual(sent.map((item) => item.platform), ["feishu", "slack"]);
  assert.equal(sent[0].command.waitMs, 30 * 60_000);
});

test("TC-RS12 a refused wait value never reaches a daemon", async () => {
  const { config } = harness();
  const sent = [];
  const result = await runCli(["--wait", "soon"], config, { sendCommand: async (c, p, cmd) => (sent.push(cmd), { delivered: true, result: { request: 1 } }) });
  assert.equal(result.code, 3);
  assert.match(result.err, /refused: wait-invalid/);
  assert.equal(sent.length, 0);
});

test("TC-RS13 a daemon that predates the verb is restarted directly, and a refusal stays a refusal", async () => {
  const { config } = harness({ restart: { healthMs: 50 } });
  const pids = new Map([["agent-relay@feishu", "7000"], ["agent-relay@slack", "8000"]]);
  const systemctl = async (...args) => {
    const unit = args[1];
    if (args[0] === "is-active") return unit === "agent-relay@slack" ? "active" : "inactive";
    if (args[0] === "restart") {
      pids.set(unit, String(Number(pids.get(unit) ?? "0") + 1));
      return "";
    }
    return pids.get(unit) ?? "0";
  };
  const dispatch = async (cfg, platform) => {
    if (platform === "slack") return { delivered: true, result: { ok: false, refused: "unknown-command" } };
    return { delivered: false };
  };
  const old = await runCli([], config, { sendCommand: dispatch, systemctl, PLATFORMS: ["feishu", "slack"], sleep: () => {} });
  assert.equal(old.code, 1);
  assert.match(old.out, /feishu: daemon not running; unit not active, skipped/);
  assert.match(old.out, /slack: daemon not running; restarted directly \(pid 8000 -> 8001\)/);

  const refused = await runCli([], config, {
    sendCommand: async () => ({ delivered: true, result: { ok: false, refused: "already-stopping" } }),
    PLATFORMS: ["slack"],
  });
  assert.equal(refused.code, 3);
  assert.match(refused.out, /slack: refused: already-stopping/);
});

test("TC-RS14 status reads each platform's slot, and cancel goes through the daemon", async () => {
  const { config } = harness({ state: { restart: { seq: 7, status: "pending", requestedAt: new Date(Date.now() - 3 * 60_000).toISOString(), deadlineAt: new Date(Date.now() + 57 * 60_000).toISOString() } } });
  const status = await runCli(["status"], config, { PLATFORMS: ["fake", "slack"] });
  assert.match(status.out, /fake: request 7 pending, 3 min waited, deadline /);
  assert.match(status.out, /slack: nothing pending/);

  const cancelled = await runCli(["cancel"], config, {
    sendCommand: async (cfg, platform) => (platform === "fake" ? { delivered: true, result: { ok: true, request: 7, outcome: "cancelled" } } : { delivered: false }),
    PLATFORMS: ["fake", "slack"],
  });
  assert.equal(cancelled.code, 1);
  assert.match(cancelled.out, /fake: cancelled \(request 7\)/);
  assert.match(cancelled.out, /slack: daemon not running; nothing to cancel/);
});

test("TC-RS15 the restart shows a human two messages, both in the system group and in English", async () => {
  const { core, notices, send } = harness();
  await send({ op: "restart", waitMs: 3_600_000 });
  await core.checkRestart();
  await core.onReady();
  const rows = notices.filter((item) => item.key === "notice");
  assert.equal(rows.length, 1, "only the boot notice is posted here");
  for (const row of rows) assert.equal(row.group, "system");
  for (const row of rows) assert.doesNotMatch(row.text, /[\u4e00-\u9fff]/);

  const templates = readdirSync(join(PROMPTS, "messages")).filter((name) => name.startsWith("restart-"));
  assert.deepEqual(templates.sort(), ["restart-expired.md", "restart-failed.md"], "only what needs a human is a template");
  for (const name of templates) assert.doesNotMatch(readFileSync(join(PROMPTS, "messages", name), "utf8"), /[\u4e00-\u9fff]/, `${name} is English`);
});
