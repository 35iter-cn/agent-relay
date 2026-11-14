import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JOB_ACTIONS, dueFrom, durationMs, jobArgs, jobCancelName, listJobs, main, parseFlags, precheckSchedule, sendCommand, textFlag } from "../src/cli.mjs";
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

test("the job verbs are list, cancel, restart and redeliver", () => {
  assert.deepEqual([...JOB_ACTIONS].sort(), ["cancel", "list", "redeliver", "restart"]);
  assert.equal(JOB_ACTIONS.has("start"), false);
});

test("parseFlags splits flags from positional words", () => {
  assert.deepEqual(parseFlags(["job-stall", "--platform", "feishu", "--text=hi there"]), {
    rest: ["job-stall"],
    flags: { platform: "feishu", text: "hi there" },
  });
});

test("TC-J1 schedule cancel reads the name from the positional word, never the verb", () => {
  const { flags, positional } = jobArgs(["cancel", "--platform", "slack", "abc-123"]);
  assert.equal(jobCancelName(flags, positional), "abc-123");
});

test("TC-J2 schedule cancel prefers --name when both forms are given", () => {
  const { flags, positional } = jobArgs(["cancel", "--platform", "slack", "--name", "xyz", "abc"]);
  assert.equal(jobCancelName(flags, positional), "xyz");
});

test("TC-J3 schedule cancel has no target when the name is missing", () => {
  const { flags, positional } = jobArgs(["cancel", "--platform", "slack"]);
  assert.equal(jobCancelName(flags, positional), "");
});

test("TC-J4 schedule keeps its flags out of the positional words", () => {
  const { verb, flags, positional } = jobArgs(["create", "--platform", "slack", "--key", "k1", "--name", "n1", "--in", "30m"]);
  assert.equal(verb, "create");
  assert.equal(flags.key, "k1");
  assert.equal(flags.name, "n1");
  assert.deepEqual(positional, []);
});

test("sendCommand reports delivered only after the daemon wrote a result", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-cmd-"));
  const config = { commandDir: (platform) => join(dir, platform) };
  const answer = () => {
    for (const name of readdirSync(join(dir, "feishu"))) {
      if (name.endsWith(".json")) writeFileSync(join(dir, "feishu", `${name}.result`), JSON.stringify({ ok: true }));
    }
  };
  const delivered = await sendCommand(config, "feishu", { op: "cancel-job", job: "job-1" }, { sleep: async () => answer(), waitMs: 1_000 });
  assert.equal(delivered.delivered, true);
  assert.equal(delivered.result.ok, true);
  const refused = await sendCommand(config, "feishu", { op: "cancel-job", job: "job-2" }, { sleep: async () => {
    for (const name of readdirSync(join(dir, "feishu"))) {
      if (name.endsWith(".json")) writeFileSync(join(dir, "feishu", `${name}.result`), JSON.stringify({ ok: false, refused: "not-running" }));
    }
  }, waitMs: 1_000 });
  assert.equal(refused.result.refused, "not-running");
  const pending = await sendCommand(config, "slack", { op: "cancel-job", job: "job-3" }, { waitMs: 0 });
  assert.equal(pending.delivered, false);
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

test("TC-SJ16 the local precheck refuses a bad schedule before writing any command", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-precheck-"));
  const file = join(dir, "relay-fake.json");
  writeFileSync(file, JSON.stringify({ convs: { "th-1": { session: "fs-th-1" } }, seen: { "dup-1": "job-3" }, jobs: {} }));
  assert.equal(precheckSchedule(file, { key: "th-1", name: "new", prompt: "看一下" }), null);
  assert.equal(precheckSchedule(file, { key: "th-1", name: "Bad Name", prompt: "看一下" }), "name-invalid");
  assert.equal(precheckSchedule(file, { key: "th-2", name: "new", prompt: "看一下" }), "unknown-key");
  assert.equal(precheckSchedule(file, { key: "th-1", name: "dup-1", prompt: "看一下" }), "name-taken");
  assert.equal(precheckSchedule(file, { key: "th-1", name: "new", prompt: "  " }), "empty-prompt");
  assert.equal(precheckSchedule(file, { key: "th-1", name: "new", prompt: "x".repeat(8 * 1024 + 1) }), "too-long");
  assert.equal(precheckSchedule(join(dir, "missing.json"), { key: "th-1", name: "new", prompt: "看一下" }), "no-state");
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
  assert.deepEqual(lines, ["scheduled\tjob-1\tth-1\t-\t2026-11-05T21:00:00+08:00\t看进度"]);
  assert.equal(listJobs(file, null).length, 2);
  assert.deepEqual(listJobs(join(dir, "missing.json"), null), []);
});

test("TC-ST21 stall is gone and points at job cancel/restart", async () => {
  const out = [];
  const err = [];
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  const previous = process.exitCode;
  process.stdout.write = (chunk) => (out.push(String(chunk)), true);
  process.stderr.write = (chunk) => (err.push(String(chunk)), true);
  process.exitCode = 0;
  try {
    await main(["stall", "help"]);
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
  const text = [...out, ...err].join("");
  const exit = process.exitCode ?? 0;
  process.exitCode = previous;
  assert.equal(exit, 3);
  assert.match(text, /job cancel/);
  assert.match(text, /job restart/);
  assert.doesNotMatch(text, /stall <platform>/);
});
