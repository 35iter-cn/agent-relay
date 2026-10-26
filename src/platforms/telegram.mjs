#!/usr/bin/env bun
import { join } from "node:path";
import { chunkText } from "../shared/chunk.mjs";
import { relayEnv } from "../shared/env.mjs";

const POLL_TIMEOUT_S = relayEnv("POLL_TIMEOUT", 25);
const TYPING_REFRESH_MS = relayEnv("TYPING_MS", 4_000);
const WAIT_TIMEOUT_MS = relayEnv("WAIT_MS", 90 * 60_000);
const ALERT_COOLDOWN_MS = relayEnv("ALERT_COOLDOWN_MS", 30 * 60_000);
const MIRROR_TIMEOUT_MS = 30_000;
const MIRROR_STEP_MS = 250;
const CHUNK_LIMIT = 4096;

export const replyRules = "- 可以写 `**粗体**`、行内代码与 ``` 代码围栏（会转成 Telegram 的 HTML），不要用 Markdown 表格。";

export function channelKey(postId) {
  return `ch${postId}`;
}

export function sessionFor(key) {
  return `tg-${key}`;
}

export function channelPostIdFor(message) {
  const source = message?.is_automatic_forward ? message : message?.reply_to_message;
  if (!source?.is_automatic_forward) return null;
  return source.forward_from_message_id ?? source.forward_origin?.message_id ?? null;
}

export function resolveCommentKey(threadId, channelPosts) {
  if (!threadId) return null;
  for (const [postId, info] of Object.entries(channelPosts ?? {})) {
    if (String(info?.mirrorId) === String(threadId)) return channelKey(Number(postId));
  }
  return null;
}

export function mirrorFor(channelPosts, postId) {
  return channelPosts?.[String(postId)]?.mirrorId ?? null;
}

export function nextOffset(updates) {
  if (!updates?.length) return null;
  return Math.max(...updates.map((update) => Number(update.update_id) + 1));
}

export function learnMirror(message) {
  const postId = channelPostIdFor(message);
  if (!postId) return null;
  return { postId, mirrorId: message.message_thread_id ?? message.reply_to_message?.message_id ?? null };
}

export async function waitForMirror({ read, timeoutMs = 30_000, stepMs = 250, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now }) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const mirror = read();
    if (mirror) return mirror;
    if (now() >= deadline) return null;
    await sleep(Math.min(stepMs, Math.max(0, deadline - now())));
  }
}

export async function pollUpdates({ api, cursor, handle, save, timeoutSeconds = POLL_TIMEOUT_S }) {
  const updates = await api("getUpdates", { offset: cursor ?? 0, timeout: timeoutSeconds, limit: 50, allowed_updates: ["message", "channel_post"] });
  let next = cursor;
  for (const update of updates ?? []) {
    if (update.channel_post) await handle(update.channel_post, "channel_post");
    else if (update.message) await handle(update.message, "message");
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
  const channelId = env.TELEGRAM_CHANNEL_ID;
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

  function topicFor(key, state) {
    const topic = state.convs?.[key]?.topic ?? null;
    if (topic) return topic;
    const match = /^ch(\d+)$/.exec(key);
    return match ? mirrorFor(state.meta?.channelPosts, match[1]) : null;
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
      const mirror = /^ch(\d+)$/.exec(key)?.[1];
      if (mirror && state.meta?.channelPosts?.[mirror]?.mirrorId) payload.message_thread_id = Number(state.meta.channelPosts[mirror].mirrorId);
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
      state.meta.channelPosts = state.meta.channelPosts ?? {};

      const rememberMirror = (postId, mirrorId) => {
        if (!postId || !mirrorId) return;
        state.meta.channelPosts[String(postId)] = { mirrorId, at: new Date().toISOString() };
        core.save();
        log("mirror", `post=${postId}`, `mirror=${mirrorId}`);
      };

      const dispatch = async (key, message, text, extra = {}) => {
        const inbound = {
          key,
          session: sessionFor(key),
          dedupeId: String(message.message_id),
          authorId: String(message.from?.id ?? allowedUser),
          text,
          chatId,
          topic: message.message_thread_id ?? null,
          rootText: extra.rootText ?? null,
          replyTo: message.message_id,
          replyIds: [message.reply_to_message?.message_id, message.message_thread_id].filter(Boolean),
          channelPost: extra.channelPost ?? null,
        };
        if (inbound.topic !== null) {
          const entry = state.convs[key] ?? { session: inbound.session, rootText: text, lastMsgTs: null };
          entry.topic = inbound.topic;
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

      const handleMessage = async (message) => {
        if (message.is_automatic_forward) {
          const postId = channelPostIdFor(message);
          if (postId) rememberMirror(postId, message.message_id);
          else log("ignore", "auto-forward", message.message_id);
          return;
        }
        if (String(message.chat?.id) !== String(chatId)) return log("ignore", "chat", message.chat?.id);
        if (message.from?.is_bot) return log("ignore", "bot", message.from?.id);
        if (String(message.from?.id) !== String(allowedUser)) return log("ignore", "author", message.from?.id);
        const text = stripMentions(message.text ?? "", message.entities);
        if (!text) return log("ignore", "empty", message.message_id);
        let key = resolveCommentKey(message.message_thread_id, state.meta.channelPosts);
        if (!key) {
          const learned = learnMirror(message);
          if (!learned) return log("ignore", "not-comment", message.message_id);
          rememberMirror(learned.postId, learned.mirrorId);
          key = channelKey(learned.postId);
        }
        await dispatch(key, message, text);
      };

      const handleChannelPost = async (post) => {
        if (!channelId) return log("ignore", "channel-post-noid", post.message_id);
        if (String(post.chat?.id) !== String(channelId)) return log("ignore", "channel", post.chat?.id);
        const text = stripMentions(post.text ?? "", post.entities);
        if (!text) return log("ignore", "channel-empty", post.message_id);
        await dispatch(channelKey(post.message_id), post, text, { channelPost: post.message_id, rootText: text });
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
            handle: async (payload, kind) => {
              if (kind === "channel_post") await handleChannelPost(payload).catch((error) => log("error", "channel-post", String(error)));
              else await handleMessage(payload).catch((error) => log("error", "handle", String(error)));
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
      let replyTo = ctx.replyTo ?? null;
      if (ctx.channelPost && !replyTo) {
        const mirror = await waitForMirror({ read: () => mirrorFor(state.meta?.channelPosts, ctx.channelPost), timeoutMs: MIRROR_TIMEOUT_MS, stepMs: MIRROR_STEP_MS });
        if (!mirror) log("warn", "no-mirror", `post=${ctx.channelPost}`);
        replyTo = mirror ?? replyTo;
      }
      const sent = await sendText({ chatId, topic: topicFor(ctx.key, state), replyTo }, text);
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

    postNotice: async (text) => {
      client = client ?? apiFactory(token);
      const target = channelId ? { chatId: channelId, topic: null } : { chatId, topic: null };
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
