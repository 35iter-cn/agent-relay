#!/usr/bin/env bun
import { mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { chunkText } from "../shared/chunk.mjs";
import { relayEnv } from "../shared/env.mjs";
import { createRootCache } from "./shared/root-cache.mjs";
import { ensurePrivateDir } from "../shared/fs.mjs";
import { MAX_ATTACHMENTS, MAX_BYTES, uploadDirFor, pruneUploads, extFor } from "./shared/uploads.mjs";

const CARD_LIMIT = 3000;
const DOWNLOAD_TIMEOUT_MS = 15_000;
const PROGRESS_EMOJI = "THINKING";
const PERMISSION_ERRORS = new Set([99991672, 99991663, 99991400, 1061045]);

export const replyRules = "- 用 **粗体**、`行内代码`、``` 代码围栏、• 列表；不要用 `#` 标题，不要用 Markdown 表格。";

export function conversationKey(message) {
  if (message?.thread_id) return `th-${message.thread_id}`;
  if (message?.root_id) return `th-${message.root_id}`;
  if (message?.parent_id) return `th-${message.parent_id}`;
  return `ms-${message?.message_id}`;
}

export function sessionFor(key) {
  return `fs-${key}`;
}

export function textOf(message) {
  try {
    return JSON.parse(message?.content ?? "{}").text ?? "";
  } catch {
    return message?.content ?? "";
  }
}

export function stripMentions(text, mentions = []) {
  let out = String(text ?? "");
  for (const mention of mentions) {
    if (!mention?.key) continue;
    out = out.split(`${mention.key} `).join("").split(mention.key).join("");
  }
  return out.trim();
}

export function isAcceptedSender(sender, allowedUser) {
  const type = sender?.sender_type ?? "";
  if (type === "app") return { ok: false, why: "bot" };
  const openId = sender?.sender_id?.open_id ?? "";
  if (allowedUser && openId !== allowedUser) return { ok: false, why: "author" };
  return { ok: true, openId };
}

export function isAcceptedChat(chat, expected) {
  if (!expected) return false;
  return String(chat ?? "") === String(expected);
}

export function shouldAlertLiveness(status, misses, threshold) {
  if (!status) return false;
  if (status.state === "connected") return false;
  if (status.state === "failed") return true;
  return misses >= threshold;
}

export function toCard(text, limit = CARD_LIMIT) {
  return {
    schema: "2.0",
    body: { elements: chunkText(text, limit).map((content) => ({ tag: "markdown", content })) },
  };
}

export function notifyCard(text, limit = CARD_LIMIT) {
  return toCard(text, limit);
}

export function decideProgressMode(code) {
  if (code === 0) return "reaction";
  if (PERMISSION_ERRORS.has(Number(code))) return "card";
  return "none";
}

export function createRuntime({ client, log, chatId, allowedUser = null, chunkLimit = CARD_LIMIT }) {
  async function send(target, msgType, content, extra = {}) {
    const res = await client.im.v1.message.reply({
      path: { message_id: target.messageId },
      data: { msg_type: msgType, content: JSON.stringify(content), ...extra },
    });
    if (res.code !== 0) throw Object.assign(new Error(`reply ${res.code} ${res.msg}`), { code: res.code });
    return res.data?.message_id ?? null;
  }

  const runtime = {
    async onProgress(ctx) {
      try {
        const res = await client.im.v1.messageReaction.create({
          path: { message_id: ctx.messageId },
          data: { reaction_type: { emoji_type: PROGRESS_EMOJI } },
        });
        const mode = decideProgressMode(res.code);
        if (mode === "reaction") {
          return { mode: "reaction", messageId: ctx.messageId, reactionId: res.data?.reaction_id ?? null };
        }
        if (mode === "card") {
          const cardId = await send({ messageId: ctx.messageId }, "interactive", toCard("⏳ 处理中…"), ctx.threadId ? { reply_in_thread: true } : {}).catch((error) => {
            log("warn", "progress-card", String(error));
            return null;
          });
          if (cardId) return { mode: "card", messageId: cardId, reactionId: null, pending: true };
        }
        log("warn", "progress-unavailable", res.code, res.msg);
        return null;
      } catch (error) {
        log("warn", "progress", String(error));
        return null;
      }
    },

    async onProgressDone(ctx) {
      const entry = ctx.progress;
      if (entry?.mode !== "reaction" || !entry.reactionId) return;
      try {
        const res = await client.im.v1.messageReaction.delete({ path: { message_id: entry.messageId ?? ctx.messageId, reaction_id: entry.reactionId } });
        if (res.code !== 0) log("warn", "progress-delete", res.code, res.msg);
      } catch (error) {
        log("warn", "progress-delete", String(error));
      }
    },

    async reply(ctx, text) {
      const entry = ctx.progress;
      const parts = chunkText(text, chunkLimit);
      if (entry?.mode === "card" && entry.messageId && entry.pending && parts.length) {
        try {
          const res = await client.im.v1.message.patch({ path: { message_id: entry.messageId }, data: { content: JSON.stringify(toCard(parts[0])) } });
          if (res?.code === 0 || res?.code === undefined) {
            entry.pending = false;
            for (const part of parts.slice(1)) await replyOnce(ctx, part);
            return { messageId: entry.messageId, patched: true };
          }
          log("warn", "patch", res.code, res.msg);
        } catch (error) {
          log("warn", "patch", String(error));
        }
        entry.pending = false;
      }
      let last = null;
      for (const part of parts) last = (await replyOnce(ctx, part)) ?? last;
      return last ? { messageId: last } : null;
    },

    async edit(ctx, messageId, text) {
      try {
        const res = await client.im.v1.message.patch({ path: { message_id: messageId }, data: { content: JSON.stringify(toCard(text)) } });
        if (res?.code === 0 || res?.code === undefined) return true;
        log("warn", "edit", res.code, res.msg);
        return false;
      } catch (error) {
        log("warn", "edit", String(error));
        return false;
      }
    },

    async notify(text) {
      const mention = allowedUser && !text.includes("<at ") ? `<at id=${allowedUser}></at> ` : "";
      const body = `${mention}${text}`;
      const res = await client.im.v1.message.create({
        params: { receive_id_type: "chat_id" },
        data: { receive_id: chatId, msg_type: "interactive", content: JSON.stringify(notifyCard(body)) },
      });
      if (res.code !== 0) throw new Error(`notify ${res.code} ${res.msg}`);
      return res.data?.message_id ?? null;
    },
  };

  async function replyOnce(ctx, part) {
    const extra = ctx.threadId ? { reply_in_thread: true } : {};
    try {
      return await send({ messageId: ctx.messageId }, "interactive", toCard(part), extra);
    } catch (error) {
      log("warn", "card-fallback", String(error));
      return await send({ messageId: ctx.messageId }, "text", { text: part }, extra);
    }
  }

  return runtime;
}

export async function defaultClientFactory({ appId, appSecret }) {
  const lark = await import("@larksuiteoapi/node-sdk");
  return new lark.default.Client({
    appId,
    appSecret,
    domain: lark.default.Domain.Feishu,
    loggerLevel: lark.default.LoggerLevel.warn,
  });
}

export function flattenCard(node, out = []) {
  if (node === null || node === undefined) return out;
  if (Array.isArray(node)) {
    for (const item of node) flattenCard(item, out);
    return out;
  }
  if (typeof node === "object") {
    if (typeof node.content === "string" && node.content) out.push(node.content);
    else if (typeof node.text === "string" && node.text) out.push(node.text);
    else for (const value of Object.values(node)) flattenCard(value, out);
  }
  return out;
}

export function bodyOf(message) {
  const raw = message?.body?.content ?? message?.content;
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

export function msgTypeOf(message) {
  return message?.msg_type ?? message?.message_type ?? null;
}

export function textOfMessage(message) {
  const type = msgTypeOf(message);
  const body = bodyOf(message);
  if (!body) return null;
  if (type === "text") return body.text ?? "";
  if (type === "interactive") return flattenCard(body).join("\n");
  if (type === "post") return flattenCard(body).join("\n");
  return null;
}

export function attachmentsOf(message) {
  const type = msgTypeOf(message);
  const body = bodyOf(message);
  if (!body) return [];
  if (type === "image") return body.image_key ? [{ kind: "image", key: body.image_key }] : [];
  if (type === "file") return body.file_key ? [{ kind: "file", key: body.file_key, name: body.file_name ?? null }] : [];
  if (type !== "post") return [];
  const found = [];
  const walk = (node) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== "object") return;
    if (typeof node.image_key === "string") found.push({ kind: "image", key: node.image_key });
    if (typeof node.file_key === "string") found.push({ kind: "file", key: node.file_key, name: node.file_name ?? null });
    Object.values(node).forEach(walk);
  };
  walk(body.content);
  return found;
}

export function withTimeout(promise, ms) {
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

export function createPlatform({ config, log: baseLog, createClient = defaultClientFactory, loadSdk = () => import("@larksuiteoapi/node-sdk") }) {
  const env = { ...config.readEnv(config.envFile("feishu.env")), ...process.env };
  const appId = env.FEISHU_APP_ID;
  const appSecret = env.FEISHU_APP_SECRET;
  const chatId = env.FEISHU_CHAT_ID;
  const allowedUser = relayEnv("ALLOWED_USER", null, env);
  const livenessCheckMs = relayEnv("LIVENESS_CHECK_MS", 60_000);
  const livenessMisses = relayEnv("LIVENESS_MISSES", 3);
  const alertCooldownMs = relayEnv("ALERT_COOLDOWN_MS", 30 * 60_000);
  const log = baseLog;
  let state = null;
  let coreRef = null;
  let runtime = null;
  let client = null;

  async function rootTextFor(message, key) {
    return rootCache.textFor(message, key);
  }

  const rootCache = createRootCache({
    getState: () => state,
    save: () => coreRef?.save(),
    log,
    sessionFor,
    fetchRootText: async (message) => {
      const rootId = message.root_id ?? message.parent_id;
      if (!rootId || rootId === message.message_id) return null;
      const res = await client.im.v1.message.get({
        path: { message_id: rootId },
        params: { card_msg_content_type: "user_card_content" },
      });
      return textOfMessage(res?.data?.items?.[0]) ?? "";
    },
  });

  function alertOnce(kind, text) {
    const now = Date.now();
    const last = Date.parse(state?.alerts?.[kind] ?? "");
    if (Number.isFinite(last) && now - last < alertCooldownMs) return log("info", "alert-suppressed", kind);
    if (state) {
      state.alerts[kind] = new Date(now).toISOString();
      coreRef?.save();
    }
    log("warn", "alert", kind);
    ensureRuntime()
      .then((rt) => rt.notify(text))
      .catch((error) => log("error", "alert", String(error?.message ?? error)));
  }

  async function ensureRuntime() {
    if (runtime) return runtime;
    if (!appId || !appSecret) {
      log("error", "missing-credential", "FEISHU_APP_ID / FEISHU_APP_SECRET");
      process.exit(1);
    }
    client = await createClient({ appId, appSecret });
    runtime = createRuntime({ client, log, chatId, allowedUser });
    return runtime;
  }

  function watchLiveness(ws) {
    let misses = 0;
    const timer = setInterval(() => {
      const status = typeof ws.getConnectionStatus === "function" ? ws.getConnectionStatus() : null;
      if (!status) return;
      if (status.state === "connected") {
        if (misses) log("info", "liveness-recovered", `${misses} missed checks`);
        misses = 0;
        return;
      }
      misses += 1;
      log("warn", "liveness", status.state, `misses=${misses}`, `reconnectAttempts=${status.reconnectAttempts ?? "-"}`);
      if (!shouldAlertLiveness(status, misses, livenessMisses)) return;
      alertOnce("ws", `🔴 agent-relay-feishu 的事件连接异常（${status.state}，连续 ${misses} 次检查未连接），可能收不到消息，需要人工看一下（journalctl --user -u agent-relay@feishu）`);
    }, livenessCheckMs);
    timer.unref?.();
    return timer;
  }

  async function downloadAttachments(message) {
    const all = attachmentsOf(message);
    const picked = all.slice(0, MAX_ATTACHMENTS);
    const dir = uploadDirFor(config.configDir, message.chat_id ?? chatId);
    const saved = [];
    const failed = [];
    for (const item of picked) {
      try {
        const res = await withTimeout(
          client.im.v1.messageResource.get({
            path: { message_id: message.message_id, file_key: item.key },
            params: { type: item.kind },
          }),
          DOWNLOAD_TIMEOUT_MS,
        );
        const mime = String(res?.headers?.["content-type"] ?? res?.headers?.["Content-Type"] ?? "").split(";")[0].trim();
        const file = join(dir, `${item.key.slice(0, 12)}.${extFor(mime, item.name)}`);
        ensurePrivateDir(dir);
        await res.writeFile(file);
        if (statSync(file).size > MAX_BYTES) {
          unlinkSync(file);
          failed.push(item);
          continue;
        }
        saved.push({ kind: item.kind, path: file, name: item.name ?? null });
      } catch (error) {
        log("error", "attachment", message.message_id ?? "", String(error?.message ?? error));
        failed.push(item);
      }
    }
    return { saved, failed, truncated: Math.max(0, all.length - picked.length) };
  }

  const adapter = {
    name: "feishu",
    surface: "本话题",
    allowedUser,
    chunkLimit: CARD_LIMIT,
    timeoutMs: relayEnv("TIMEOUT_MS", 2 * 60 * 60_000),
    maxWorkers: relayEnv("MAX_WORKERS", 5),
    queueDepth: relayEnv("QUEUE_DEPTH", 3),
    worker: relayEnv("WORKER", "pi"),
    piBin: join(config.home, ".bun/bin/pi"),
    replyRules,
    sessionFor,
    prune: () => pruneUploads(config.uploadsDir),

    async start({ onMessage, onReady, core }) {
      coreRef = core;
      state = core.state;
      if (!allowedUser) {
        log("error", "missing-credential", config.envFile("feishu.env"), "AGENT_RELAY_ALLOWED_USER");
        process.exit(1);
      }
      await ensureRuntime();
      pruneUploads(config.uploadsDir);
      const lark = await loadSdk();

      const dispatcher = new lark.default.EventDispatcher({}).register({
        "im.message.receive_v1": async (data) => {
          const message = data?.message ?? {};
          const verdict = isAcceptedSender(data?.sender, allowedUser);
          if (!verdict.ok) {
            log("ignore", verdict.why, message.message_id ?? "");
            return { code: 0 };
          }
          if (!isAcceptedChat(message.chat_id, chatId)) {
            log("ignore", "chat", message.chat_id ?? message.message_id ?? "");
            return { code: 0 };
          }
          const parsed = await downloadAttachments(message);
          const base = stripMentions(textOfMessage(message) ?? textOf(message), message.mentions);
          const notes = [];
          if (!base) notes.push(`（发了 ${parsed.saved.length} 个附件，未附文字）`);
          if (parsed.failed.length) notes.push(`（${parsed.failed.length} 个附件下载失败，未能查看）`);
          if (parsed.truncated) notes.push(`（还有 ${parsed.truncated} 个附件未处理，单条消息最多 ${MAX_ATTACHMENTS} 个）`);
          const text = [base, ...notes].filter(Boolean).join("\n");
          if (!text) {
            log("ignore", "empty", message.message_id ?? "");
            return { code: 0 };
          }
          const key = conversationKey(message);
          const rootText = await rootTextFor(message, key);
          const inbound = {
            key,
            session: sessionFor(key),
            dedupeId: message.message_id,
            authorId: verdict.openId,
            text,
            chatId: message.chat_id ?? chatId,
            messageId: message.message_id,
            threadId: message.thread_id ?? null,
            replyIds: [message.parent_id, message.root_id, message.thread_id].filter(Boolean),
            attachments: parsed.saved,
            rootText,
          };
          onMessage(inbound).catch((error) => log("error", "handle", String(error)));
          return { code: 0 };
        },
      });

      const ws = new lark.default.WSClient({
        appId,
        appSecret,
        domain: lark.default.Domain.Feishu,
        loggerLevel: lark.default.LoggerLevel.warn,
        autoReconnect: true,
        onReady: () => {
          log("info", "ws-ready");
          onReady?.();
        },
        onError: (error) => log("error", "ws", String(error?.message ?? error)),
      });

      log("info", "start", `allowed=${allowedUser}`, `state=${config.stateFile("feishu")}`);
      setInterval(() => rootCache.prune(), 86_400_000).unref();
      watchLiveness(ws);

      ws.start({ eventDispatcher: dispatcher });
      return new Promise(() => {});
    },

    async reply(ctx, text) {
      return (await ensureRuntime()).reply(ctx, text);
    },

    async edit(ctx, messageId, text) {
      return (await ensureRuntime()).edit(ctx, messageId, text);
    },

    async onProgress(ctx) {
      return (await ensureRuntime()).onProgress(ctx);
    },

    async onProgressDone(ctx) {
      return (await ensureRuntime()).onProgressDone(ctx);
    },

    async postNotice(text) {
      const messageId = await (await ensureRuntime()).notify(text);
      return { messageId };
    },
  };

  return adapter;
}
