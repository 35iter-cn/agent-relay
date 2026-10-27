#!/usr/bin/env bun
import { join } from "node:path";
import { chunkText } from "../shared/chunk.mjs";
import { relayEnv } from "../shared/env.mjs";
import { pruneConversations } from "./shared/root-cache.mjs";

const POLL_TIMEOUT_S = relayEnv("POLL_TIMEOUT", 25);
const TYPING_REFRESH_MS = relayEnv("TYPING_MS", 4_000);
const WAIT_TIMEOUT_MS = relayEnv("WAIT_MS", 90 * 60_000);
const ALERT_COOLDOWN_MS = relayEnv("ALERT_COOLDOWN_MS", 30 * 60_000);
const CHUNK_LIMIT = 4096;
const TOPIC_RETENTION_MS = 30 * 86_400_000;
const GENERAL_HINT = "这个群的主界面只发通知。要开对话请新建一个话题（topic），在话题里发消息；追问就留在同一个话题里。";

export const replyRules = "- 可以写 `**粗体**`、行内代码与 ``` 代码围栏（会转成 Telegram 的 HTML），不要用 Markdown 表格。";

export function sessionFor(key) {
  return `tg-${key}`;
}

export function topicKey(threadId) {
  return threadId ? `t${threadId}` : null;
}

export function isGeneralTopic(threadId) {
  return !threadId || String(threadId) === "1";
}

export function nextOffset(updates) {
  if (!updates?.length) return null;
  return Math.max(...updates.map((update) => Number(update.update_id) + 1));
}

export async function pollUpdates({ api, cursor, handle, save, timeoutSeconds = POLL_TIMEOUT_S }) {
  const updates = await api("getUpdates", { offset: cursor ?? 0, timeout: timeoutSeconds, limit: 50, allowed_updates: ["message"] });
  let next = cursor;
  for (const update of updates ?? []) {
    if (update.message) await handle(update.message, "message");
    next = Number(update.update_id) + 1;
    save?.(next);
  }
  return { cursor: next, count: updates?.length ?? 0 };
}

export function stripMentions(text, entities = []) {
  const spans = (entities ?? [])
    .filter((entity) => entity?.type === "mention" || entity?.type === "text_mention")
    .map((entity) => [entity.offset, entity.offset + entity.length])
    .sort((a, b) => b[0] - a[0]);
  let out = String(text ?? "");
  for (const [start, end] of spans) {
    if (start < 0 || end > out.length) continue;
    let from = start;
    let to = end;
    if (out[to] === " ") to += 1;
    else if (out[from - 1] === " ") from -= 1;
    out = out.slice(0, from) + out.slice(to);
  }
  return out.trim();
}

export function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function toTelegramHtml(text) {
  const parts = String(text).split("```");
  let out = "";
  parts.forEach((part, index) => {
    if (index % 2 === 1) {
      out += `<pre>${escapeHtml(part.replace(/^\n/, "").replace(/\n$/, ""))}</pre>`;
      return;
    }
    out += escapeHtml(part)
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  });
  return out;
}

export function pickTypingTarget(targets, cursor) {
  if (!targets?.length) return null;
  return targets[cursor % targets.length];
}

export function alertAllowed(alerts, kind, now, cooldownMs = ALERT_COOLDOWN_MS) {
  const last = Date.parse(alerts?.[kind] ?? "");
  return !Number.isFinite(last) || now - last > cooldownMs;
}

export function createPlatform({ config, log: baseLog }) {
  const env = { ...config.readEnv(config.envFile("telegram.env")), ...process.env };
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  const allowedUser = env.TELEGRAM_ALLOWED_USER ?? relayEnv("ALLOWED_USER", undefined, env);
  const log = baseLog;
  const typing = { timer: null, cursor: 0, busy: false, keys: new Set() };
  let client = null;

  function apiFactory(tok) {
    return async function api(method, params) {
      const res = await fetch(`https://api.telegram.org/bot${tok}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params ?? {}),
      });
      const body = await res.json().catch(() => null);
      if (!body) throw new Error(`${method} http ${res.status}`);
      if (!body.ok) throw new Error(`${method} ${body.error_code} ${body.description}`);
      return body.result;
    };
  }

  function messagePayload(target, text) {
    const payload = { chat_id: String(chatId), text: toTelegramHtml(text), parse_mode: "HTML", link_preview_options: { is_disabled: true } };
    if (target.topic) payload.message_thread_id = Number(target.topic);
    if (target.replyTo) payload.reply_parameters = { message_id: Number(target.replyTo), allow_sending_without_reply: true };
    return payload;
  }

  async function sendText(target, text) {
    const api = client;
    try {
      return await api("sendMessage", messagePayload(target, text));
    } catch (error) {
      if (String(error).includes("can't parse entities") || String(error).includes("can't find end of")) {
        return api("sendMessage", { ...messagePayload(target, text), parse_mode: undefined, text });
      }
      throw error;
    }
  }

  function topicOf(key) {
    const match = /^t(\d+)$/.exec(String(key ?? ""));
    return match ? Number(match[1]) : null;
  }

  function syncTyping() {
    const targets = [...typing.keys];
    if (!targets.length) {
      if (typing.timer) clearInterval(typing.timer);
      typing.timer = null;
      return;
    }
    if (typing.timer) return;
    typing.cursor = 0;
    const tick = async () => {
      if (typing.busy) return;
      const key = pickTypingTarget([...typing.keys], typing.cursor);
      if (!key) return;
      typing.busy = true;
      typing.cursor += 1;
      const payload = { chat_id: String(chatId), action: "typing" };
      const topic = topicOf(key);
      if (topic) payload.message_thread_id = topic;
      try {
        await client("sendChatAction", payload);
      } catch (error) {
        log("warn", "typing", key, String(error));
      } finally {
        typing.busy = false;
      }
    };
    tick();
    typing.timer = setInterval(tick, TYPING_REFRESH_MS);
  }

  let state = null;
  let coreRef = null;

  const adapter = {
    name: "telegram",
    surface: "本 topic",
    allowedUser,
    chunkLimit: CHUNK_LIMIT,
    timeoutMs: relayEnv("TIMEOUT_MS", 90 * 60_000),
    maxWorkers: relayEnv("MAX_WORKERS", 2),
    queueDepth: relayEnv("QUEUE_DEPTH", 3),
    worker: relayEnv("WORKER", "pi"),
    piBin: join(config.home, ".bun/bin/pi"),
    replyRules,
    sessionFor,

    async start({ onMessage, onReady, core }) {
      coreRef = core;
      state = core.state;
      if (!token) {
        log("error", "missing-credential", "TELEGRAM_BOT_TOKEN");
        process.exit(1);
      }
      if (!chatId || !allowedUser) {
        log("error", "missing-credential", !chatId ? "TELEGRAM_CHAT_ID" : "TELEGRAM_ALLOWED_USER");
        process.exit(1);
      }
      client = apiFactory(token);
      state.meta = state.meta ?? {};
      state.meta.topics = state.meta.topics ?? {};

      const dispatch = async (key, message, text) => {
        const threadId = message.message_thread_id ?? null;
        const inbound = {
          key,
          session: sessionFor(key),
          dedupeId: String(message.message_id),
          authorId: String(message.from?.id ?? allowedUser),
          text,
          chatId,
          threadId,
          rootText: state.meta.topics[String(threadId)]?.rootText ?? text,
          replyTo: message.message_id,
          replyIds: [message.reply_to_message?.message_id, threadId].filter(Boolean),
        };
        if (threadId !== null) {
          const entry = state.convs[key] ?? { session: inbound.session, rootText: text, lastMsgTs: null };
          entry.topic = threadId;
          state.convs[key] = entry;
        }
        typing.keys.add(key);
        syncTyping();
        try {
          return await onMessage(inbound);
        } finally {
          setTimeout(() => {
            typing.keys.delete(key);
            syncTyping();
          }, 1_000);
        }
      };

      const rememberTopic = (threadId, text) => {
        const slot = state.meta.topics[String(threadId)];
        if (!slot) {
          state.meta.topics[String(threadId)] = { rootText: text, at: new Date().toISOString() };
          core.save();
        }
      };

      const hintGeneral = async (message) => {
        const now = Date.now();
        if (!alertAllowed(state.alerts, "general", now)) return log("ignore", "general-hint-cooled", message.message_id);
        state.alerts.general = new Date(now).toISOString();
        core.save();
        log("ignore", "general", message.message_id);
        await sendText({ chatId, topic: null, replyTo: message.message_id }, GENERAL_HINT).catch((error) => log("warn", "general-hint", String(error)));
      };

      const handleMessage = async (message) => {
        if (String(message.chat?.id) !== String(chatId)) return log("ignore", "chat", message.chat?.id);
        if (message.from?.is_bot) return log("ignore", "bot", message.from?.id);
        if (String(message.from?.id) !== String(allowedUser)) return log("ignore", "author", message.from?.id);
        const text = stripMentions(message.text ?? "", message.entities);
        if (!text) return log("ignore", "empty", message.message_id);
        const threadId = message.message_thread_id ?? null;
        const replyIds = [message.reply_to_message?.message_id, threadId].filter(Boolean);
        if (isGeneralTopic(threadId) && !core.notices.match(replyIds)) return hintGeneral(message);
        if (!isGeneralTopic(threadId)) rememberTopic(threadId, text);
        await dispatch(topicKey(threadId) ?? "general", message, text);
      };

      if (state.cursor === null || state.cursor === undefined) {
        const updates = await client("getUpdates", { offset: -1, limit: 1, allowed_updates: ["message"] });
        state.cursor = nextOffset(updates) ?? 0;
        core.save();
        log("info", "bootstrap", `cursor=${state.cursor}`);
      }

      setInterval(() => {
        if (!alertAllowed(state.alerts, "poll", Date.now())) return;
        state.alerts.poll = new Date().toISOString();
        core.save();
      }, 86_400_000).unref();

      let backoff = 1_000;
      let failures = 0;
      let announced = false;
      for (;;) {
        try {
          await pollUpdates({
            api: client,
            cursor: state.cursor,
            handle: async (payload) => {
              await handleMessage(payload).catch((error) => log("error", "handle", String(error)));
            },
            save: (cursor) => {
              state.cursor = cursor;
              core.save();
            },
          });
          backoff = 1_000;
          failures = 0;
          if (!announced) {
            announced = true;
            onReady?.();
          }
        } catch (error) {
          failures += 1;
          log("error", "poll", String(error));
          if (failures >= 3) {
            log("warn", "alert", "poll", String(error));
            if (alertAllowed(state.alerts, "poll", Date.now())) {
              state.alerts.poll = new Date().toISOString();
              core.save();
              await sendText({ chatId, topic: null }, `telegram 拉消息连续失败：${error}`).catch(() => {});
            }
          }
          await new Promise((resolve) => setTimeout(resolve, backoff));
          backoff = Math.min(backoff * 2, 60_000);
        }
      }
    },

    async reply(ctx, text) {
      client = client ?? apiFactory(token);
      const sent = await sendText({ chatId, topic: topicOf(ctx.key), replyTo: ctx.replyTo ?? null }, text);
      return sent?.message_id ? { messageId: String(sent.message_id) } : null;
    },

    async edit(ctx, messageId, text) {
      client = client ?? apiFactory(token);
      const payload = { chat_id: String(chatId), message_id: Number(messageId), text: toTelegramHtml(text), parse_mode: "HTML", link_preview_options: { is_disabled: true } };
      try {
        await client("editMessageText", payload);
        return true;
      } catch (error) {
        if (String(error).includes("can't parse entities") || String(error).includes("can't find end of")) {
          try {
            await client("editMessageText", { ...payload, parse_mode: undefined, text });
            return true;
          } catch (retry) {
            log("warn", "edit", String(retry));
            return false;
          }
        }
        log("warn", "edit", String(error));
        return false;
      }
    },

    prune: () => {
      const now = Date.now();
      const convs = pruneConversations(state.convs, now);
      const dropped = Object.keys(state.convs ?? {}).length - Object.keys(convs).length;
      state.convs = convs;
      let topics = 0;
      for (const [id, slot] of Object.entries(state.meta?.topics ?? {})) {
        const at = Date.parse(slot?.at ?? "");
        if (!Number.isFinite(at) || now - at > TOPIC_RETENTION_MS) {
          delete state.meta.topics[id];
          topics += 1;
        }
      }
      if (dropped || topics) coreRef?.save();
      return { convs: dropped, topics };
    },

    postNotice: async (text) => {
      client = client ?? apiFactory(token);
      const target = { chatId, topic: null };
      let last = null;
      for (const chunk of chunkText(text, CHUNK_LIMIT)) {
        const sent = await sendText(target, chunk);
        last = sent?.message_id ? String(sent.message_id) : last;
      }
      return { messageId: last };
    },
  };

  return adapter;
}
