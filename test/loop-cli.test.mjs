import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleLoopCommand, listLoopRows, formatLoopRows, loopPlatform, readLoops } from "../src/cli.mjs";
import { emptyState } from "../src/state/schema.mjs";
import { writeJsonAtomic } from "../src/shared/json.mjs";
import { appendRound } from "../src/loops/history.mjs";

function makeConfig() {
  const dir = mkdtempSync(join(tmpdir(), "relay-loopcli-"));
  const configDir = join(dir, ".config/agent-relay");
  return {
    home: dir,
    cwd: dir,
    configDir,
    logDir: join(dir, "logs"),
    loopHistoryDir: join(configDir, "loops"),
    stateFile: (platform) => join(configDir, `relay-${platform}.json`),
    commandDir: (platform) => join(configDir, `relay-${platform}.cmd`),
  };
}

function seed(config, platform, loops) {
  writeJsonAtomic(config.stateFile(platform), { ...emptyState(), loops });
}

function loopOf(overrides = {}) {
  return {
    id: "loop-slack-1",
    prompt: "看 CI",
    every: "30m",
    at: null,
    thread: true,
    state: "armed",
    createdAt: new Date(Date.now() - 3_600_000).toISOString(),
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

async function run(argv, config, sent = [], env = {}) {
  const out = [];
  const write = (chunk) => (out.push(String(chunk)), true);
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  process.stdout.write = write;
  process.stderr.write = write;
  process.exitCode = 0;
  const dispatch = async (cfg, platform, command) => (sent.push({ platform, command }), { delivered: true });
  try {
    await handleLoopCommand(argv, config, () => {}, { sendCommand: dispatch, env });
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
  const code = process.exitCode;
  process.exitCode = 0;
  return { code, out: out.join("") };
}

test("TC-LC1 create validates before dispatch and routes to the requested platform", async () => {
  const config = makeConfig();
  seed(config, "slack", {});
  const sent = [];
  const ok = await run(["create", "--platform", "slack", "--every", "30m", "--prompt", "看 CI"], config, sent);
  assert.equal(ok.code, 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].platform, "slack");
  assert.equal(sent[0].command.op, "loop-create");
  assert.equal(sent[0].command.id, "loop-slack-1");
  assert.equal(sent[0].command.every, "30m");
  assert.equal(sent[0].command.thread, true);

  const small = await run(["create", "--platform", "slack", "--every", "5m", "--prompt", "x"], config, sent);
  assert.equal(small.code, 3);
  assert.match(small.out, /refused: every-too-small/);

  const long = await run(["create", "--platform", "slack", "--every", "30m", "--prompt", "x".repeat(4097)], config, sent);
  assert.equal(long.code, 3);
  assert.match(long.out, /refused: prompt-too-long/);

  const noThread = await run(["create", "--platform", "slack", "--at", new Date(Date.now() + 60000).toISOString(), "--prompt", "p", "--no-thread"], config, sent);
  assert.equal(noThread.code, 0);
  assert.equal(sent.at(-1).command.thread, false);
  assert.ok(sent.at(-1).command.loopAt, "the loop's own at never overwrites the command envelope timestamp");
  assert.equal(sent.length, 2);
});

test("TC-LC2 the platform defaults to AGENT_RELAY_PLATFORM and the loop id decides the owner", async () => {
  const config = makeConfig();
  seed(config, "discord", { "loop-discord-3": loopOf({ id: "loop-discord-3", lastRunAt: new Date().toISOString() }) });
  seed(config, "slack", {});
  const sent = [];
  const env = { AGENT_RELAY_PLATFORM: "slack" };
  assert.equal(loopPlatform({}, env), "slack");
  assert.equal(loopPlatform({}, {}), "");
  assert.equal(loopPlatform({ platform: "discord" }, env), "discord");
  const created = await run(["create", "--every", "30m", "--prompt", "p"], config, sent, env);
  assert.equal(created.code, 0);
  assert.equal(sent.at(-1).platform, "slack");
  const paused = await run(["pause", "loop-discord-3"], config, sent);
  assert.equal(paused.code, 0);
  assert.equal(sent.at(-1).platform, "discord");
  assert.deepEqual(sent.at(-1).command, { op: "loop-state", id: "loop-discord-3", state: "paused" });
});

test("TC-LC3 an unknown or deleted loop is refused instead of dispatched", async () => {
  const config = makeConfig();
  seed(config, "slack", { "loop-slack-1": loopOf(), "loop-slack-2": loopOf({ id: "loop-slack-2", state: "deleted" }) });
  const sent = [];
  const missing = await run(["pause", "loop-slack-9"], config, sent);
  assert.equal(missing.code, 3);
  assert.match(missing.out, /refused: not-found/);
  const deleted = await run(["resume", "loop-slack-2"], config, sent);
  assert.equal(deleted.code, 3);
  const badId = await run(["pause", "loop-slack-x"], config, sent);
  assert.equal(badId.code, 3);
  assert.match(badId.out, /refused: bad-loop-id/);
  const noPlatform = await run(["create", "--every", "30m", "--prompt", "p"], config, sent);
  assert.equal(noPlatform.code, 3);
  assert.match(noPlatform.out, /refused: bad-platform/);
  assert.equal(sent.length, 0);
});

test("TC-LC4 the loop ceiling is enforced before dispatch", async () => {
  const config = makeConfig();
  const loops = {};
  for (let i = 1; i <= 20; i += 1) loops[`loop-slack-${i}`] = loopOf({ id: `loop-slack-${i}` });
  seed(config, "slack", loops);
  const sent = [];
  const refused = await run(["create", "--platform", "slack", "--every", "30m", "--prompt", "p"], config, sent);
  assert.equal(refused.code, 3);
  assert.match(refused.out, /refused: too-many-loops/);
  assert.equal(sent.length, 0);
});

test("TC-LC5 list merges platforms, marks overdue loops and hides deleted ones unless --all", () => {
  const config = makeConfig();
  const stale = new Date(Date.now() - 40 * 60_000).toISOString();
  seed(config, "slack", {
    "loop-slack-1": loopOf({ id: "loop-slack-1", lastRunAt: stale, lastOutcome: "ok", lastRound: 4 }),
    "loop-slack-2": loopOf({ id: "loop-slack-2", state: "deleted" }),
  });
  seed(config, "discord", { "loop-discord-1": loopOf({ id: "loop-discord-1", every: null, at: new Date(Date.now() + 3_600_000).toISOString() }) });
  const rows = listLoopRows(config, ["discord", "slack"]);
  assert.deepEqual(rows.map((row) => row.id), ["loop-discord-1", "loop-slack-1"]);
  assert.equal(rows.find((row) => row.id === "loop-slack-1").overMs > 5 * 60_000, true);
  const lines = formatLoopRows(rows);
  assert.equal(lines.length, 2);
  assert.match(lines[1], /^loop-slack-1\tarmed\tevery 30m\t.*overdue \d+m\tok\t看 CI$/);
  assert.match(lines[0], /at 20/);
  assert.equal(listLoopRows(config, ["slack"], { all: true }).length, 2);
  assert.equal(readLoops(config.stateFile("slack"))["loop-slack-1"].lastRound, 4);
});

test("TC-LC6 log and show-run read the round history, and show prints the definition", async () => {
  const config = makeConfig();
  seed(config, "slack", { "loop-slack-1": loopOf({ lastRound: 2, lastOutcome: "ok", lastRunId: "loop-slack-1-r2", failStreak: 1 }) });
  appendRound(config.loopHistoryDir, "loop-slack-1", { runId: "loop-slack-1-r1", at: "2026-11-06T00:00:00.000Z", trigger: "tick", outcome: "ok", messageId: "m1", output: "第一轮" });
  appendRound(config.loopHistoryDir, "loop-slack-1", { runId: "loop-slack-1-r2", at: "2026-11-06T00:30:00.000Z", trigger: "manual", outcome: "failed", error: "no-message-id", messageId: null, output: "第二轮" });
  const logged = await run(["log", "loop-slack-1"], config);
  assert.equal(logged.code, 0);
  assert.match(logged.out, /loop-slack-1-r2.*manual\tfailed\tno-message-id/);
  assert.ok(logged.out.indexOf("loop-slack-1-r2") < logged.out.indexOf("loop-slack-1-r1"));
  const shown = await run(["show-run", "loop-slack-1-r1"], config);
  assert.match(shown.out, /第一轮/);
  const missingRun = await run(["show-run", "loop-slack-1-r9"], config);
  assert.equal(missingRun.code, 3);
  const definition = await run(["show", "loop-slack-1"], config);
  assert.match(definition.out, /id: loop-slack-1/);
  assert.match(definition.out, /rounds: 2 {2}last: ok {2}streak: 1/);
  assert.match(definition.out, /看 CI/);
});

test("TC-LC7 run and update dispatch the right commands after validation", async () => {
  const config = makeConfig();
  seed(config, "slack", { "loop-slack-1": loopOf() });
  const sent = [];
  const manual = await run(["run", "loop-slack-1"], config, sent);
  assert.equal(manual.code, 0);
  assert.deepEqual(sent.at(-1).command, { op: "loop-run", id: "loop-slack-1" });
  const updated = await run(["update", "loop-slack-1", "--every", "2h", "--prompt", "新标准"], config, sent);
  assert.equal(updated.code, 0);
  assert.deepEqual(sent.at(-1).command, { op: "loop-update", id: "loop-slack-1", every: "2h", loopAt: null, prompt: "新标准" });
  const bad = await run(["update", "loop-slack-1", "--every", "1m"], config, sent);
  assert.equal(bad.code, 3);
  assert.match(bad.out, /refused: every-too-small/);
  const deleted = await run(["delete", "loop-slack-1"], config, sent);
  assert.deepEqual(sent.at(-1).command, { op: "loop-state", id: "loop-slack-1", state: "deleted" });
});
