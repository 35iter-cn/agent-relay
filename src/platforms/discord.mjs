#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chunkText } from "../shared/chunk.mjs";
import { flattenTables } from "../shared/markdown.mjs";
import { relayEnv } from "../shared/env.mjs";
import { ensurePrivateDir } from "../shared/fs.mjs";
import { pruneConversations } from "./shared/root-cache.mjs";
import { extFor, MAX_ATTACHMENTS, MAX_BYTES, uploadDirFor } from "./shared/uploads.mjs";

const API_BASE = "https://discord.com/api/v10";
const GATEWAY_BASE = "wss://gateway.discord.gg/?v=10&encoding=json";
const CHUNK_LIMIT = 2_000;
const INTENTS = { GUILDS: 1 << 0, GUILD_MESSAGES: 1 << 9, MESSAGE_CONTENT: 1 << 15 };
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
const MESSAGE_INDEX_RETENTION_MS = 30 * 86_400_000;
const MESSAGE_INDEX_MAX = 5_000;
const THREAD_RETENTION_MS = 30 * 86_400_000;

export function sessionFor(key) {
  return `dc-${key}`;
}

export function typingTargets(keys, jobs) {
  return [...new Set([...(keys ?? []), ...(jobs ?? [])])];
}

export function threadKey(threadId) {
  return threadId ? `t${threadId}` : null;
}

export function threadName(text, limit = 80) {
  const line = String(text ?? "")
    .split("\n")
    .map((part) => part.replace(/[`*_~|>#]/g, "").trim())
    .find(Boolean);
  const name = [...(line ?? "")].slice(0, limit).join("").trim();
  return name || "新会话";
}

export function intents() {
  return INTENTS.GUILDS | INTENTS.GUILD_MESSAGES | INTENTS.MESSAGE_CONTENT;
}

export function identifyPayload(token, value = intents()) {
  return { token, intents: value, properties: { os: "linux", browser: "agent-relay", device: "agent-relay" } };
}

export function resumePayload(token, sessionId, seq) {
  return { token, session_id: sessionId, seq: seq ?? null };
}

export function retryAfterMs(headerValue, body) {
  const seconds = Number(body?.retry_after);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.ceil(seconds * 1_000), 60_000);
  const fromHeader = Number(headerValue);
  if (headerValue !== null && headerValue !== undefined && headerValue !== "" && Number.isFinite(fromHeader) && fromHeader >= 0) {
    return Math.min(Math.ceil(fromHeader * 1_000), 60_000);
  }
  return 1_000;
}

export function isArchivedError(error) {
  return error?.code === 50083 || /archived thread/i.test(String(error?.message ?? ""));
}

export function stripBotMentions(text, botId) {
  const source = String(text ?? "");
  if (!botId) return source.trim();
  const pattern = new RegExp(`<@!?${String(botId)}>`, "g");
  return source.replace(pattern, "").trim();
}

export function routeMessage(message, { parentChannelId, allowedUser, botId, threads = {}, msgKeys = {} } = {}) {
  if (!message) return { ok: false, why: "empty" };
  if (!parentChannelId) return { ok: false, why: "unconfigured" };
  if (message.author?.bot || (botId && String(message.author?.id) === String(botId))) return { ok: false, why: "bot" };
  if (allowedUser && String(message.author?.id) !== String(allowedUser)) return { ok: false, why: "author" };
  const channel = String(message.channel_id ?? "");
  const parent = String(parentChannelId);
  const known = threads[channel];
  if (channel === parent) {
    const ref = message.message_reference?.message_id;
    if (!ref) return { ok: true, root: true, key: null, threadId: null, replyTo: null };
    const hit = msgKeys[String(ref)];
    return {
      ok: true,
      root: false,
      key: hit ? hit.key : `g${ref}`,
      threadId: null,
      replyTo: String(ref),
    };
  }
  if (known) return { ok: true, root: false, key: known.key, threadId: channel, replyTo: null };
  return { ok: false, why: "channel" };
}

export function mediaPayload(content, replyTo) {
  const payload = { allowed_mentions: { parse: [] } };
  if (content) payload.content = content;
  if (replyTo) payload.message_reference = { message_id: String(replyTo), fail_if_not_exists: false };
  return payload;
}

export function mediaBatches(files, maxBytes = MAX_BYTES) {
  const batches = [];
  let current = [];
  let size = 0;
  for (const file of files) {
    if (current.length && size + file.size > maxBytes) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(file);
    size += file.size;
  }
  if (current.length) batches.push(current);
  return batches;
}

export function mediaFormData(files, payload, { FormDataCtor = FormData, BlobCtor = Blob, readFile = readFileSync } = {}) {
  const form = new FormDataCtor();
  form.append("payload_json", JSON.stringify(payload));
  files.forEach((file, i) => {
    const bytes = readFile(file.path);
    form.append(`files[${i}]`, new BlobCtor([bytes], { type: file.mime }), file.name ?? `image-${i}`);
  });
  return form;
}

const MEDIA_FAILURES = { 50013: "permission", 40005: "size", 50045: "size" };
const DEGRADE_TEXT = { permission: "Discord 授权缺少 Attach Files", size: "图片超过 Discord 单文件上限" };

export function mediaFailureKind(error) {
  const mapped = MEDIA_FAILURES[error?.code];
  if (mapped) return mapped;
  if (error?.status === 403) return "permission";
  if (error?.status === 413) return "size";
  return null;
}

export function createMediaUploader({ token, channelId, log = () => {}, reply, remember = () => {}, unarchive = null, fetchFn = (...args) => fetch(...args) }) {
  async function send(channel, buildForm) {
    for (let attempt = 0; ; attempt += 1) {
      const res = await fetchFn(`${API_BASE}/channels/${channel}/messages`, {
        method: "POST",
        headers: { Authorization: `Bot ${token}` },
        body: buildForm(),
      });
      const raw = await res.text();
      let parsed = null;
      try {
        parsed = raw ? JSON.parse(raw) : null;
      } catch {
        parsed = null;
      }
      if (res.status === 429 && attempt < 2) {
        const wait = retryAfterMs(res.headers.get("retry-after"), parsed);
        log("warn", "rate-limit", "POST media", `${wait}ms`);
        await new Promise((resolve) => setTimeout(resolve, wait));
        continue;
      }
      if (!res.ok) {
        const error = new Error(`POST /channels/${channel}/messages ${res.status} ${parsed?.message ?? raw.slice(0, 200)}`);
        error.status = res.status;
        error.code = parsed?.code;
        throw error;
      }
      return parsed;
    }
  }

  async function degrade(ctx, files, reason) {
    await reply(ctx, `（${files.length} 张图片未能上传：${reason}）`);
    return { messageId: null, degraded: true };
  }

  return async function postMedia(ctx, files) {
    if (!token) return degrade(ctx, files, "缺少 bot token");
    const channel = ctx?.threadId ? String(ctx.threadId) : String(channelId);
    const replyTo = ctx?.threadId ? null : (ctx?.replyTo ?? null);
    try {
      for (const batch of mediaBatches(files)) {
        const buildForm = () => mediaFormData(batch, mediaPayload(null, replyTo));
        let sent;
        try {
          sent = await send(channel, buildForm);
        } catch (error) {
          if (!isArchivedError(error) || !unarchive) throw error;
          await unarchive(channel);
          sent = await send(channel, buildForm);
        }
        if (sent?.id && ctx?.key) remember(String(sent.id), ctx.key);
      }
      return { messageId: null, degraded: false };
    } catch (error) {
      const kind = mediaFailureKind(error);
      if (!kind) throw error;
      log("warn", "postMedia", `${kind} ${String(error?.message ?? error)}`);
      return degrade(ctx, files, DEGRADE_TEXT[kind]);
    }
  };
}

export function createPlatform({ config, log: baseLog }) {
  const env = { ...config.readEnv(config.envFile("discord.env")), ...process.env };
  const token = env.DISCORD_BOT_TOKEN;
  const channelId = env.DISCORD_CHANNEL_ID;
  const allowedUser = env.DISCORD_ALLOWED_USER ?? relayEnv("ALLOWED_USER", undefined, env);
  const typingRefreshMs = relayEnv("TYPING_MS", 8_000);
  const pacingMs = relayEnv("PACING_MS", 250);
  const log = baseLog;

  const typing = { timer: null, cursor: 0, busy: false, keys: new Set(), jobs: new Set() };
  let rest = null;
  let state = null;
  let coreRef = null;
  let botId = null;
  let dispatchMessage = null;
  let socket = null;
  let seq = 0;
  let sessionId = null;
  let resumeUrl = null;
  let heartbeat = null;
  let beatAcked = true;
  let announced = false;
  let closed = false;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function createRest(tok) {
    return async function call(path, { method = "GET", body, retries = 2 } = {}) {
      for (let attempt = 0; ; attempt += 1) {
        const res = await fetch(`${API_BASE}${path}`, {
          method,
          headers: { Authorization: `Bot ${tok}`, "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const raw = await res.text();
        let parsed = null;
        try {
          parsed = raw ? JSON.parse(raw) : null;
        } catch {
          parsed = null;
        }
        if (res.status === 429 && attempt < retries) {
          const wait = retryAfterMs(res.headers.get("retry-after"), parsed);
          log("warn", "rate-limit", `${method} ${path}`, `${wait}ms`);
          await sleep(wait);
          continue;
        }
        if (!res.ok) {
          const error = new Error(`${method} ${path} ${res.status} ${parsed?.message ?? raw.slice(0, 200)}`);
          error.status = res.status;
          error.code = parsed?.code;
          throw error;
        }
        return parsed;
      }
    };
  }

  const queues = new Map();

  function serial(channel, task) {
    const previous = queues.get(channel) ?? Promise.resolve();
    const next = previous.then(task, task);
    queues.set(
      channel,
      next.catch(() => {}),
    );
    return next;
  }

  function rememberMessage(messageId, key) {
    if (!messageId || !key) return;
    state.meta.msgKeys[String(messageId)] = { key, at: new Date().toISOString() };
    const ids = Object.keys(state.meta.msgKeys);
    if (ids.length > MESSAGE_INDEX_MAX) {
      ids.sort((a, b) => String(state.meta.msgKeys[a]?.at).localeCompare(String(state.meta.msgKeys[b]?.at)));
      for (const id of ids.slice(0, ids.length - MESSAGE_INDEX_MAX)) delete state.meta.msgKeys[id];
    }
  }

  function rememberThread(threadId, key) {
    if (!threadId || !key) return;
    state.meta.threads[String(threadId)] = { key, at: new Date().toISOString() };
  }

  async function unarchive(channel) {
    await rest(`/channels/${channel}`, { method: "PATCH", body: { archived: false } });
    await sleep(pacingMs);
  }

  async function sendOne({ channel, replyTo = null, content }) {
    const payload = { content, allowed_mentions: { parse: [] } };
    if (replyTo) payload.message_reference = { message_id: String(replyTo), fail_if_not_exists: false };
    const attempt = () => rest(`/channels/${channel}/messages`, { method: "POST", body: payload });
    try {
      return await attempt();
    } catch (error) {
      if (!isArchivedError(error)) throw error;
      await unarchive(channel);
      return attempt();
    }
  }

  async function sendChunks(channel, text, replyTo = null) {
    const chunks = chunkText(flattenTables(String(text ?? "")), CHUNK_LIMIT).filter((chunk) => chunk.trim());
    const ids = [];
    for (const chunk of chunks) {
      const sent = await serial(channel, async () => {
        const result = await sendOne({ channel, replyTo: ids.length ? null : replyTo, content: chunk });
        await sleep(pacingMs);
        return result;
      });
      if (sent?.id) ids.push(String(sent.id));
    }
    return ids;
  }

  async function openThread(message) {
    try {
      return await rest(`/channels/${channelId}/messages/${message.id}/threads`, {
        method: "POST",
        body: { name: threadName(message.content), auto_archive_duration: 10_080 },
      });
    } catch (error) {
      log("warn", "thread-open", String(error?.message ?? error));
      return null;
    }
  }

  async function openRoundThread({ messageId, name, key }) {
    if (!messageId) return null;
    rest = rest ?? createRest(token);
    const created = await rest(`/channels/${channelId}/messages/${messageId}/threads`, {
      method: "POST",
      body: { name: threadName(name), auto_archive_duration: 10_080 },
    }).catch((error) => {
      log("warn", "round-thread", String(error?.message ?? error));
      return null;
    });
    const threadId = created?.id ? String(created.id) : null;
    if (!threadId) return null;
    rememberThread(threadId, key);
    coreRef?.save();
    return { threadId, key };
  }

  async function downloadAttachments(message, chat) {
    const all = Array.isArray(message.attachments) ? message.attachments : [];
    const picked = all.slice(0, MAX_ATTACHMENTS);
    const dir = uploadDirFor(config.configDir, chat);
    const saved = [];
    const failed = [];
    for (const item of picked) {
      try {
        const res = await fetch(item.url);
        if (!res.ok) throw new Error(`http ${res.status}`);
        const mime = String(item.content_type ?? res.headers.get("content-type") ?? "").split(";")[0].trim();
        const name = `${String(item.id ?? Date.now()).slice(-12)}.${extFor(mime, item.filename)}`;
        const buffer = Buffer.from(await res.arrayBuffer());
        if (buffer.byteLength > MAX_BYTES) {
          failed.push(item);
          continue;
        }
        ensurePrivateDir(dir);
        const file = join(dir, name);
        writeFileSync(file, buffer, { mode: 0o600 });
        saved.push({ kind: mime.startsWith("image/") ? "image" : "file", path: file, name: item.filename ?? null });
      } catch (error) {
        log("error", "attachment", String(item?.id ?? ""), String(error?.message ?? error));
        failed.push(item);
      }
    }
    return { saved, failed, truncated: Math.max(0, all.length - picked.length) };
  }

  async function channelIsOurs(channel) {
    const info = await rest(`/channels/${channel}`).catch(() => null);
    if (!info) return false;
    return String(info.parent_id ?? "") === String(channelId);
  }

  async function handleMessage(message) {
    const route = routeMessage(message, {
      parentChannelId: channelId,
      allowedUser,
      botId,
      threads: state.meta.threads,
      msgKeys: state.meta.msgKeys,
    });
    if (!route.ok && route.why === "channel") {
      if (!(await channelIsOurs(message.channel_id))) return log("ignore", "channel", message.channel_id);
      rememberThread(message.channel_id, threadKey(message.channel_id));
      coreRef?.save();
      return handleMessage(message);
    }
    if (!route.ok) return log("ignore", route.why, message.id ?? "");

    let key = route.key;
    let threadId = route.threadId;
    if (route.root) {
      const thread = await openThread(message);
      if (thread?.id) {
        threadId = String(thread.id);
        key = threadKey(threadId);
        rememberThread(threadId, key);
        coreRef?.save();
      } else {
        key = `g${message.id}`;
      }
    }

    const parsed = await downloadAttachments(message, threadId ?? channelId);
    const base = stripBotMentions(message.content ?? "", botId);
    const notes = [];
    if (!base) notes.push(`（发了 ${parsed.saved.length} 个附件，未附文字）`);
    if (parsed.failed.length) notes.push(`（${parsed.failed.length} 个附件下载失败，未能查看）`);
    if (parsed.truncated) notes.push(`（还有 ${parsed.truncated} 个附件未处理，单条消息最多 ${MAX_ATTACHMENTS} 个）`);
    const text = [base, ...notes].filter(Boolean).join("\n");
    if (!text) return log("ignore", "empty", message.id ?? "");

    rememberMessage(message.id, key);
    coreRef?.save();

    const inbound = {
      key,
      session: sessionFor(key),
      dedupeId: String(message.id),
      authorId: String(message.author?.id ?? allowedUser),
      text,
      chatId: threadId ?? channelId,
      messageId: String(message.id),
      threadId,
      replyTo: null,
      replyIds: [message.message_reference?.message_id, message.id].filter(Boolean).map(String),
      attachments: parsed.saved,
      rootText: state.convs?.[key]?.rootText ?? text,
    };
    typing.keys.add(inbound.chatId);
    syncTyping();
    try {
      await dispatchMessage?.(inbound);
    } finally {
      setTimeout(() => {
        typing.keys.delete(inbound.chatId);
        syncTyping();
      }, 1_000);
    }
  }

  function syncTyping() {
    const targets = typingTargets(typing.keys, typing.jobs);
    if (!targets.length) {
      if (typing.timer) clearInterval(typing.timer);
      typing.timer = null;
      return;
    }
    if (typing.timer) return;
    typing.cursor = 0;
    const tick = async () => {
      if (typing.busy) return;
      const live = typingTargets(typing.keys, typing.jobs);
      const channel = live[typing.cursor % Math.max(1, live.length)];
      if (!channel) return;
      typing.busy = true;
      typing.cursor += 1;
      try {
        rest = rest ?? createRest(token);
        await rest(`/channels/${channel}/typing`, { method: "POST" });
      } catch (error) {
        log("warn", "typing", channel, String(error?.message ?? error));
      } finally {
        typing.busy = false;
      }
    };
    tick();
    typing.timer = setInterval(tick, typingRefreshMs);
  }

  function socketUrl() {
    if (sessionId && resumeUrl) {
      const url = new URL(resumeUrl);
      url.searchParams.set("v", "10");
      url.searchParams.set("encoding", "json");
      return url.toString();
    }
    return GATEWAY_BASE;
  }

  function connectOnce() {
    return new Promise((resolve) => {
      const ws = new WebSocket(socketUrl());
      socket = ws;
      let settled = false;

      const finish = () => {
        if (settled) return;
        settled = true;
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = null;
        resolve();
      };

      const send = (payload) => {
        try {
          ws.send(JSON.stringify(payload));
        } catch (error) {
          log("warn", "gateway-send", String(error?.message ?? error));
        }
      };

      const handshake = () => {
        if (sessionId) send({ op: 6, d: resumePayload(token, sessionId, seq) });
        else send({ op: 2, d: identifyPayload(token) });
      };

      ws.addEventListener("message", (event) => {
        let payload = null;
        try {
          payload = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
        } catch {
          return;
        }
        switch (payload.op) {
          case 10: {
            const interval = Number(payload.d?.heartbeat_interval) > 1_000 ? Number(payload.d.heartbeat_interval) : 41_250;
            if (heartbeat) clearInterval(heartbeat);
            beatAcked = true;
            heartbeat = setInterval(() => {
              if (!beatAcked) {
                log("warn", "heartbeat-miss", "closing to resume");
                try {
                  ws.close(4000, "heartbeat");
                } catch {}
                return;
              }
              beatAcked = false;
              send({ op: 1, d: seq || null });
            }, interval);
            heartbeat.unref?.();
            handshake();
            return;
          }
          case 11:
            beatAcked = true;
            return;
          case 1:
            send({ op: 1, d: seq || null });
            return;
          case 7:
            log("info", "gateway-reconnect-request");
            try {
              ws.close(4000, "reconnect");
            } catch {}
            return;
          case 9:
            log("warn", "gateway-invalid-session");
            sessionId = null;
            seq = 0;
            setTimeout(() => {
              try {
                ws.close(4000, "invalid-session");
              } catch {}
            }, 1_000 + Math.random() * 4_000);
            return;
          case 0: {
            if (typeof payload.s === "number") seq = payload.s;
            const type = payload.t;
            const data = payload.d;
            if (type === "READY") {
              sessionId = data?.session_id ?? null;
              resumeUrl = data?.resume_gateway_url ?? null;
              botId = String(data?.user?.id ?? botId ?? "");
              log("info", "gateway-ready", `bot=${botId}`);
              if (!announced) {
                announced = true;
                gatewayState.onReady?.();
              }
              return;
            }
            if (type === "RESUMED") {
              log("info", "gateway-resumed");
              return;
            }
            if (type === "MESSAGE_CREATE") handleMessage(data).catch((error) => log("error", "handle", String(error?.message ?? error)));
            return;
          }
          default:
            return;
        }
      });

      ws.addEventListener("close", (event) => {
        log("info", "gateway-close", String(event.code ?? ""), String(event.reason ?? ""));
        finish();
        if (FATAL_CLOSE_CODES.has(event.code)) {
          log("error", "gateway-fatal", `close ${event.code}`, event.code === 4004 ? "bot token rejected" : "intents or shard rejected");
          process.exit(1);
        }
        gatewayState.wake?.();
      });

      ws.addEventListener("error", () => {});
    });
  }

  const gatewayState = { onReady: null, wake: null };

  async function gatewayLoop() {
    let attempts = 0;
    while (!closed) {
      await connectOnce();
      if (closed) return;
      attempts += 1;
      const wait = Math.min(1_000 * 2 ** Math.min(attempts - 1, 6), 60_000);
      log("warn", "gateway-reconnect", `${wait}ms`, `attempt=${attempts}`);
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, wait);
        gatewayState.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      gatewayState.wake = null;
      if (socket?.readyState === WebSocket.OPEN) attempts = 0;
    }
  }

  const adapter = {
    name: "discord",
    surface: "本线程",
    allowedUser,
    chunkLimit: CHUNK_LIMIT,
    timeoutMs: relayEnv("TIMEOUT_MS", 0),
    maxWorkers: relayEnv("MAX_WORKERS", 5),
    queueDepth: relayEnv("QUEUE_DEPTH", 3),
    worker: relayEnv("WORKER", "pi"),
    workerMode: relayEnv("WORKER_MODE", "rpc"),
    steer: relayEnv("STEER", "on"),
    piBin: config.workerBin,
    sessionFor,

    selfContext: (key) => {
      const value = String(key ?? "");
      const threadId = value.startsWith("t") ? value.slice(1) : "";
      return threadId ? { chatId: threadId, threadId, replyTo: null } : null;
    },

    async start({ onMessage, onReady, core }) {
      coreRef = core;
      state = core.state;
      dispatchMessage = onMessage;
      gatewayState.onReady = onReady;
      if (!token) {
        log("error", "missing-credential", "DISCORD_BOT_TOKEN");
        process.exit(1);
      }
      if (!channelId || !allowedUser) {
        log("error", "missing-credential", !channelId ? "DISCORD_CHANNEL_ID" : "DISCORD_ALLOWED_USER");
        process.exit(1);
      }
      rest = createRest(token);
      state.meta = state.meta ?? {};
      state.meta.msgKeys = state.meta.msgKeys ?? {};
      state.meta.threads = state.meta.threads ?? {};
      log("info", "start", `channel=${channelId}`, `allowed=${allowedUser}`, `state=${config.stateFile("discord")}`);
      await gatewayLoop();
      return new Promise(() => {});
    },

    async reply(ctx, text) {
      rest = rest ?? createRest(token);
      const channel = ctx.threadId ? String(ctx.threadId) : String(channelId);
      const replyTo = ctx.threadId ? null : (ctx.replyTo ?? null);
      const ids = await sendChunks(channel, text, replyTo);
      if (!ids.length) return null;
      if (ctx.key) {
        rememberMessage(ids[0], ctx.key);
        coreRef?.save();
      }
      return { messageId: ids.at(-1) };
    },

    async edit(ctx, messageId, text) {
      rest = rest ?? createRest(token);
      const channel = ctx.threadId ? String(ctx.threadId) : String(channelId);
      const content = chunkText(flattenTables(String(text ?? "")), CHUNK_LIMIT)[0] ?? "";
      try {
        await rest(`/channels/${channel}/messages/${messageId}`, { method: "PATCH", body: { content, allowed_mentions: { parse: [] } } });
        return true;
      } catch (error) {
        log("warn", "edit", String(error?.message ?? error));
        return false;
      }
    },

    openRoundThread,

    async onProgress(ctx) {
      const channel = ctx.threadId ? String(ctx.threadId) : String(channelId);
      typing.jobs.add(channel);
      syncTyping();
    },

    async onProgressDone(ctx) {
      const channel = ctx.threadId ? String(ctx.threadId) : String(channelId);
      typing.jobs.delete(channel);
      syncTyping();
    },

    prune: () => {
      if (!state) return { convs: 0, topics: 0 };
      const now = Date.now();
      const convs = pruneConversations(state.convs, now);
      const dropped = Object.keys(state.convs ?? {}).length - Object.keys(convs).length;
      state.convs = convs;
      let topics = 0;
      for (const [id, slot] of Object.entries(state.meta?.msgKeys ?? {})) {
        const at = Date.parse(slot?.at ?? "");
        if (!Number.isFinite(at) || now - at > MESSAGE_INDEX_RETENTION_MS) {
          delete state.meta.msgKeys[id];
          topics += 1;
        }
      }
      for (const [id, slot] of Object.entries(state.meta?.threads ?? {})) {
        const at = Date.parse(slot?.at ?? "");
        if (!Number.isFinite(at) || now - at > THREAD_RETENTION_MS) {
          delete state.meta.threads[id];
          topics += 1;
        }
      }
      if (dropped || topics) coreRef?.save();
      return { convs: dropped, topics };
    },

    postNotice: async (text) => {
      rest = rest ?? createRest(token);
      const ids = await sendChunks(String(channelId), text);
      return { messageId: ids[0] ?? null };
    },

    postMedia: createMediaUploader({
      token,
      channelId,
      log,
      reply: (ctx, text) => adapter.reply(ctx, text),
      remember: (messageId, key) => {
        if (!state?.meta?.msgKeys) return;
        rememberMessage(messageId, key);
        coreRef?.save();
      },
      unarchive: (channel) => unarchive(channel),
    }),
  };

  return adapter;
}
