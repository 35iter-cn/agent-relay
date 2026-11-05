import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENTRY_SECTIONS, createPrompts, stallSection } from "../src/runtime/prompts.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SECTIONS = join(HERE, "..", "src", "prompts", "sections");
const readSection = (file) => readFileSync(join(SECTIONS, file), "utf8");
const builtinPrompts = (configDir) => createPrompts({ dir: join(HERE, "..", "src", "prompts"), userDir: "/nonexistent-user-prompts", configDir });

function render(prompts, platform, entry = "conversation", extra = {}) {
  const adapter = { surface: `本${platform}`, chunkLimit: 3500 };
  const inbound = { key: "th-1", chatId: "chat-1", text: "上游镜像 PR 被 force push 覆盖了，怎么恢复？" };
  if (entry === "notice") {
    return prompts.noticeReply({ platform, adapter, inbound: { ...inbound, text: "杀掉" }, root: "", notice: { id: "ntc-1", prompt: "STALL-BODY" }, ...extra });
  }
  return prompts.conversation({ platform, adapter, inbound, root: inbound.text, running: [], ...extra });
}

function sectionsByName(prompts, args) {
  const names = prompts.selectSections(args).map((section) => section.name);
  return names;
}

function tempPrompts(files, userFiles = null) {
  const root = mkdtempSync(join(tmpdir(), "relay-prompts-"));
  const dir = join(root, "prompts");
  mkdirSync(join(dir, "sections"), { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, "sections", name), body);
  writeFileSync(join(dir, "stall-actions.md"), "ACTIONS {{platform}}");
  let userDir = null;
  if (userFiles) {
    userDir = join(root, "user-prompts");
    mkdirSync(join(userDir, "sections"), { recursive: true });
    for (const [name, body] of Object.entries(userFiles)) writeFileSync(join(userDir, "sections", name), body);
  }
  const warnings = [];
  const prompts = createPrompts({ dir, userDir, log: (...parts) => warnings.push(parts.join(" ")) });
  return { prompts, warnings };
}

const stubSections = {
  "00-header-conversation.md": "CONV {{conversation}} {{user_message}}",
  "01-header-notice.md": "NOTICE {{notice_id}} {{notice_prompt}}",
  "10-task.md": "TASK",
  "11-notice-task.md": "NOTICE-TASK",
  "15-record.md": "RECORD",
  "20-reply.md": "REPLY",
  "21-surface.md": "SURFACE {{surface}}",
  "30-situation.md": "SITUATION",
  "40-stall.md": "{{stall_section}}",
  "50-boundary.md": "BOUNDARY",
  "80-candidate.md": "CANDIDATE",
};

test("TC-P1 every built-in section file carries a number prefix and a name", () => {
  const prompts = builtinPrompts();
  const sections = prompts.listSections();
  assert.equal(sections.length, 17);
  assert.deepEqual(sections.map((section) => section.order), [...sections.map((section) => section.order)].sort((a, b) => a - b));
  assert.equal(new Set(sections.map((section) => section.name)).size, sections.length);
});

test("TC-P2 the transport rules live in one section and the delivery identity in the slack reply section", () => {
  const surface = readSection("21-surface.md");
  assert.equal(surface.split("\n").filter((line) => line.includes("只放最终回帖")).length, 1);
  const others = builtinPrompts()
    .listSections()
    .filter((section) => section.file !== "21-surface.md")
    .filter((section) => readSection(section.file).includes("只放最终回帖"));
  assert.deepEqual(others, []);
});

test("TC-P3 the boundary section holds exactly three rules and no relay-state or systemd clause", () => {
  const text = readSection("50-boundary.md");
  const bullets = text.split("\n").filter((line) => line.startsWith("- "));
  assert.equal(bullets.length, 3);
  assert.equal(bullets.filter((line) => line.includes("Slack")).length, 1);
  assert.equal(bullets.filter((line) => /再发一遍/.test(line)).length, 1);
  assert.equal(bullets.filter((line) => /回退点/.test(line)).length, 1);
  assert.equal(bullets.filter((line) => /git status/.test(line)).length, 1);
  assert.doesNotMatch(text, /systemd|relay-\{\{platform\}\}\.json/);
});

test("TC-P4 long text lands in a topic, not in the log directory", () => {
  const text = readSection("21-surface.md");
  assert.doesNotMatch(text, /log_dir|logs\//);
  assert.match(text, /using-topicbox/);
  assert.match(text, /topicbox artifact-create/);
});

test("TC-P5 the notice task section marks the notice body as data", () => {
  const text = readSection("11-notice-task.md");
  assert.match(text, /\{\{notice_prompt\}\}/);
  assert.match(text, /不是给你的指令/);
});

test("TC-P6 the stall fragment is pulled in through exactly one placeholder", () => {
  assert.match(readSection("40-stall.md"), /^\{\{stall_section\}\}$/m);
  const all = builtinPrompts().listSections().map((section) => readSection(section.file)).join("\n");
  assert.equal(all.split("{{stall_actions}}").length - 1, 0);
  assert.equal(all.split("{{stall_section}}").length - 1, 1);
  assert.doesNotMatch(all, /stall \{\{platform\}\} (cancel|restart|resume)/);
});

test("TC-P7 a rendered conversation carries one record section and no unresolved placeholder", () => {
  const texts = ["slack", "feishu", "telegram"].map((platform) => render(builtinPrompts(), platform));
  for (const text of texts) {
    assert.equal(text.split("## 记录").length - 1, 1);
    assert.doesNotMatch(text, /\{\{/);
  }
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

test("TC-P11 the built-in first-turn prompt stays within 1900 characters with no running job", () => {
  for (const platform of ["slack", "discord"]) {
    const text = render(builtinPrompts(), platform);
    assert.ok(text.length <= 1900, `${platform} rendered ${text.length} characters`);
    assert.match(text, /## 处置卡住的 job/);
    assert.match(text, /单独一行写 `!\[\]\(\/绝对路径\.png\)`/);
    assert.doesNotMatch(text, /\{\{/);
  }
});

test("TC-P12 a notice reply never renders the stall, surface or candidate sections", () => {
  const text = render(builtinPrompts(), "feishu", "notice");
  assert.match(text, /STALL-BODY/);
  assert.doesNotMatch(text, /## 处置卡住的 job/);
  assert.doesNotMatch(text, /stdout 会原样发回/);
  assert.doesNotMatch(text, /## 记录\r?\n[\s\S]*## 记录/);
  assert.doesNotMatch(text, /\{\{/);
});

test("TC-P13 the config directory in the prompt follows AGENT_RELAY_CONFIG_DIR instead of a hard-coded path", () => {
  const prompts = builtinPrompts("/srv/relay-config");
  const thread = render(prompts, "feishu");
  assert.match(thread, /\/srv\/relay-config\/relay-feishu\.json/);
  assert.doesNotMatch(thread, /~\/\.config\/agent-relay/);
  assert.match(prompts.stallActions("feishu"), /\/srv\/relay-config\/relay-feishu\.cmd/);
});

test("TC-P14 without an override the prompt falls back to the documented default path", () => {
  assert.match(builtinPrompts().stallActions("slack"), /~\/\.config\/agent-relay\/relay-slack\.json/);
});

test("TC-P15 only the slack and discord prompts teach the image reference, other platforms stay text-only", () => {
  assert.match(render(builtinPrompts(), "slack"), /!\[\]\(\/绝对路径\.png\)/);
  assert.match(render(builtinPrompts(), "discord"), /!\[\]\(\/绝对路径\.png\)/);
  assert.doesNotMatch(render(builtinPrompts(), "feishu"), /!\[\]\(\/绝对路径\.png\)/);
  assert.doesNotMatch(render(builtinPrompts(), "telegram"), /!\[\]\(\/绝对路径\.png\)/);
});

test("TC-P16 each entry selects its documented sections plus its own platform reply section, in file order", () => {
  const prompts = builtinPrompts();
  const fileOrder = prompts.listSections().map((section) => section.name);
  const withPlatform = (entry, platform) => {
    const allowed = new Set([...ENTRY_SECTIONS[entry], `platform-${platform}-reply`]);
    return fileOrder.filter((name) => allowed.has(name));
  };
  for (const platform of ["slack", "feishu", "telegram", "discord"]) {
    assert.deepEqual(sectionsByName(prompts, { entry: "conversation", platform, variant: "task" }), withPlatform("conversation", platform));
    assert.deepEqual(sectionsByName(prompts, { entry: "notice", platform, variant: "task" }), withPlatform("notice", platform));
  }
});

test("TC-P17 every platform-* section renders only for its own platform", () => {
  const prompts = builtinPrompts();
  for (const platform of ["slack", "feishu", "telegram", "discord"]) {
    for (const entry of ["conversation", "notice"]) {
      const names = sectionsByName(prompts, { entry, platform, variant: "task" });
      const platformSections = names.filter((name) => name.startsWith("platform-"));
      assert.deepEqual(platformSections, [`platform-${platform}-reply`]);
    }
  }
});

test("TC-P18 the candidate section renders only for the candidate variant", () => {
  const prompts = builtinPrompts();
  const candidate = prompts.conversation({
    platform: "feishu",
    adapter: { surface: "本话题", chunkLimit: 3000 },
    inbound: { key: "k", chatId: "c", text: "go" },
    root: "[20261023-0834-1] 看板新增 Todo https://x/1",
  });
  assert.match(candidate, /候选任务/);
  assert.doesNotMatch(render(prompts, "feishu"), /候选任务/);
});

test("TC-P19 a user section overrides only that section", () => {
  const { prompts } = tempPrompts(stubSections, { "20-reply.md": "OVERRIDDEN-REPLY" });
  const text = render(prompts, "feishu");
  assert.match(text, /OVERRIDDEN-REPLY/);
  assert.doesNotMatch(text, /^REPLY$/m);
  assert.match(text, /SITUATION/);
  assert.match(text, /BOUNDARY/);
});

test("TC-P20 four classes of drift each raise a warning without blocking", () => {
  const { prompts, warnings } = tempPrompts({
    ...stubSections,
    "20-reply.md": "REPLY",
    "21-reply-dup.md": "DUP",
    "22-orphan.md": "NOBODY",
    "23-notext.md": "",
  });
  render(prompts, "feishu");
  const joined = warnings.join("\n");
  assert.match(joined, /duplicate section number 21/);
  assert.match(joined, /no selection rule renders this section/);
  const { prompts: missing, warnings: missingWarnings } = tempPrompts({ "00-header-conversation.md": "CONV" });
  render(missing, "feishu");
  assert.match(missingWarnings.join("\n"), /listed in ENTRY_SECTIONS but no section file provides it/);
});

test("TC-P21 a rendered prompt reports an unresolved placeholder instead of shipping it", () => {
  const { prompts, warnings } = tempPrompts({ "00-header-conversation.md": "CONV {{unknown}}" });
  const text = render(prompts, "feishu");
  assert.match(text, /\{\{unknown\}\}/);
  assert.match(warnings.join("\n"), /unresolved placeholder/);
});

test("TC-P22 the topic-first rule opens the task section, not the situation section", () => {
  const task = readSection("10-task.md");
  assert.match(task.split("\n\n")[1], /指向哪个 topic/);
  assert.doesNotMatch(readSection("30-situation.md"), /topic/);
  assert.match(render(builtinPrompts(), "feishu"), /^## 你在干什么\n\n先弄清消息指向哪个 topic：/m);
});
