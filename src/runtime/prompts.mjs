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
    const platformFile = PLATFORM_FILE[platform] ?? `20-platform-${platform}.md`;
    const parts = [COMMON_FILE, platformFile, ENTRY_FILE[entry]].map(section).filter(Boolean);
    return render(parts.join("\n\n"), values({ platform, adapter, inbound, notice, loop }), entry);
  }

  function scheduled({ platform, adapter, inbound, brief, full = false }) {
    const task = [SCHEDULED_LINE, String(brief ?? "").trim()].filter(Boolean).join("\n\n");
    if (!full) return task;
    const rules = [COMMON_FILE, PLATFORM_FILE[platform] ?? `20-platform-${platform}.md`].map(section).filter(Boolean).join("\n\n");
    return render([rules, task].filter(Boolean).join("\n\n"), values({ platform, adapter, inbound }), "scheduled");
  }

  function autoTerminated({ minutes = 0, lastProgress = "" } = {}) {
    return render(message("auto-terminated.md"), { minutes: String(minutes), last_progress: lastProgress }, "auto-terminated").trim();
  }

  function budgetNotice({ minutes = 0, left = 0, job = "" } = {}) {
    return render(message("budget-notice.md"), { minutes: String(minutes), left: String(left), job }, "budget-notice").trim();
  }

  function budgetTerminated({ minutes = 0 } = {}) {
    return render(message("budget-terminated.md"), { minutes: String(minutes) }, "budget-terminated").trim();
  }

  function keyWindowRejected({ minutes = 0, spent = 0, window = 0 } = {}) {
    return render(message("key-window-rejected.md"), { minutes: String(minutes), spent: String(spent), window: String(window) }, "key-window-rejected").trim();
  }

  function restartPrompt() {
    return message("restart.md");
  }

  function stallNotice({ task = "", round = "", stuck = "", job = "", identity = {}, lastProgress = "", silenceMinutes = 0, actionMinutes = 0, origin = "user", roundCapMinutes = 0, parkMinutes = 0 } = {}) {
    const text = render(
      message("stall-notice.md"),
      {
        task,
        round,
        stuck,
        job,
        loop: identity.loop ?? "",
        round_label: identity.round ?? "",
        key: identity.key ?? "",
        session: identity.session ?? "",
        started: identity.started ?? "",
        elapsed_minutes: identity.elapsedMinutes ?? "",
        last_progress: lastProgress,
        silence_minutes: String(silenceMinutes),
        disposition: stallDisposition({ actionMinutes, origin, roundCapMinutes, parkMinutes }),
        restart_prompt: restartPrompt(),
      },
      "stall-notice",
    );
    return dropEmptyLabels(text);
  }

  function stallDisposition({ actionMinutes = 0, origin = "user", roundCapMinutes = 0, parkMinutes = 0 } = {}) {
    if (actionMinutes > 0) {
      return `这条通知发出 ${actionMinutes} 分钟后，若仍没有任何工具在跑，这一轮会被自动终止，同样按最后一次进展入账。`;
    }
    if (origin === "loop") {
      return `不会因这条通知自动终止：这一轮会一直挂着，到 ${parkMinutes} 分钟时自动停下并保留会话，那时另发一条可以恢复的通知。`;
    }
    return `不会因这条通知自动终止：交互轮仍受 ${roundCapMinutes} 分钟单轮上限约束，到点按最后一次进展入账。`;
  }

  function loopRunning({ job = "", identity = {}, elapsedMinutes = "", parkMinutes = "", count = "" } = {}) {
    const text = render(
      message("loop-running.md"),
      {
        job,
        loop: identity.loop ?? "",
        round_label: identity.round ?? "",
        key: identity.key ?? "",
        session: identity.session ?? "",
        started: identity.started ?? "",
        elapsed_minutes: elapsedMinutes,
        park_minutes: parkMinutes,
        park_line: parkMinutes > 0 ? `${parkMinutes} 分钟没人管就会自动停下并保留会话，那时另发一条可以恢复的通知。` : "没人在管就一直挂着。",
        notice_count: count,
        restart_prompt: restartPrompt(),
      },
      "loop-running",
    );
    return dropEmptyLabels(text);
  }

  function loopParked({ job = "", identity = {}, elapsedMinutes = "", billedMinutes = "", lastProgress = "" } = {}) {
    const text = render(
      message("loop-parked.md"),
      {
        job,
        loop: identity.loop ?? "",
        round_label: identity.round ?? "",
        key: identity.key ?? "",
        session: identity.session ?? "",
        started: identity.started ?? "",
        elapsed_minutes: elapsedMinutes,
        billed_minutes: billedMinutes,
        last_progress: lastProgress,
        restart_prompt: restartPrompt(),
      },
      "loop-parked",
    );
    return dropEmptyLabels(text);
  }

  function dropEmptyLabels(text) {
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
    loopRunning,
    loopParked,
    autoTerminated,
    budgetNotice,
    budgetTerminated,
    keyWindowRejected,
    interrupt,
    emptyPrompt,
    conversation: (args) => compose({ ...args, entry: "conversation" }),
    noticeReply: (args) => compose({ ...args, entry: "notice" }),
    loopRound: (args) => compose({ ...args, entry: "loop" }),
  };
}
