#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { chunkText } from "../shared/chunk.mjs";
import { relayEnv } from "../shared/env.mjs";
import { ensurePrivateDir } from "../shared/fs.mjs";
import { pruneConversations } from "./shared/root-cache.mjs";
import { extFor, MAX_ATTACHMENTS, MAX_BYTES, pruneUploads, uploadDirFor } from "./shared/uploads.mjs";

const CHUNK_LIMIT = 12_000;
const MESSAGE_INDEX_RETENTION_MS = 30 * 86_400_000;
const MESSAGE_INDEX_MAX = 5_000;
const TYPING_REFRESH_MS = 4_000;
const KEEPALIVE_IDLE_MS = 90_000;
const PONG_TIMEOUT_MS = 15_000;
const KEEPALIVE_TICK_MS = 30_000;
const ALERT_COOLDOWN_MS = 30 * 60_000;

export function sessionFor(key) {
  return `mm-${key}`;
}

export function threadRoot(post) {
  if (!post) return null;
  return String(post.root_id || post.id || "");
}

export function threadKey(post) {
  const root = threadRoot(post);
  return root ? `p${root}` : null;
}

export function resolveKey(post, msgKeys = {}) {
  const root = threadRoot(post);
  if (!root) return null;
  const known = msgKeys[root];
  return known?.key ?? `p${root}`;
}

export function wsUrl(serverUrl) {
  return `${String(serverUrl).replace(/\/+$/, "").replace(/^http/, "ws")}/api/v4/websocket`;
}

export function authChallenge(token, seq = 1) {
  return { seq, action: "authentication_challenge", data: { token } };
}

export function typingAction(channelId, postId, seq = 1) {
  const data = { channel_id: channelId };
  if (postId) data.parent_id = postId;
  return { seq, action: "user_typing", data };
}

export function parsePosted(raw) {
  let event = null;
  try {
    event = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (!event || event.event !== "posted") return null;
  let post = event.data?.post;
  if (typeof post === "string") {
    try {
      post = JSON.parse(post);
    } catch {
      return null;
    }
  }
  if (!post || !post.id || !post.channel_id) return null;
  if (post.type) return null;
  if (post.delete_at && Date.parse(post.delete_at) <= Date.now()) return null;
  return post;
}

export function postPayload(channelId, text, rootId = null, fileIds = null) {
  const payload = { channel_id: channelId, message: text };
  if (rootId) payload.root_id = rootId;
  if (fileIds?.length) payload.file_ids = fileIds;
  return payload;
}

export function stripBotMentions(text, username) {
  const value = String(text ?? "");
  if (!username) return value.trim();
  const pattern = new RegExp(`@${String(username).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
  return value.replace(pattern, "").replace(/[ \t]{2,}/g, " ").trim();
}

export function replyIdsFor(post) {
  return [post?.root_id, post?.id].filter(Boolean).map(String);
}

export function keepaliveAction({ now, lastSeen, pendingPingAt, idleMs = KEEPALIVE_IDLE_MS, pongTimeoutMs = PONG_TIMEOUT_MS }) {
  if (pendingPingAt) return now - pendingPingAt > pongTimeoutMs ? "reconnect" : null;
  return now - lastSeen >= idleMs ? "ping" : null;
}

export function alertAllowed(alerts, kind, now, cooldownMs = ALERT_COOLDOWN_MS) {
  const last = Date.parse(alerts?.[kind] ?? "");
  return !Number.isFinite(last) || now - last > cooldownMs;
}

export function createPlatform({ config, log: baseLog }) {
  const env = { ...config.readEnv(config.envFile("mattermost.env")), ...process.env };
  const serverUrl = String(env.MATTERMOST_SERVER_URL ?? "").replace(/\/+$/, "");
  const token = env.MATTERMOST_BOT_TOKEN;
  const channelId = env.MATTERMOST_CHANNEL_ID;
  const allowedUser = env.MATTERMOST_ALLOWED_USER ?? relayEnv("ALLOWED_USER", undefined, env);
  const log = baseLog;

  const typing = { timer: null, cursor: 0, busy: false, keys: new Set(), jobs: new Set() };
  let state = null;
  let coreRef = null;
  let bot = null;
  let socket = null;
  let closed = false;
  let lastSeen = Date.now();
  let pendingPingAt = 0;
  let seq = 0;
  let dispatchMessage = null;
  let announced = false;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function createRest(tok, base) {
    return async function call(path, { method = "GET", body, form = null, raw = false } = {}) {
      const headers = { Authorization: `Bearer ${tok}` };
      if (form) headers["Content-Type"] = "application/json";
      else if (body !== undefined) headers["Content-Type"] = "application/json";
      const res = await fetch(`${base}/api/v4${path}`, {
        method,
        headers,
        body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
      });
      if (raw) {
        if (!res.ok) throw new Error(`${method} ${path} ${res.status}`);
        return res;
      }
      const text = await res.text();
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      if (!res.ok) {
        throw new Error(`${method} ${path} ${res.status} ${parsed?.message ?? text.slice(0, 200)}`);
      }
      return parsed;
    };
  }

  let rest = null;

  function rememberMessage(messageId, key) {
    if (!messageId || !key) return;
    state.meta.msgKeys[String(messageId)] = { key, at: new Date().toISOString() };
    const ids = Object.keys(state.meta.msgKeys);
    if (ids.length > MESSAGE_INDEX_MAX) {
      ids.sort((a, b) => String(state.meta.msgKeys[a]?.at ?? "").localeCompare(String(state.meta.msgKeys[b]?.at ?? "")));
      for (const id of ids.slice(0, ids.length - MESSAGE_INDEX_MAX)) delete state.meta.msgKeys[id];
    }
  }

  async function sendText({ rootId = null, text, files = null }) {
    let fileIds = null;
    if (files?.length) fileIds = await uploadFiles(files);
    const payload = postPayload(channelId, text, rootId, fileIds);
    if (!text && fileIds?.length) payload.message = "";
    return rest("/posts", { method: "POST", body: payload });
  }

  async function uploadFiles(files) {
    const ids = [];
    for (const file of files.slice(0, MAX_ATTACHMENTS)) {
      try {
        const buffer = await Bun.file(file).arrayBuffer();
        if (buffer.byteLength > MAX_BYTES) {
          log("warn", "media", "size", file);
          continue;
        }
        const name = file.split("/").pop() ?? "file";
        const form = new FormData();
        form.append("channel_id", channelId);
        form.append("files", new Blob([buffer]), name);
        const res = await fetch(`${serverUrl}/api/v4/files`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: form,
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`files ${res.status} ${text.slice(0, 160)}`);
        const parsed = JSON.parse(text);
        for (const info of parsed.file_infos ?? []) ids.push(info.id);
      } catch (error) {
        log("warn", "media", String(file), String(error?.message ?? error));
      }
    }
    return ids;
  }

  async function downloadAttachments(post, chat) {
    const all = Array.isArray(post.metadata?.files) ? post.metadata.files : [];
    const picked = all.slice(0, MAX_ATTACHMENTS);
    const dir = uploadDirFor(config.configDir, chat);
    const saved = [];
    const failed = [];
    for (const info of picked) {
      try {
        const res = await rest(`/files/${info.id}`, { raw: true });
        const mime = String(info.mime_type ?? res.headers.get("content-type") ?? "").split(";")[0].trim();
        const name = `${String(info.id ?? Date.now()).slice(-12)}.${extFor(mime, info.name)}`;
        const buffer = Buffer.from(await res.arrayBuffer());
        if (buffer.byteLength > MAX_BYTES) {
          failed.push(info);
          continue;
        }
        ensurePrivateDir(dir);
        const file = join(dir, name);
        writeFileSync(file, buffer, { mode: 0o600 });
        saved.push({ kind: mime.startsWith("image/") ? "image" : "file", path: file, name: info.name ?? null });
      } catch (error) {
        log("error", "attachment", String(info?.id ?? ""), String(error?.message ?? error));
        failed.push(info);
      }
    }
    return { saved, failed, truncated: Math.max(0, all.length - picked.length) };
  }

  function syncTyping() {
    const targets = [...new Set([...typing.keys, ...typing.jobs])];
    if (!targets.length) {
      if (typing.timer) clearInterval(typing.timer);
      typing.timer = null;
      return;
    }
    if (typing.timer) return;
    const tick = async () => {
      if (typing.busy || !socket || socket.readyState !== WebSocket.OPEN) return;
      const keys = [...new Set([...typing.keys, ...typing.jobs])];
      if (!keys.length) return;
      typing.busy = true;
      typing.cursor += 1;
      const key = keys[typing.cursor % keys.length];
      const root = state.meta.roots[key] ?? null;
      try {
        socket.send(JSON.stringify(typingAction(channelId, root, typing.cursor)));
      } catch (error) {
        log("warn", "typing", key, String(error?.message ?? error));
      } finally {
        typing.busy = false;
      }
    };
    tick();
    typing.timer = setInterval(tick, TYPING_REFRESH_MS);
  }

  async function handlePost(post) {
    if (String(post.channel_id) !== String(channelId)) return log("ignore", "channel", post.channel_id);
    if (String(post.user_id) === String(bot?.id)) return log("ignore", "self", post.id);
    if (post.user_id && String(post.user_id) !== String(allowedUser)) return log("ignore", "author", post.user_id);
    const text = stripBotMentions(post.message ?? "", bot?.username);
    if (!text && !post.metadata?.files?.length) return log("ignore", "empty", post.id);
    const key = resolveKey(post, state.meta.msgKeys);
    if (!key) return log("ignore", "no-key", post.id);
    state.meta.roots[key] = threadRoot(post);
    rememberMessage(post.id, key);
    coreRef?.save();
    const chat = String(post.channel_id);
    const attachments = post.metadata?.files?.length ? await downloadAttachments(post, chat) : null;
    const inbound = {
      key,
      session: sessionFor(key),
      dedupeId: String(post.id),
      authorId: String(post.user_id ?? allowedUser),
      text,
      chatId: chat,
      threadId: threadRoot(post),
      rootText: state.convs?.[key]?.rootText ?? text,
      replyTo: String(post.id),
      replyIds: replyIdsFor(post),
      attachments,
    };
    typing.keys.add(key);
    syncTyping();
    try {
      return await dispatchMessage(inbound);
    } finally {
      setTimeout(() => {
        typing.keys.delete(key);
        syncTyping();
      }, 1_000);
    }
  }

  function connect(onReady) {
    return new Promise((resolve) => {
      const url = wsUrl(serverUrl);
      log("info", "ws-open", url);
      const ws = new WebSocket(url);
      socket = ws;
      let authed = false;
      ws.onopen = () => {
        ws.send(JSON.stringify(authChallenge(token)));
      };
      ws.onmessage = (event) => {
        lastSeen = Date.now();
        pendingPingAt = 0;
        const raw = typeof event.data === "string" ? event.data : String(event.data);
        if (!authed && raw.includes('"status":"OK"')) {
          authed = true;
          if (!announced) {
            announced = true;
            onReady?.();
          }
          return;
        }
        const post = parsePosted(raw);
        if (post) handlePost(post).catch((error) => log("error", "handle", String(error?.message ?? error)));
      };
      ws.onerror = (error) => log("warn", "ws-error", String(error?.message ?? error));
      ws.onclose = (event) => {
        log("info", "ws-close", String(event?.code ?? ""));
        resolve();
      };
      const keepalive = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const now = Date.now();
        const action = keepaliveAction({ now, lastSeen, pendingPingAt });
        if (action === "reconnect") {
          log("warn", "ws-dead", "no pong, reconnecting");
          clearInterval(keepalive);
          try {
            ws.close();
          } catch {}
          resolve();
          return;
        }
        if (action !== "ping") return;
        pendingPingAt = now;
        ws.send(JSON.stringify({ seq: ++seq, action: "ping" }));
      }, KEEPALIVE_TICK_MS);
      ws.addEventListener("close", () => clearInterval(keepalive));
    });
  }

  const adapter = {
    name: "mattermost",
    surface: "本线程",
    allowedUser,
    chunkLimit: CHUNK_LIMIT,
    timeoutMs: relayEnv("TIMEOUT_MS", 0),
    maxWorkers: relayEnv("MAX_WORKERS", 5),
    queueDepth: relayEnv("QUEUE_DEPTH", 3),
    worker: relayEnv("WORKER", "pi"),
    workerMode: relayEnv("WORKER_MODE", "print"),
    steer: relayEnv("STEER", "on"),
    piBin: config.workerBin,
    sessionFor,

    async start({ onMessage, onReady, core }) {
      coreRef = core;
      state = core.state;
      if (!serverUrl) {
        log("error", "missing-credential", "MATTERMOST_SERVER_URL");
        process.exit(1);
      }
      if (!token) {
        log("error", "missing-credential", "MATTERMOST_BOT_TOKEN");
        process.exit(1);
      }
      if (!channelId || !allowedUser) {
        log("error", "missing-credential", !channelId ? "MATTERMOST_CHANNEL_ID" : "MATTERMOST_ALLOWED_USER");
        process.exit(1);
      }
      rest = createRest(token, serverUrl);
      state.meta = state.meta ?? {};
      state.meta.msgKeys = state.meta.msgKeys ?? {};
      state.meta.roots = state.meta.roots ?? {};
      dispatchMessage = onMessage;
      bot = await rest("/users/me");
      log("info", "bot", bot?.username ?? bot?.id);

      let backoff = 1_000;
      while (!closed) {
        await connect(onReady);
        if (closed) break;
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 60_000);
        if (alertAllowed(state.alerts, "ws", Date.now())) {
          state.alerts.ws = new Date().toISOString();
          core.save();
        }
      }
    },

    async onProgress(ctx) {
      typing.jobs.add(String(ctx.key ?? "").replace(/^/, ""));
      syncTyping();
    },

    async onProgressDone(ctx) {
      typing.jobs.delete(String(ctx.key ?? ""));
      syncTyping();
    },

    async reply(ctx, text) {
      rest = rest ?? createRest(token, serverUrl);
      const root = ctx.threadId ?? state.meta.roots[ctx.key] ?? ctx.replyTo ?? null;
      let last = null;
      for (const chunk of chunkText(text, CHUNK_LIMIT)) {
        const sent = await sendText({ rootId: root, text: chunk });
        if (sent?.id) {
          last = sent.id;
          rememberMessage(sent.id, ctx.key);
        }
      }
      coreRef?.save();
      return last ? { messageId: String(last) } : null;
    },

    async edit(ctx, messageId, text) {
      rest = rest ?? createRest(token, serverUrl);
      await rest(`/posts/${messageId}`, { method: "PUT", body: { id: messageId, message: text } });
      return true;
    },

    async postMedia(ctx, files) {
      rest = rest ?? createRest(token, serverUrl);
      const root = ctx.threadId ?? state.meta.roots[ctx.key] ?? ctx.replyTo ?? null;
      const sent = await sendText({ rootId: root, text: "", files });
      if (sent?.id) rememberMessage(sent.id, ctx.key);
      coreRef?.save();
      return sent?.id ? { messageId: String(sent.id) } : null;
    },

    async postNotice(text) {
      rest = rest ?? createRest(token, serverUrl);
      let last = null;
      for (const chunk of chunkText(text, CHUNK_LIMIT)) {
        const sent = await sendText({ rootId: null, text: chunk });
        if (sent?.id) last = sent.id;
      }
      return { messageId: last ? String(last) : null };
    },

    prune: () => {
      if (!state) return { convs: 0, topics: 0, uploads: 0 };
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
      for (const [key, root] of Object.entries(state.meta?.roots ?? {})) {
        if (!state.meta.msgKeys[root]) delete state.meta.roots[key];
      }
      const uploads = pruneUploads(config.uploadsDir) ?? 0;
      if (dropped || topics) coreRef?.save();
      return { convs: dropped, topics, uploads };
    },
  };

  return adapter;
}
