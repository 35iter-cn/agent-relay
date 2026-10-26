import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ACTION_NAMES, parseFlags, sendCommand, textFlag } from "../src/cli.mjs";
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

test("textFlag reads a file before an inline value and trims both", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-text-"));
  const file = join(dir, "prompt.md");
  writeFileSync(file, "  文件里的 prompt  \n");
  assert.equal(textFlag({ "prompt-file": file }, "prompt"), "文件里的 prompt");
  assert.equal(textFlag({ prompt: "  行内  " }, "prompt"), "行内");
  assert.equal(textFlag({}, "prompt"), "");
});
