import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createCore } from "../src/runtime/core.mjs";
import { DEFAULTS } from "../src/config.mjs";
import { handleRestartCommand } from "../src/cli.mjs";
import { executeRestart, spawnDetachedRestart } from "../src/restart/execute.mjs";
import { restartHelp } from "../src/restart/help.mjs";

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
        return fakeChild();
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

// systemd-run exits as soon as systemd owns the job; a double that never reports its
// exit would leave the caller waiting for a process that already succeeded.
function fakeChild({ code = 0, signal = null, silent = false } = {}) {
  const child = {
    on(event, callback) {
      if (!silent && event === "close") setImmediate(() => callback(code, signal));
      return child;
    },
    unref: () => child,
    kill: () => true,
  };
  return child;
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

test("TC-RS9b a service restart closes the slot even when no boot notice is posted", async () => {
  // The boot id survives a service restart, so the boot notice usually does not fire;
  // the slot still has to close, or `restart status` says "stopping" forever.
  const { core, logEvents, send } = harness({ state: { meta: { schemaVersion: 5, jobSeq: 0, noticeSeq: 0, loopRoundStamps: [], bootNotice: { bootId: "b1", at: "2026-11-20T01:00:00.000Z" } } } });
  await send({ op: "restart", waitMs: 3_600_000 });
  await core.checkRestart();
  assert.equal(core.state.restart.status, "stopping");
  assert.equal(await core.onReady(), false, "no boot notice: the boot id did not change");
  assert.equal(core.state.restart.status, "done");
  assert.equal(logEvents().filter((event) => event.event === "restart-done").length, 1);
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
    return { delivered: true, result: { ok: true, request: platform === "probe" ? 4 : 12, superseded: null } };
  };
  // The platform list is injectable, which is what keeps the fan-out covered now that
  // only one adapter ships: the loop is unchanged, its length is not.
  const result = await runCli(["--wait", "30m"], config, { sendCommand: dispatch, PLATFORMS: ["probe", "slack"] });
  assert.equal(result.code, 0);
  assert.equal(result.out, "probe: queued (request 4)\nslack: queued (request 12)\n");
  assert.deepEqual(sent.map((item) => item.platform), ["probe", "slack"]);
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

test("TC-RS13 a daemon that predates the verb is restarted detached, and a refusal stays a refusal", async () => {
  const { config } = harness({ restart: { healthMs: 50 } });
  const systemctl = async (...args) => (args[0] === "is-active" && args[1] === "agent-relay@slack" ? "active" : "inactive");
  const spawned = [];
  const dispatch = async (cfg, platform) => {
    if (platform === "slack") return { delivered: true, result: { ok: false, refused: "unknown-command" } };
    return { delivered: false };
  };
  const old = await runCli([], config, {
    sendCommand: dispatch,
    systemctl,
    PLATFORMS: ["probe", "slack"],
    spawn: (bin, args) => (spawned.push({ bin, args }), fakeChild()),
  });
  assert.equal(old.code, 1);
  assert.match(old.out, /probe: daemon not running; unit not active, skipped/);
  assert.match(old.out, /slack: daemon too old for this verb; restarted directly \(detached\)/);
  assert.equal(spawned.length, 1, "only the active unit is restarted");
  assert.equal(spawned[0].bin, "systemd-run");
  assert.ok(spawned[0].args.includes("--unit=relay-restart-slack"));
  assert.deepEqual(spawned[0].args.slice(-8), ["restart", "--execute", "--platform", "slack", "--unit", "agent-relay@slack", "--request", "0"]);
  const refused = await runCli([], config, {
    sendCommand: async () => ({ delivered: true, result: { ok: false, refused: "already-stopping" } }),
    PLATFORMS: ["slack"],
  });
  assert.equal(refused.code, 3);
  assert.match(refused.out, /slack: refused: already-stopping/);
});

test("TC-RS13b cancelling nothing is a no-op, not a refusal", async () => {
  const { config } = harness();
  const result = await runCli(["cancel"], config, {
    sendCommand: async () => ({ delivered: true, result: { ok: false, refused: "nothing-pending" } }),
    PLATFORMS: ["slack"],
  });
  assert.equal(result.code, 0);
  assert.match(result.out, /slack: nothing pending/);
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

test("TC-RS16 the help says the command returns before the restart happens", () => {
  const text = restartHelp("restart");
  assert.match(text, /returns as soon as the request is queued; the waiting happens in the daemon/);
  assert.doesNotMatch(text, /[\u4e00-\u9fff]/);
});

test("TC-RS17 a detached restart settles on systemd-run's exit, not on the spawn call", async () => {
  const calls = [];
  const logged = [];
  const ok = await spawnDetachedRestart({
    platform: "fake",
    unit: "agent-relay@fake",
    request: 1,
    spawn: (bin, args) => (calls.push({ bin, args }), fakeChild({ code: 0 })),
    log: (level, tag, message) => logged.push({ level, tag, message }),
  });
  assert.equal(ok, true);
  assert.ok(calls[0].args.includes("--no-block"), "systemd-run hands the job over instead of running it in the caller");

  const failed = await spawnDetachedRestart({
    platform: "fake",
    unit: "agent-relay@fake",
    request: 1,
    spawn: () => fakeChild({ code: 1 }),
    log: (level, tag, message) => logged.push({ level, tag, message }),
  });
  assert.equal(failed, false, "a systemd-run that failed is a restart that did not happen");
  assert.match(logged.at(-1).message, /systemd-run exited with 1/);

  const silent = await spawnDetachedRestart({
    platform: "fake",
    unit: "agent-relay@fake",
    request: 1,
    spawn: () => fakeChild({ silent: true }),
    exitMs: 5,
  });
  assert.equal(silent, false, "a systemd-run that never returns is not a success either");

  const threw = await spawnDetachedRestart({
    platform: "fake",
    unit: "agent-relay@fake",
    request: 1,
    spawn: () => {
      throw new Error("ENOENT");
    },
  });
  assert.equal(threw, false);
});

test("TC-RS18 a direct restart nobody registered is reported, not printed as done", async () => {
  const { config } = harness({ restart: { spawnMs: 500 } });
  const spawned = [];
  const result = await runCli([], config, {
    sendCommand: async () => ({ delivered: true, result: { ok: false, refused: "unknown-command" } }),
    systemctl: async () => "active",
    PLATFORMS: ["slack"],
    spawn: (bin, args) => (spawned.push({ bin, args }), fakeChild({ code: 1 })),
  });
  assert.equal(result.code, 1);
  assert.match(result.out, /slack: daemon too old for this verb; could not start the restart unit/);
  assert.doesNotMatch(result.out, /restarted directly/);
  assert.equal(spawned.length, 1);
});

test("TC-RS19 a restart unit that never got registered falls back to the unit itself", async () => {
  const calls = [];
  const { core, send, logEvents } = harness({
    deps: { spawn: (bin, args) => (calls.push({ bin, args }), fakeChild({ code: 1 })) },
  });
  await send({ op: "restart", waitMs: 3_600_000 });
  assert.equal(await core.checkRestart(), "stopping");
  assert.equal(logEvents().filter((event) => event.event === "restart-fallback").length, 1);
  assert.deepEqual(calls.map((call) => call.bin), ["systemd-run", "systemctl"], "the fallback restarts the unit itself");
});
