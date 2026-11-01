import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderPrompt } from "../shared/prompt.mjs";

export const CANDIDATE_LINE = /^[ \t]*\[\d{8}-\d{4}-\d+\][ \t]+\S/m;
export const SECTIONS_DIR = "sections";
export const SECTION_FILE = /^(\d{2})-(.+)\.md$/;

export const ENTRY_SECTIONS = {
  conversation: ["header-conversation", "task", "record", "reply", "surface", "situation", "stall", "boundary"],
  notice: ["header-notice", "notice-task", "record", "reply", "situation", "boundary"],
};

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

function platformMatches(name, platform) {
  if (!name.startsWith("platform-")) return null;
  const rest = name.slice("platform-".length);
  return rest === platform || rest === `${platform}-reply`;
}

function anyoneSelects(name) {
  if (name === "candidate") return true;
  if (name.startsWith("platform-")) return true;
  return Object.values(ENTRY_SECTIONS).some((list) => list.includes(name));
}

export function createPrompts({ dir, userDir = null, log = () => {}, cli = "agent-relay", configDir = "~/.config/agent-relay" }) {
  const cache = new Map();
  let audited = false;

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

  function scan(baseDir, target) {
    if (!baseDir) return;
    let entries = [];
    try {
      entries = readdirSync(join(baseDir, SECTIONS_DIR));
    } catch {
      return;
    }
    for (const entry of entries) {
      const match = SECTION_FILE.exec(entry);
      if (!match) {
        log("warn", "prompt-section", entry, "ignored: expected NN-<name>.md");
        continue;
      }
      target.set(match[2], { name: match[2], order: Number(match[1]), file: entry, base: baseDir });
    }
  }

  function listSections() {
    const merged = new Map();
    scan(dir, merged);
    scan(userDir, merged);
    return [...merged.values()]
      .sort((a, b) => (a.order - b.order) || a.file.localeCompare(b.file));
  }

  function audit(sections) {
    if (audited) return;
    audited = true;
    const seenOrder = new Map();
    for (const section of sections) {
      const same = seenOrder.get(section.order);
      if (same) log("warn", "prompt-section", section.file, `duplicate section number ${section.order} with ${same}`);
      else seenOrder.set(section.order, section.file);
      if (!anyoneSelects(section.name)) log("warn", "prompt-section", section.file, "no selection rule renders this section");
    }
    const names = new Set(sections.map((section) => section.name));
    for (const list of Object.values(ENTRY_SECTIONS)) {
      for (const name of list) {
        if (!names.has(name)) log("warn", "prompt-section", name, "listed in ENTRY_SECTIONS but no section file provides it");
      }
    }
  }

  function stallActions(platform) {
    return renderPrompt(read("stall-actions.md").trim(), { platform, cli, config_dir: configDir });
  }

  function selectSections({ entry, platform, variant }) {
    const listed = new Set(ENTRY_SECTIONS[entry] ?? []);
    return listSections().filter((section) => {
      if (section.name === "candidate") return variant === "candidate";
      const match = platformMatches(section.name, platform);
      if (match !== null) return match;
      return listed.has(section.name);
    });
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
      chunk_limit: adapter.chunkLimit,
      stall_actions: stallActions(platform),
      stall_section: stallSection({ platform, cli, configDir, running }),
    };
  }

  function buildPrompt({ entry, platform, adapter, inbound, root, notice = null, running = [], variant = null }) {
    const sections = listSections();
    audit(sections);
    const resolved = variant ?? promptVariant(root);
    const bodies = selectSections({ entry, platform, variant: resolved })
      .map((section) => read(join(SECTIONS_DIR, section.file)).trim())
      .filter(Boolean);
    const values = {
      ...baseValues({ platform, adapter, inbound, root, running }),
      notice_id: notice?.id ?? "",
      notice_prompt: String(notice?.prompt ?? "").trim() || "没有额外说明，按用户本轮消息处理。",
    };
    const text = renderPrompt(bodies.join("\n\n"), values);
    if (text.includes("{{")) log("warn", "prompt", entry, "rendered prompt still holds an unresolved placeholder");
    return text;
  }

  return {
    read,
    listSections,
    selectSections,
    buildPrompt,
    stallActions,
    conversation: (args) => buildPrompt({ ...args, entry: "conversation" }),
    noticeReply: (args) => buildPrompt({ ...args, entry: "notice" }),
  };
}
