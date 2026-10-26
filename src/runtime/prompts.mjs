import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderPrompt } from "../shared/prompt.mjs";
import { actionsText } from "../notices/service.mjs";

export const CANDIDATE_LINE = /^[ \t]*\[\d{8}-\d{4}-\d+\][ \t]+\S/m;
export const STALL_LINE = /^[ \t]*⏸[ \t]*任务疑似卡住/m;

export function rootSectionText(root, message) {
  const value = String(root ?? "").trim();
  if (!value) return "";
  if (value === String(message ?? "").trim()) return "";
  return `\n本会话的起点（不是你这条）：\n${value}`;
}

export function promptVariant(root, kinds = null) {
  const text = String(root ?? "");
  if (CANDIDATE_LINE.test(text)) return "candidate";
  if (kinds) {
    for (const kind of kinds.all()) {
      if (kind.marker && text.trimStart().startsWith(kind.marker)) return kind.id;
    }
  }
  if (STALL_LINE.test(text)) return "job-stall";
  return "task";
}

export function createPrompts({ dir, userDir = null, log = () => {}, cli = "agent-relay", kinds = null }) {
  const cache = new Map();

  function read(name) {
    if (cache.has(name)) return cache.get(name);
    let text = "";
    const candidates = userDir ? [join(userDir, name), join(dir, name)] : [join(dir, name)];
    for (const file of candidates) {
      try {
        text = readFileSync(file, "utf8");
        break;
      } catch {}
    }
    if (!text) log("warn", "prompt", name, "missing in user and built-in prompts");
    cache.set(name, text);
    return text;
  }

  function stallActions(platform) {
    return renderPrompt(read("stall-actions.md").trim(), { platform, cli });
  }

  function baseValues({ platform, adapter, inbound, root }) {
    return {
      platform,
      cli,
      surface: adapter.surface ?? "本会话",
      conversation: inbound.key,
      chat_id: inbound.chatId ?? "",
      user_message: inbound.text,
      root_section: rootSectionText(root, inbound.text),
      reply_rules: adapter.replyRules ?? "",
      chunk_limit: adapter.chunkLimit,
      stall_actions: stallActions(platform),
    };
  }

  function conversation({ platform, adapter, inbound, root, variant = null }) {
    const resolved = variant ?? promptVariant(root, kinds);
    const candidateRules = resolved === "candidate" ? read("candidate-rules.md").trim() : "";
    return renderPrompt(read("thread.md"), {
      ...baseValues({ platform, adapter, inbound, root }),
      candidate_rules: candidateRules ? `\n\n${candidateRules}` : "",
    });
  }

  function noticeReply({ platform, adapter, inbound, root, notice, kind }) {
    const instructions = kind.instructions ? read(kind.instructions).trim() : "";
    const values = {
      ...baseValues({ platform, adapter, inbound, root }),
      notice_id: notice?.id ?? "(未登记)",
      notice_kind: notice?.kind ?? kind.id,
      notice_instructions: instructions ? `\n${instructions}` : "",
      notice_actions: notice
        ? actionsText(kind, notice, { cli })
        : `- 这条通知没有登记编号：用 \`${cli} stall ${platform} cancel|restart <key>\`（key 在通知正文里）`,
      notice_refs: JSON.stringify(notice?.refs ?? {}, null, 2),
    };
    return renderPrompt(read(kind.prompt ?? "notice.md"), values);
  }

  function variant(root) {
    return promptVariant(root, kinds);
  }

  return { read, conversation, noticeReply, stallActions, variant };
}
