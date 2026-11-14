import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderPrompt } from "../shared/prompt.mjs";

export const SECTIONS_DIR = "sections";
export const MESSAGES_DIR = "messages";

export const COMMON_FILE = "10-common.md";
export const PLATFORM_FILE = { slack: "20-platform-slack.md", feishu: "21-platform-feishu.md" };
export const ENTRY_FILE = {
  conversation: "30-entry-conversation.md",
  notice: "31-entry-notice.md",
  loop: "32-entry-loop.md",
};

export const SCHEDULED_LINE =
  "这不是用户刚说的话：过去的你给现在的自己排了一项任务，现在到点。下面是那份任务书。";

const EMPTY_LABEL_LINE = /^[^：:]+：\s*$/;

export function createPrompts({ dir, userDir = null, log = () => {}, cli = "agent-relay", configDir = "~/.config/agent-relay" }) {
  const cache = new Map();

  function read(name) {
    if (cache.has(name)) return cache.get(name);
    let text = "";
    const bases = userDir ? [userDir, dir] : [dir];
    for (const base of bases) {
      try {
        text = readFileSync(join(base, name), "utf8");
        break;
      } catch {}
    }
    if (!text) log("warn", "prompt", name, "missing in user and built-in prompts");
    cache.set(name, text);
    return text;
  }

  function section(name) {
    return name ? read(join(SECTIONS_DIR, name)).trim() : "";
  }

  function message(name) {
    return read(join(MESSAGES_DIR, name)).trim();
  }

  function values({ platform, adapter, inbound, notice = null, loop = null, extra = null }) {
    return {
      platform,
      cli,
      config_dir: configDir,
      surface: adapter?.surface ?? "本会话",
      user_message: inbound?.text ?? "",
      notice_id: notice?.id ?? "",
      loop_prompt: String(loop?.prompt ?? "").trim(),
      prompts_dir: dir,
      ...(extra ?? {}),
    };
  }

  function render(template, v, label) {
    const text = renderPrompt(template, v);
    if (text.includes("{{")) log("warn", "prompt", label, "rendered prompt still holds an unresolved placeholder");
    return text;
  }

  function compose({ entry, platform, adapter, inbound, notice = null, loop = null }) {
    const parts = [COMMON_FILE, PLATFORM_FILE[platform], ENTRY_FILE[entry]].map(section).filter(Boolean);
    return render(parts.join("\n\n"), values({ platform, adapter, inbound, notice, loop }), entry);
  }

  function scheduled({ platform, adapter, inbound, brief, full = false }) {
    const task = [SCHEDULED_LINE, String(brief ?? "").trim()].filter(Boolean).join("\n\n");
    if (!full) return task;
    const rules = [COMMON_FILE, PLATFORM_FILE[platform]].map(section).filter(Boolean).join("\n\n");
    return render([rules, task].filter(Boolean).join("\n\n"), values({ platform, adapter, inbound }), "scheduled");
  }

  function restartPrompt() {
    return message("restart.md");
  }

  function stallNotice({ task = "", round = "", stuck = "", job = "", lastProgress = "" } = {}) {
    const text = render(
      message("stall-notice.md"),
      { task, round, stuck, job, last_progress: lastProgress, restart_prompt: restartPrompt() },
      "stall-notice",
    );
    return text
      .split("\n")
      .filter((line) => !EMPTY_LABEL_LINE.test(line))
      .join("\n")
      .trim();
  }

  function interrupt() {
    return message("interrupt.md");
  }

  function emptyPrompt() {
    return render(message("empty-prompt.md"), { prompts_dir: dir }, "empty-prompt");
  }

  return {
    read,
    section,
    message,
    compose,
    scheduled,
    restartPrompt,
    stallNotice,
    interrupt,
    emptyPrompt,
    conversation: (args) => compose({ ...args, entry: "conversation" }),
    noticeReply: (args) => compose({ ...args, entry: "notice" }),
    loopRound: (args) => compose({ ...args, entry: "loop" }),
  };
}
