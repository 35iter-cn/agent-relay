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



const EMPTY_LABEL_LINE = /^[^：:]+[：:]\s*$/;

export function createPrompts({ dir, userDir = null, log = () => {}, cli = "agent-relay", configDir = "~/.config/agent-relay" }) {
  const cache = new Map();

  function read(name) {
    if (cache.has(name)) return cache.get(name);
    let text = "";
    const bases = userDir ? [userDir, dir] : [dir];
    for (const base of bases) {
      try {
        const candidate = readFileSync(join(base, name), "utf8");
        // An empty override is not an answer: fall through to the built-in file.
        if (!candidate.trim()) continue;
        text = candidate;
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

  function scheduled({ platform, adapter, inbound, head = "", brief, full = false }) {
    const task = [String(head ?? "").trim(), String(brief ?? "").trim()].filter(Boolean).join("\n\n");
    if (!full) return task;
    const rules = [COMMON_FILE, PLATFORM_FILE[platform] ?? `20-platform-${platform}.md`].map(section).filter(Boolean).join("\n\n");
    return render([rules, task].filter(Boolean).join("\n\n"), values({ platform, adapter, inbound }), "scheduled");
  }

  function budgetNotice({ minutes = 0, left = 0, job = "" } = {}) {
    return render(message("budget-notice.md"), { minutes: String(minutes), left: String(left), job }, "budget-notice").trim();
  }

  function budgetTerminated({ minutes = 0, job = "" } = {}) {
    return render(message("budget-terminated.md"), { minutes: String(minutes), job }, "budget-terminated").trim();
  }

  // The receipt for a terminated round. Facts only: which round, how long it ran,
  // and whether the stop was cut at the last progress or at the stop itself.
  function terminated({ action = "cancel", kind = "conversation", stalled = false, job = "", elapsedMinutes = 0, from = "", to = "", lastProgress = "" } = {}) {
    const name = action === "restart" ? "terminated-restart.md" : kind === "loop" ? "terminated-loop.md" : stalled ? "terminated-stalled.md" : "terminated-cancel.md";
    const text = render(
      message(name),
      {
        job,
        elapsed_minutes: String(elapsedMinutes),
        from,
        to,
        last_progress: lastProgress,
      },
      name,
    );
    return text.trim();
  }

  function keyWindowRejected({ minutes = 0, spent = 0, window = 0 } = {}) {
    return render(message("key-window-rejected.md"), { minutes: String(minutes), spent: String(spent), window: String(window) }, "key-window-rejected").trim();
  }

  function restartPrompt() {
    return message("restart.md");
  }

  function stallNotice({ task = "", round = "", stuck = "", job = "", identity = {}, lastProgress = "", silenceMinutes = 0, kind = "conversation", roundCapMinutes = 0, parkMinutes = 0 } = {}) {
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
        disposition: stallDisposition({ kind, roundCapMinutes, parkMinutes }),
        restart_prompt: restartPrompt(),
      },
      "stall-notice",
    );
    return dropEmptyLabels(text);
  }

  function stallDisposition({ kind = "conversation", roundCapMinutes = 0, parkMinutes = 0 } = {}) {
    if (kind === "loop") {
      return `This notice does not stop the round: it runs until ${parkMinutes} min, then it is stopped and the session kept, and a resumable notice follows.`;
    }
    return `This notice does not stop the round: a user round still has its ${roundCapMinutes} min cap, which stops it and records the stop time.`;
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
        park_line: parkMinutes > 0 ? `${parkMinutes} min without a handler stops it and keeps the session, with a resumable notice.` : "Unhandled, it keeps running.",
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

  function emptyRunReply() {
    return "That reply did not finish. Reply again and I will pick it up.";
  }

  function busyReply() {
    return "Not queued: the conversation stayed busy. Retries stopped; send it again later, or reply to continue.";
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
    terminated,
    budgetNotice,
    budgetTerminated,
    keyWindowRejected,
    interrupt,
    emptyRunReply,
    busyReply,
    emptyPrompt,
    conversation: (args) => compose({ ...args, entry: "conversation" }),
    noticeReply: (args) => compose({ ...args, entry: "notice" }),
    loopRound: (args) => compose({ ...args, entry: "loop" }),
  };
}
