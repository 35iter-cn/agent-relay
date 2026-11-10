import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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

function promptFileFor(config, id, text = "看 CI\n") {
  const file = join(config.configDir, "prompts", "loops", id, "prompt.md");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
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
  const file = promptFileFor(config, "watch-slack");
  const ok = await run(["create", "--platform", "slack", "--every", "30m", "--slug", "watch", "--prompt-file", file], config, sent);
  assert.equal(ok.code, 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].platform, "slack");
  assert.equal(sent[0].command.op, "loop-create");
  assert.equal(sent[0].command.id, "watch-slack");
  assert.equal(sent[0].command.promptFile, file);
  assert.equal(sent[0].command.prompt, "");
  assert.equal(sent[0].command.every, "30m");
  assert.equal(sent[0].command.thread, true);

  const small = await run(["create", "--platform", "slack", "--every", "5m", "--slug", "watch", "--prompt-file", file], config, sent);
  assert.equal(small.code, 3);
  assert.match(small.out, /refused: every-too-small/);

  const long = await run(["create", "--platform", "slack", "--every", "30m", "--slug", "watch", "--prompt", "x".repeat(4097), "--allow-inline"], config, sent);
  assert.equal(long.code, 3);
  assert.match(long.out, /refused: prompt-too-long/);

  const noThread = await run(["create", "--platform", "slack", "--at", new Date(Date.now() + 60000).toISOString(), "--slug", "probe", "--prompt-file", promptFileFor(config, "probe-slack", "p\n"), "--no-thread"], config, sent);
  assert.equal(noThread.code, 0);
  assert.equal(sent.at(-1).command.thread, false);
  assert.ok(sent.at(-1).command.loopAt, "the loop's own at never overwrites the command envelope timestamp");
  assert.equal(sent.length, 2);
});

test("TC-LC2 the platform defaults to AGENT_RELAY_PLATFORM and the loop id decides the owner", async () => {
  const config = makeConfig();
  seed(config, "feishu", { "loop-feishu-3": loopOf({ id: "loop-feishu-3", lastRunAt: new Date().toISOString() }) });
  seed(config, "slack", {});
  const sent = [];
  const env = { AGENT_RELAY_PLATFORM: "slack" };
  assert.equal(loopPlatform({}, env), "slack");
  assert.equal(loopPlatform({}, {}), "");
  assert.equal(loopPlatform({ platform: "feishu" }, env), "feishu");
  const created = await run(["create", "--every", "30m", "--slug", "probe", "--prompt", "p", "--allow-inline"], config, sent, env);
  assert.equal(created.code, 0);
  assert.equal(sent.at(-1).platform, "slack");
  const paused = await run(["pause", "loop-feishu-3"], config, sent);
  assert.equal(paused.code, 0);
  assert.equal(sent.at(-1).platform, "feishu");
  assert.deepEqual(sent.at(-1).command, { op: "loop-state", id: "loop-feishu-3", state: "paused" });
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
  const refused = await run(["create", "--platform", "slack", "--every", "30m", "--slug", "over", "--prompt", "p", "--allow-inline"], config, sent);
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
  seed(config, "feishu", { "loop-feishu-1": loopOf({ id: "loop-feishu-1", every: null, at: new Date(Date.now() + 3_600_000).toISOString() }) });
  const rows = listLoopRows(config, ["slack", "feishu"]);
  assert.deepEqual(rows.map((row) => row.id), ["loop-feishu-1", "loop-slack-1"]);
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
  const updated = await run(["update", "loop-slack-1", "--every", "2h", "--prompt", "新标准", "--allow-inline"], config, sent);
  assert.equal(updated.code, 0);
  assert.deepEqual(sent.at(-1).command, { op: "loop-update", id: "loop-slack-1", every: "2h", loopAt: null, prompt: "新标准", promptFile: null, promptInline: true });
  const bad = await run(["update", "loop-slack-1", "--every", "1m"], config, sent);
  assert.equal(bad.code, 3);
  assert.match(bad.out, /refused: every-too-small/);
  const deleted = await run(["delete", "loop-slack-1"], config, sent);
  assert.deepEqual(sent.at(-1).command, { op: "loop-state", id: "loop-slack-1", state: "deleted" });
});

test("TC-LC8 a cron schedule validates, dispatches and shows up in list and show", async () => {
  const config = makeConfig();
  seed(config, "slack", {});
  const sent = [];
  const created = await run(["create", "--platform", "slack", "--cron", "0 13 * * *", "--slug", "digest", "--prompt", "看 CI", "--allow-inline"], config, sent);
  assert.equal(created.code, 0);
  assert.equal(sent.at(-1).command.cron, "0 13 * * *");
  assert.equal(sent.at(-1).command.every, null);
  assert.equal(sent.at(-1).command.loopAt, null);

  const bad = await run(["create", "--platform", "slack", "--cron", "0 13 * *", "--prompt", "p"], config, sent);
  assert.equal(bad.code, 3);
  assert.match(bad.out, /refused: bad-cron/);
  const never = await run(["create", "--platform", "slack", "--cron", "0 0 30 2 *", "--prompt", "p"], config, sent);
  assert.equal(never.code, 3);
  assert.match(never.out, /refused: never-fires/);
  const both = await run(["create", "--platform", "slack", "--every", "30m", "--cron", "0 13 * * *", "--prompt", "p"], config, sent);
  assert.equal(both.code, 3);
  assert.match(both.out, /refused: schedule-required/);

  seed(config, "slack", { "loop-slack-1": loopOf({ id: "loop-slack-1", every: "30m" }) });
  const updated = await run(["update", "loop-slack-1", "--cron", "*/10 * * * *"], config, sent);
  assert.equal(updated.code, 0);
  assert.deepEqual(sent.at(-1).command, { op: "loop-update", id: "loop-slack-1", every: null, loopAt: null, cron: "*/10 * * * *" });

  seed(config, "slack", { "loop-slack-1": loopOf({ id: "loop-slack-1", every: null, cron: "0 13 * * *" }) });
  const rows = listLoopRows(config, ["slack"]);
  assert.equal(rows[0].schedule, "cron 0 13 * * *");
  assert.ok(Number.isFinite(rows[0].due));
  const definition = await run(["show", "loop-slack-1"], config, sent);
  assert.match(definition.out, /schedule: cron 0 13 \* \* \*/);
});

test("TC-LC9 --slug names the loop and --prompt-file stores the canonical path, not the text", async () => {
  const config = makeConfig();
  seed(config, "slack", { "intake-slack": loopOf({ id: "intake-slack" }) });
  const file = promptFileFor(config, "intake-slack");
  const sent = [];
  const created = await run(["create", "--platform", "slack", "--every", "30m", "--slug", "intake", "--prompt-file", file], config, sent);
  assert.equal(created.code, 0);
  assert.equal(sent.at(-1).command.id, "intake-slack");
  assert.equal(sent.at(-1).command.promptFile, file);
  assert.equal(sent.at(-1).command.prompt, "", "a file-backed loop stores no copy of the text");

  const ambiguous = await run(["create", "--platform", "slack", "--every", "30m", "--slug", "intake", "--prompt", "x", "--prompt-file", file], config, sent);
  assert.equal(ambiguous.code, 3);
  assert.match(ambiguous.out, /refused: prompt-source-ambiguous/);

  const badSlug = await run(["create", "--platform", "slack", "--every", "30m", "--slug", "In take", "--prompt", "p", "--allow-inline"], config, sent);
  assert.equal(badSlug.code, 3);
  assert.match(badSlug.out, /refused: bad-slug/);

  const inline = await run(["update", "intake-slack", "--prompt", "回到内联", "--allow-inline"], config, sent);
  assert.equal(inline.code, 0);
  assert.deepEqual(sent.at(-1).command, { op: "loop-update", id: "intake-slack", prompt: "回到内联", promptFile: null, promptInline: true });

  const toFile = await run(["update", "intake-slack", "--prompt-file", file], config, sent);
  assert.equal(toFile.code, 0);
  assert.deepEqual(sent.at(-1).command, { op: "loop-update", id: "intake-slack", prompt: "", promptFile: file, promptInline: false });
});

test("TC-LC11 the shape is refused, not merely documented: slug, canonical path and inline", async () => {
  const config = makeConfig();
  seed(config, "slack", {});
  const sent = [];
  const file = promptFileFor(config, "watch-slack");

  const noSlug = await run(["create", "--platform", "slack", "--every", "30m", "--prompt-file", file], config, sent);
  assert.equal(noSlug.code, 3);
  assert.match(noSlug.out, /refused: slug-required/);

  const stray = await run(["create", "--platform", "slack", "--every", "30m", "--slug", "watch", "--prompt-file", join(mkdtempSync(join(tmpdir(), "relay-loopcli-stray-")), "prompt.md")], config, sent);
  assert.equal(stray.code, 3);
  assert.match(stray.out, /refused: prompt-file-not-canonical/);

  const wrongName = await run(["create", "--platform", "slack", "--every", "30m", "--slug", "watch", "--prompt-file", promptFileFor(config, "other-slack")], config, sent);
  assert.equal(wrongName.code, 3);
  assert.match(wrongName.out, /refused: prompt-file-not-canonical/);

  const inline = await run(["create", "--platform", "slack", "--every", "30m", "--slug", "watch", "--prompt", "看 CI"], config, sent);
  assert.equal(inline.code, 3);
  assert.match(inline.out, /refused: inline-prompt-refused/);

  const allowed = await run(["create", "--platform", "slack", "--every", "30m", "--slug", "probe", "--prompt", "一次性调试", "--allow-inline"], config, sent);
  assert.equal(allowed.code, 0);
  assert.equal(sent.at(-1).command.id, "probe-slack");
  assert.equal(sent.at(-1).command.promptInline, true);
  assert.equal(sent.at(-1).command.promptFile, null);
  assert.equal(sent.length, 1, "only the allow-inline create was dispatched");
});

test("TC-LC12 doctor reports shape drift without writing anything", async () => {
  const config = makeConfig();
  const canonical = promptFileFor(config, "intake-slack");
  seed(config, "slack", {
    "intake-slack": loopOf({ id: "intake-slack", prompt: "", promptFile: canonical }),
    "loop-slack-3": loopOf({ id: "loop-slack-3", prompt: "", promptFile: promptFileFor(config, "loop-slack-3") }),
    "old-inline": loopOf({ id: "old-inline", prompt: "老规则", promptFile: null }),
    "gone-slack": loopOf({ id: "gone-slack", prompt: "", promptFile: join(config.configDir, "prompts", "loops", "gone-slack", "prompt.md") }),
    "moved-slack": loopOf({ id: "moved-slack", prompt: "", promptFile: join(config.configDir, "elsewhere", "prompt.md") }),
  });
  const sent = [];
  const report = await run(["doctor", "--platform", "slack"], config, sent);
  assert.equal(sent.length, 0, "doctor never dispatches");
  assert.equal(report.code, 3, "a failing loop sets exit code 3");
  const lines = report.out.trim().split("\n");
  const byId = Object.fromEntries(lines.map((line) => { const [id, level, problems] = line.split("\t"); return [id, { level, problems }]; }));
  assert.deepEqual(byId["intake-slack"], { level: "ok", problems: "-" });
  assert.equal(byId["loop-slack-3"].level, "warn");
  assert.match(byId["loop-slack-3"].problems, /legacy-id/);
  assert.match(byId["old-inline"].problems, /inline-prompt/);
  assert.equal(byId["old-inline"].level, "fail");
  assert.match(byId["gone-slack"].problems, /prompt-file-missing/);
  assert.match(byId["moved-slack"].problems, /prompt-file-not-canonical/);
});

test("TC-LC10 show and list name the prompt file instead of pretending to carry the text", async () => {
  const config = makeConfig();
  const file = join(mkdtempSync(join(tmpdir(), "relay-loopcli-show-")), "prompt.md");
  writeFileSync(file, "看 CI\n");
  seed(config, "slack", { "intake-slack": loopOf({ id: "intake-slack", prompt: "", promptFile: file }) });
  const sent = [];
  const shown = await run(["show", "intake-slack"], config, sent);
  assert.equal(shown.code, 0);
  assert.match(shown.out, new RegExp(`prompt-file: ${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  const rows = formatLoopRows(listLoopRows(config, ["slack"]));
  assert.equal(rows.length, 1);
  assert.match(rows[0], new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("TC-LC13 --title rides along on create and update, and an oversized one is refused", async () => {
  const config = makeConfig();
  seed(config, "slack", { "daily-briefing-slack": loopOf({ id: "daily-briefing-slack" }) });
  const file = promptFileFor(config, "digest-slack");
  const sent = [];

  const created = await run(["create", "--platform", "slack", "--cron", "0 8 * * *", "--slug", "digest", "--prompt-file", file, "--title", "每日简报"], config, sent);
  assert.equal(created.code, 0);
  assert.equal(sent.at(-1).command.title, "每日简报");

  const renamed = await run(["update", "daily-briefing-slack", "--title", "早报"], config, sent);
  assert.equal(renamed.code, 0);
  assert.equal(sent.at(-1).command.title, "早报");

  const cleared = await run(["update", "daily-briefing-slack", "--title", ""], config, sent);
  assert.equal(cleared.code, 0);
  assert.equal(sent.at(-1).command.title, "", "an empty flag clears the title so the id takes over");

  const tooLong = await run(["update", "daily-briefing-slack", "--title", "日".repeat(27)], config, sent);
  assert.equal(tooLong.code, 3);
  assert.match(tooLong.out, /refused: title-too-long/);
  assert.equal(sent.at(-1).command.title, "", "a refused title is never dispatched");
});
