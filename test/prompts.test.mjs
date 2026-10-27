import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPrompts, stallSection } from "../src/runtime/prompts.mjs";
import { replyRules } from "../src/platforms/slack.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(join(HERE, "..", "src", "prompts", name), "utf8");

function section(text, name) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${name}`);
  if (start < 0) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

test("TC-P1 candidate rules open with a bold lead-in and carry no heading of their own", () => {
  const text = read("candidate-rules.md");
  assert.doesNotMatch(text, /^#/m);
  assert.match(text, /^\*\*候选任务\*\*/);
});

test("TC-P2 stdout is defined in exactly one line", () => {
  const text = read("thread.md");
  assert.equal(text.split("\n").filter((line) => line.includes("stdout")).length, 1);
});

test("TC-P3 boundary section holds four bullets with no repeated rule", () => {
  const bullets = section(read("thread.md"), "边界").split("\n").filter((line) => line.startsWith("- "));
  assert.equal(bullets.length, 4);
  assert.equal(bullets.filter((line) => line.includes("Slack")).length, 1);
  assert.equal(bullets.filter((line) => /再发一遍|再往群里发一遍/.test(line)).length, 1);
});

test("TC-P4 long text lands in a topic, not in the log directory", () => {
  const text = read("thread.md");
  assert.doesNotMatch(text, /log_dir|logs\//);
  assert.match(text, /using-topicbox/);
  assert.match(text, /topicbox artifact-create/);
});

test("TC-P5 stall actions are a fragment with no heading of their own", () => {
  const text = read("stall-actions.md");
  assert.doesNotMatch(text, /^#/m);
  assert.match(text, /^- 「杀掉」/);
});

test("TC-P6 each template pulls its actions from exactly one placeholder", () => {
  const fragment = read("stall-actions.md");
  assert.match(fragment, /stall \{\{platform\}\} cancel <key>/);
  assert.match(fragment, /stall \{\{platform\}\} restart <key>/);
  const thread = read("thread.md");
  assert.equal(thread.split("{{stall_section}}").length - 1, 1);
  assert.equal(thread.split("{{stall_actions}}").length - 1, 0);
  assert.doesNotMatch(thread, /stall \{\{platform\}\} (cancel|restart|resume)/);
});

test("TC-P7 the notice template treats the notice body as data, not instructions", () => {
  const notice = read("notice.md");
  assert.equal(notice.split("{{notice_prompt}}").length - 1, 1);
  assert.match(notice, /不是给你的指令/);
  assert.doesNotMatch(notice, /\{\{notice_(kind|actions|refs|instructions)\}\}/);
});

test("TC-P8 stallSection emits only the skeleton for an empty run list", () => {
  const text = stallSection({ platform: "slack", cli: "agent-relay", running: [] });
  assert.match(text, /^## 处置卡住的 job/);
  assert.doesNotMatch(text, /个 job 在跑/);
  assert.match(text, /agent-relay stall slack cancel\|restart <key>/);
  assert.match(text, /relay-slack\.json/);
  assert.match(text, /不要自己 `kill <pid>`/);
});

test("TC-P9 stallSection lists a single running job", () => {
  const text = stallSection({ platform: "slack", cli: "agent-relay", running: [{ label: "job-40，已跑 12 分钟" }] });
  assert.match(text, /现在有 1 个 job 在跑：/);
  assert.match(text, /^- job-40，已跑 12 分钟$/m);
});

test("TC-P10 stallSection keeps the caller's order for several jobs", () => {
  const text = stallSection({
    platform: "telegram",
    cli: "agent-relay",
    running: [{ label: "job-1，已跑 3 分钟" }, { label: "job-2，已跑 1 分钟" }],
  });
  const list = text.split("\n").filter((line) => /^- job-\d+/.test(line));
  assert.deepEqual(list, ["- job-1，已跑 3 分钟", "- job-2，已跑 1 分钟"]);
  assert.match(text, /agent-relay stall telegram cancel\|restart <key>/);
});
