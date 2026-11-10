import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ACTION_NAMES, dueFrom, durationMs, jobArgs, jobCancelDedupe, listJobs, main, parseFlags, precheckJob, sendCommand, textFlag } from "../src/cli.mjs";
import { readEnvFile } from "../src/config.mjs";

test("readEnv parses KEY=value lines and ignores comments", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-env-"));
  const file = join(dir, "feishu.env");
  writeFileSync(file, "# comment\nFEISHU_APP_ID=cli_123\nFEISHU_APP_SECRET=spaced \ninvalid line\n FOO=  indented\nBAR=\n");
  assert.deepEqual(readEnvFile(file), { FEISHU_APP_ID: "cli_123", FEISHU_APP_SECRET: "spaced", BAR: "" });
});

test("readEnv returns an empty object for a missing file", () => {
  assert.deepEqual(readEnvFile("/nonexistent/feishu.env"), {});
});

test("the action command accepts only cancel and restart", () => {
  assert.deepEqual([...ACTION_NAMES], ["cancel", "restart"]);
  assert.equal(ACTION_NAMES.has("resume"), false);
});

test("parseFlags splits flags from positional words", () => {
  assert.deepEqual(parseFlags(["job-stall", "--platform", "feishu", "--text=hi there"]), {
    rest: ["job-stall"],
    flags: { platform: "feishu", text: "hi there" },
  });
});

test("TC-J1 job cancel reads the dedupe from the positional word, never the verb", () => {
  const { flags, positional } = jobArgs(["cancel", "--platform", "slack", "abc-123"]);
  assert.equal(jobCancelDedupe(flags, positional), "abc-123");
});

test("TC-J2 job cancel prefers --dedupe when both forms are given", () => {
  const { flags, positional } = jobArgs(["cancel", "--platform", "slack", "--dedupe", "xyz", "abc"]);
  assert.equal(jobCancelDedupe(flags, positional), "xyz");
});

test("TC-J3 job cancel has no target when the dedupe is missing", () => {
  const { flags, positional } = jobArgs(["cancel", "--platform", "slack"]);
  assert.equal(jobCancelDedupe(flags, positional), "");
});

test("TC-J4 job start keeps its flags out of the positional words", () => {
  const { verb, flags, positional } = jobArgs(["start", "--platform", "slack", "--key", "k1", "--dedupe", "d1", "--brief", "go", "--in", "30m"]);
  assert.equal(verb, "start");
  assert.equal(flags.key, "k1");
  assert.equal(flags.dedupe, "d1");
  assert.deepEqual(positional, []);
});

test("sendCommand reports delivered only after the daemon consumed the file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-cmd-"));
  const config = { commandDir: (platform) => join(dir, platform) };
  const consume = () => {
    for (const name of readdirSync(join(dir, "feishu"))) unlinkSync(join(dir, "feishu", name));
  };
  const delivered = await sendCommand(config, "feishu", { op: "action", action: "cancel", noticeId: "ntc-1" }, { sleep: async () => consume(), waitMs: 1_000 });
  assert.equal(delivered.delivered, true);
  const pending = await sendCommand(config, "slack", { op: "action" }, { waitMs: 0 });
  assert.equal(pending.delivered, false);
  assert.ok(readdirSync(join(dir, "slack")).length === 1);
});

test("the command directory is private so other users cannot inject commands", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-cmd-mode-"));
  const config = { commandDir: (platform) => join(dir, platform) };
  await sendCommand(config, "feishu", { op: "action" }, { waitMs: 0 });
  assert.equal(statSync(join(dir, "feishu")).mode & 0o777, 0o700);
});

test("textFlag reads a file before an inline value and trims both", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-text-"));
  const file = join(dir, "prompt.md");
  writeFileSync(file, "  文件里的 prompt  \n");
  assert.equal(textFlag({ "prompt-file": file }, "prompt"), "文件里的 prompt");
  assert.equal(textFlag({ prompt: "  行内  " }, "prompt"), "行内");
  assert.equal(textFlag({}, "prompt"), "");
});

test("TC-SJ15 durations and due times parse into absolute stamps", () => {
  const nowMs = Date.parse("2026-11-05T20:00:00+08:00");
  assert.equal(durationMs("30m", 0), 1_800_000);
  assert.equal(durationMs("2h", 0), 7_200_000);
  assert.equal(durationMs("45s", 0), 45_000);
  assert.equal(durationMs("1d", 0), 86_400_000);
  assert.equal(durationMs("nonsense", 42), 42);
  assert.equal(durationMs(undefined, 42), 42);
  assert.equal(dueFrom({}, nowMs), null);
  assert.equal(dueFrom({ in: "30m" }, nowMs), new Date(nowMs + 1_800_000).toISOString());
  assert.equal(dueFrom({ at: "2026-11-06T03:00:00+08:00" }, nowMs), new Date("2026-11-06T03:00:00+08:00").toISOString());
  assert.equal(dueFrom({ at: "not-a-date" }, nowMs), null);
  assert.equal(dueFrom({ in: "soon" }, nowMs), null);
});

test("TC-SJ16 the local precheck refuses a bad job before writing any command", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-precheck-"));
  const file = join(dir, "relay-fake.json");
  writeFileSync(file, JSON.stringify({ convs: { "th-1": { session: "fs-th-1" } }, seen: { "dup-1": "job-3" }, jobs: {} }));
  assert.equal(precheckJob(file, { key: "th-1", dedupe: "new", brief: "看一下" }), null);
  assert.equal(precheckJob(file, { key: "th-2", dedupe: "new", brief: "看一下" }), "unknown-key");
  assert.equal(precheckJob(file, { key: "th-1", dedupe: "dup-1", brief: "看一下" }), "duplicate");
  assert.equal(precheckJob(file, { key: "th-1", dedupe: "new", brief: "  " }), "empty");
  assert.equal(precheckJob(file, { key: "th-1", dedupe: "new", brief: "x".repeat(8 * 1024 + 1) }), "too-long");
  assert.equal(precheckJob(join(dir, "missing.json"), { key: "th-1", dedupe: "new", brief: "看一下" }), "no-state");
  assert.deepEqual(readdirSync(dir), ["relay-fake.json"]);
});

test("TC-SJ17 job list prints the dedupe id, the due time and the brief head", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-list-"));
  const file = join(dir, "relay-fake.json");
  writeFileSync(
    file,
    JSON.stringify({
      convs: {},
      seen: {},
      jobs: {
        "job-1": { id: "job-1", key: "th-1", status: "scheduled", dueAt: "2026-11-05T21:00:00+08:00", inbound: { dedupeId: "d-later", text: "看进度\n第二行" } },
        "job-2": { id: "job-2", key: "th-1", status: "done", inbound: { dedupeId: "d-done", text: "旧的一轮" } },
        "job-3": { id: "job-3", key: "th-2", status: "running", dueAt: null, inbound: { dedupeId: "d-now", text: "本轮" } },
      },
    }),
  );
  const lines = listJobs(file, "th-1");
  assert.deepEqual(lines, ["scheduled\t2026-11-05T21:00:00+08:00\td-later\t看进度"]);
  assert.equal(listJobs(file, null).length, 2);
  assert.deepEqual(listJobs(join(dir, "missing.json"), null), []);
});

test("TC-ST21 stall help covers every action and forbids a manual kill", async () => {
  const out = [];
  const stdout = process.stdout.write;
  const previous = process.exitCode;
  process.stdout.write = (chunk) => (out.push(String(chunk)), true);
  process.exitCode = 0;
  try {
    await main(["stall", "help"]);
  } finally {
    process.stdout.write = stdout;
  }
  const text = out.join("");
  const exit = process.exitCode ?? 0;
  process.exitCode = previous;
  assert.equal(exit, 0);
  for (const action of ACTION_NAMES) assert.match(text, new RegExp(`\\b${action}\\b`));
  assert.match(text, /stall <platform> cancel <key>/);
  assert.match(text, /stall <platform> restart <key>/);
  assert.match(text, /不要自己 kill/);
});
