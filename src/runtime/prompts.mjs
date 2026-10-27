import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderPrompt } from "../shared/prompt.mjs";

export const CANDIDATE_LINE = /^[ \t]*\[\d{8}-\d{4}-\d+\][ \t]+\S/m;

export function rootSectionText(root, message) {
  const value = String(root ?? "").trim();
  if (!value) return "";
  if (value === String(message ?? "").trim()) return "";
  return `\n本会话的起点（不是你这条）：\n${value}`;
}

export function promptVariant(root) {
  if (CANDIDATE_LINE.test(String(root ?? ""))) return "candidate";
  return "task";
}

export function stallSection({ platform, cli, configDir = "~/.config/agent-relay", running = [] }) {
  const list = running.length
    ? [`现在有 ${running.length} 个 job 在跑：`, ...running.map((item) => `- ${item.label}`), ""]
    : [];
  return [
    "## 处置卡住的 job",
    "",
    ...list,
    `- 终止或重启某一轮：\`${cli} stall ${platform} cancel|restart <key>\`（restart 可再跟一句补充要求）。`,
    `- key 不在消息里时，从 \`${configDir}/relay-${platform}.json\` 的 \`jobs\` 里找 \`status\` 仍在跑的那条，不要猜。`,
    "- 不要自己 `kill <pid>`，也不要手改账本；relay 回「没有在跑的任务」就是已经结束。",
  ].join("\n");
}

export function createPrompts({ dir, userDir = null, log = () => {}, cli = "agent-relay", configDir = "~/.config/agent-relay" }) {
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
    return renderPrompt(read("stall-actions.md").trim(), { platform, cli, config_dir: configDir });
  }

  function baseValues({ platform, adapter, inbound, root, running = [] }) {
    return {
      platform,
      cli,
      config_dir: configDir,
      surface: adapter.surface ?? "本会话",
      conversation: inbound.key,
      chat_id: inbound.chatId ?? "",
      user_message: inbound.text,
      root_section: rootSectionText(root, inbound.text),
      reply_rules: adapter.replyRules ?? "",
      chunk_limit: adapter.chunkLimit,
      stall_actions: stallActions(platform),
      stall_section: stallSection({ platform, cli, configDir, running }),
    };
  }

  function conversation({ platform, adapter, inbound, root, variant = null, running = [] }) {
    const resolved = variant ?? promptVariant(root);
    const candidateRules = resolved === "candidate" ? read("candidate-rules.md").trim() : "";
    return renderPrompt(read("thread.md"), {
      ...baseValues({ platform, adapter, inbound, root, running }),
      candidate_rules: candidateRules ? `\n\n${candidateRules}` : "",
    });
  }

  function noticeReply({ platform, adapter, inbound, root, notice, running = [] }) {
    const values = {
      ...baseValues({ platform, adapter, inbound, root, running }),
      notice_id: notice.id,
      notice_prompt: String(notice.prompt ?? "").trim() || "没有额外说明，按用户本轮消息处理。",
    };
    return renderPrompt(read("notice.md"), values);
  }

  function variant(root) {
    return promptVariant(root);
  }

  return { read, conversation, noticeReply, stallActions, variant };
}
