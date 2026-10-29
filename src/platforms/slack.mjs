#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chunkText } from "../shared/chunk.mjs";
import { relayEnv } from "../shared/env.mjs";
import { ensurePrivateDir } from "../shared/fs.mjs";
import { createRootCache } from "./shared/root-cache.mjs";
import { MAX_ATTACHMENTS, MAX_BYTES, extFor, uploadDirFor, pruneUploads } from "./shared/uploads.mjs";

const PING_MS = relayEnv("PING_MS", 10_000);
const SERVER_PING_TIMEOUT_MS = relayEnv("SERVER_PING_TIMEOUT_MS", 30_000);
const PONG_TIMEOUT_MS = relayEnv("PONG_TIMEOUT_MS", 10_000);
const MIN_REFRESH_MS = 60_000;
const HELLO_TIMEOUT_MS = 15_000;
const HEARTBEAT_LOG_EVERY = 3;
const ALERT_COOLDOWN_MS = relayEnv("ALERT_COOLDOWN_MS", 30 * 60_000);
const PASSING_SUBTYPES = ["thread_broadcast", "file_share"];
const CHUNK_LIMIT = 3500;
const THREAD_RETENTION_MS = 30 * 86_400_000;
const DOWNLOAD_TIMEOUT_MS = 15_000;
export const FILES_ALERT = "relay: Slack 附件下载失败，检查 WALL-E 是否有 files:read 且已 Reinstall";

export const PROGRESS_EMOJI = "thinking_face";
const PLACEHOLDER_TEXT = "⏳ 正在处理…";
const PERMISSION_ERRORS = new Set(["missing_scope", "not_allowed_token_type", "invalid_auth", "not_authed", "account_inactive", "token_revoked"]);
const ALREADY_PROGRESSED = new Set(["already_reacted"]);
const ALREADY_CLEANED = new Set(["no_reaction", "message_not_found"]);

export function decideProgressMode(error) {
  if (!error || ALREADY_PROGRESSED.has(error)) return "reaction";
  if (PERMISSION_ERRORS.has(error)) return "placeholder";
  return "none";
}

export const MEDIA_ALERT = "relay: Slack 图片回帖没发出去，检查 app 是否有 files:write 且已 Reinstall";

function slackFailure(message, slackError) {
  return Object.assign(new Error(message), { slackError });
}

export function createMediaUploader({ api, channel, token, log = () => {}, reply, fetchFn = (...args) => fetch(...args), alertOnce = () => {} }) {
  async function ticketFor(file, bytes) {
    const res = await fetchFn("https://slack.com/api/files.getUploadURLExternal", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ filename: file.name, length: String(bytes.byteLength) }),
    });
    const parsed = await res.json().catch(() => ({ ok: false, error: "unreadable-body" }));
    if (!parsed.ok) throw slackFailure(`getUploadURLExternal ${parsed.error ?? "unknown"}`, parsed.error);
    return parsed;
  }

  async function uploadFile(file) {
    const bytes = readFileSync(file.path);
    const ticket = await ticketFor(file, bytes);
    const put = await fetchFn(ticket.upload_url, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: bytes });
    if (!put?.ok) throw new Error(`upload ${put?.status ?? "failed"}`);
    return ticket.file_id;
  }

  async function complete(thread, ids) {
    const body = new URLSearchParams({ files: JSON.stringify(ids.map((id) => ({ id }))), channel_id: channel });
    if (thread) body.set("thread_ts", thread);
    const res = await fetchFn("https://slack.com/api/files.completeUploadExternal", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const parsed = await res.json().catch(() => ({ ok: false, error: "unreadable-body" }));
    if (!parsed.ok) throw slackFailure(`completeUploadExternal ${parsed.error ?? "unknown"}`, parsed.error);
    return parsed;
  }

  async function degrade(ctx, files, reason) {
    alertOnce("media", MEDIA_ALERT);
    await reply(ctx, `（${files.length} 张图片未能上传：${reason}）`);
    return { messageId: null, degraded: true };
  }

  return async function postMedia(ctx, files) {
    if (!api) return degrade(ctx, files, "缺少 bot token");
    try {
      const ids = [];
      for (const file of files) ids.push(await uploadFile(file));
      await complete(ctx?.replyTo ?? null, ids);
      return { messageId: null, degraded: false };
    } catch (error) {
      if (!PERMISSION_ERRORS.has(error?.slackError)) throw error;
      log("warn", "postMedia", String(error?.slackError ?? error));
      return degrade(ctx, files, "Slack 授权缺少 files:write");
    }
  };
}

export function createRuntime({ api, log, channel, post, emoji = PROGRESS_EMOJI }) {
  async function postMessage(ctx, text) {
    const res = await api("chat.postMessage", { channel, text, ...(ctx.replyTo ? { thread_ts: ctx.replyTo } : {}) });
    if (!res.ok) throw new Error(`postMessage ${res.error}`);
    return { messageId: res.ts };
  }

  return {
    async reply(ctx, text) {
      if (!api) {
        await post(ctx.replyTo ?? null, text);
        return null;
      }
      const entry = ctx.progress;
      if (entry?.mode === "placeholder" && entry.messageId && entry.pending) {
        const patched = await api("chat.update", { channel, ts: entry.messageId, text });
        if (patched.ok) {
          entry.pending = false;
          return { messageId: entry.messageId, patched: true };
        }
        log("warn", "placeholder-update", patched.error);
      }
      try {
        return await postMessage(ctx, text);
      } catch (error) {
        log("warn", "postMessage", String(error?.message ?? error));
        if (!post) throw error;
        await post(ctx.replyTo ?? null, text);
        return null;
      }
    },

    async edit(ctx, messageId, text) {
      if (!api || !messageId) return false;
      const res = await api("chat.update", { channel, ts: messageId, text });
      if (res.ok) return true;
      log("warn", "edit", res.error);
      return false;
    },

    async onProgress(ctx) {
      if (!api || !ctx.messageId) return null;
      const res = await api("reactions.add", { channel, timestamp: ctx.messageId, name: emoji });
      const mode = decideProgressMode(res.ok ? null : res.error);
      if (mode === "reaction") return { mode: "reaction", messageId: ctx.messageId, name: emoji };
      if (mode === "placeholder") {
        const sent = await api("chat.postMessage", { channel, text: PLACEHOLDER_TEXT, ...(ctx.replyTo ? { thread_ts: ctx.replyTo } : {}) }).catch((error) => {
          log("warn", "placeholder", String(error?.message ?? error));
          return { ok: false };
        });
        if (sent.ok) return { mode: "placeholder", messageId: sent.ts, pending: true };
      }
      log("warn", "progress-unavailable", res.error ?? "unknown");
      return null;
    },

    async onProgressDone(ctx) {
      const entry = ctx.progress;
      if (!api || !entry) return;
      if (entry.mode === "reaction") {
        const res = await api("reactions.remove", { channel, timestamp: entry.messageId ?? ctx.messageId, name: entry.name ?? emoji });
        if (!res.ok && !ALREADY_CLEANED.has(res.error)) log("warn", "progress-remove", res.error);
        return;
      }
      if (entry.mode === "placeholder" && entry.messageId && entry.pending) {
        const res = await api("chat.delete", { channel, ts: entry.messageId });
        if (!res.ok && !ALREADY_CLEANED.has(res.error)) log("warn", "progress-delete", res.error);
      }
    },
  };
}

export const replyRules = "- 你的 stdout 会以 app `Intake Notifier` 的身份发回本 thread（不是你本人账号）。\n- 用 Slack mrkdwn：标题和粗体都写 `*x*`（别写 `##`、别写 `**x**`）、列表用 `• `（别写 `- `）、别用表格；行内代码与 ``` 围栏照常。\n- 要给用户看图时，在 stdout 里单独一行写 `![](/绝对路径.png)`（png/jpg/gif/webp，≤20MB，最多 4 张）；relay 会把图作为附件发在同一条 thread。";

export function stripMentions(text) {
  return String(text ?? "").replace(/\s*<@[A-Z0-9]+>/g, "").trim();
}

export function sessionFor(thread) {
  return `slack-${String(thread).replace(".", "")}`;
}

export function acceptsEvent(event, { channel = null, allowedUser = null, botUser = null } = {}) {
  if (!event) return { ok: false, why: "empty" };
  if (!channel || !allowedUser) return { ok: false, why: "unconfigured" };
  if (event.channel !== channel) return { ok: false, why: "channel" };
  if (event.bot_id || event.user === botUser) return { ok: false, why: "bot" };
  if (event.user !== allowedUser) return { ok: false, why: "author" };
  if (event.subtype && !PASSING_SUBTYPES.includes(event.subtype)) return { ok: false, why: "subtype" };
  if (!stripMentions(event.text) && !event.files?.length) return { ok: false, why: "empty-text" };
  return { ok: true, thread: event.thread_ts ?? event.ts };
}

export function fileOf(file) {
  return {
    key: String(file?.id ?? ""),
    url: file?.url_private_download ?? file?.url_private ?? null,
    name: file?.name ?? null,
    mime: String(file?.mimetype ?? "").split(";")[0].trim(),
    size: Number(file?.size ?? 0),
  };
}

export function composeText(stripped, parsed, limit = MAX_ATTACHMENTS) {
  const notes = [];
  if (!stripped) notes.push(`（发了 ${parsed.saved.length} 个附件，未附文字）`);
  if (parsed.failed.length) notes.push(`（${parsed.failed.length} 个附件下载失败，未能查看）`);
  if (parsed.truncated) notes.push(`（还有 ${parsed.truncated} 个附件未处理，单条消息最多 ${limit} 个）`);
  return [stripped, ...notes].filter(Boolean).join("\n");
}

export function shouldAlertFiles(parsed) {
  return parsed.failed.length > 0 && parsed.saved.length === 0;
}

export function createAttachmentDownloader({ config, log, channel, token, api, fetchFn = (...args) => fetch(...args) }) {
  async function resolveFile(file) {
    const base = fileOf(file);
    if (base.url) return base;
    const res = await api("files.info", { file: base.key });
    if (!res?.ok) throw new Error(`files.info ${res?.error ?? "unknown"}`);
    return fileOf(res.file);
  }

  async function fetchBytes(url) {
    const res = await fetchFn(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    const type = String(res.headers.get("content-type") ?? "").split(";")[0].trim();
    if (!res.ok) throw new Error(`download ${res.status}`);
    if (type === "text/html") throw new Error("download html: bot 缺少 files:read");
    return { bytes: Buffer.from(await res.arrayBuffer()), type };
  }

  return async function downloadAttachments(files) {
    const all = Array.isArray(files) ? files.slice() : [];
    const picked = all.slice(0, MAX_ATTACHMENTS);
    const dir = uploadDirFor(config.configDir, channel);
    const saved = [];
    const failed = [];
    for (const file of picked) {
      try {
        const item = await resolveFile(file);
        if (item.size && item.size > MAX_BYTES) throw new Error(`too-large ${item.size}`);
        const { bytes, type } = await fetchBytes(item.url);
        const mime = item.mime || type;
        const target = join(dir, `${item.key.slice(0, 12)}.${extFor(mime, item.name)}`);
        ensurePrivateDir(dir);
        writeFileSync(target, bytes, { mode: 0o600 });
        saved.push({ kind: mime.startsWith("image/") ? "image" : "file", path: target, name: item.name });
      } catch (error) {
        log("error", "attachment", String(file?.id ?? ""), String(error?.message ?? error));
        failed.push(file);
      }
    }
    return { saved, failed, truncated: Math.max(0, all.length - picked.length) };
  };
}

export function heartbeatVerdict(state, now, cfg = {}) {
  const serverPingTimeoutMs = cfg.serverPingTimeoutMs ?? SERVER_PING_TIMEOUT_MS;
  const pongTimeoutMs = cfg.pongTimeoutMs ?? PONG_TIMEOUT_MS;
  if (now - state.lastServerPingAt > serverPingTimeoutMs) return "no-server-ping";
  if (state.lastPongAt && now - state.lastPongAt > pongTimeoutMs) return "no-pong";
  return null;
}

export function refreshDelayMs(lifetimeMs, overrideMs = 0) {
  return overrideMs || Math.max(Math.round(lifetimeMs * 0.8), MIN_REFRESH_MS);
}

export function alertAllowed(alerts, kind, now, cooldownMs = ALERT_COOLDOWN_MS) {
  const last = Date.parse(alerts?.[kind] ?? "");
  return !Number.isFinite(last) || now - last > cooldownMs;
}

export function pruneThreads(threads, now = Date.now(), retentionMs = THREAD_RETENTION_MS) {
  const kept = {};
  for (const [key, value] of Object.entries(threads ?? {})) {
    const seen = Date.parse(value?.lastMsgTs ?? "");
    if (Number.isFinite(seen) && now - seen > retentionMs) continue;
    kept[key] = value;
  }
  return kept;
}

export function createPlatform({ config, log: baseLog }) {
  const env = { ...config.readEnv(config.envFile("slack-app.env")), ...process.env };
  const appToken = env.SLACK_APP_TOKEN;
  const channel = relayEnv("SLACK_CHANNEL", null, env);
  const allowedUser = env.SLACKD_ALLOWED_USER ?? relayEnv("ALLOWED_USER", null, env);
  const botUser = env.SLACKD_BOT_USER ?? null;
  const botToken = env.SLACK_BOT_TOKEN;
  const progressEmoji = env.SLACK_PROGRESS_EMOJI ?? PROGRESS_EMOJI;
  const log = baseLog;
  const typing = { timer: null, cursor: 0, busy: false, keys: new Set() };
  let state = null;
  let coreRef = null;
  let webhookUrl = null;
  let cookies = null;

  function readCookies() {
    const lines = readFileSync(config.envFile(".slack-xoxc.tmp"), "utf8").split("\n").map((line) => line.trim()).filter(Boolean);
    if (lines.length < 2) throw new Error(".slack-xoxc.tmp needs two lines");
    return { xoxc: lines[0], xoxd: lines[1] };
  }

  async function post(thread, text) {
    if (!webhookUrl) throw new Error("webhook.url missing");
    const body = JSON.stringify(thread ? { text, thread_ts: thread } : { text });
    const res = await fetch(webhookUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    if (!res.ok) throw new Error(`webhook ${res.status} ${(await res.text()).slice(0, 200)}`);
  }

  function apiFor(token) {
    return async (method, params) => {
      const res = await fetch(`https://slack.com/api/${method}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(params),
      });
      const body = await res.json().catch(() => null);
      return body ?? { ok: false, error: "unreadable-body" };
    };
  }

  async function fetchRoot(thread) {
    if (!cookies) throw new Error("no cookies");
    const url = new URL("https://slack.com/api/conversations.replies");
    url.searchParams.set("channel", channel);
    url.searchParams.set("ts", thread);
    url.searchParams.set("limit", "1");
    const res = await fetch(url, { headers: { Authorization: `Bearer ${cookies.xoxc}`, Cookie: `d=${cookies.xoxd}` } });
    const body = await res.json();
    if (!body.ok) throw new Error(`replies ${body.error}`);
    return body.messages?.[0]?.text ?? "";
  }

  const rootCache = createRootCache({
    getState: () => state,
    save: () => coreRef?.save(),
    log,
    sessionFor,
    fetchRootText: (thread) => fetchRoot(thread),
  });

  async function rootTextFor(thread) {
    return rootCache.textFor(thread, thread);
  }

  function alertOnce(kind, text) {
    const now = Date.now();
    if (!alertAllowed(state.alerts, kind, now)) return log("info", "alert-suppressed", kind);
    state.alerts[kind] = new Date(now).toISOString();
    coreRef?.save();
    log("warn", "alert", kind);
    post(null, text).catch((error) => log("error", "alert", String(error)));
  }

  async function openSocket() {
    const res = await fetch("https://slack.com/api/apps.connections.open", {
      method: "POST",
      headers: { Authorization: `Bearer ${appToken}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "",
    });
    const body = await res.json();
    if (!body.ok) throw new Error(`connections.open ${body.error}`);
    return body.url;
  }

  function newConnection(url, onEvent) {
    const ws = new WebSocket(url);
    const conn = {
      hello: null,
      why: null,
      closed: false,
      lastServerPingAt: Date.now(),
      lastPongAt: null,
      pingSentAt: null,
      lastRttMs: null,
      lifetimeMs: 0,
      onHello: null,
      waitClosed: null,
    };
    conn.waitClosed = new Promise((resolve) => (conn.settle = (why) => (conn.why = conn.why ?? why, resolve(conn.why ?? why))));

    const stale = (reason) => {
      if (conn.why) return;
      conn.why = `stale:${reason}`;
      log("warn", "ping-timeout", reason);
      try {
        ws.terminate();
      } catch {
        try {
          ws.close();
        } catch {}
      }
    };

    conn.shutdown = (why) => {
      conn.why = conn.why ?? why;
      clearInterval(conn.beatTimer);
      clearTimeout(conn.refreshTimer);
      try {
        ws.close();
      } catch {}
      setTimeout(() => {
        if (conn.closed) return;
        log("warn", "close-timeout", why);
        try {
          ws.terminate();
        } catch {}
      }, 5_000).unref();
    };

    let beats = 0;
    conn.beatTimer = setInterval(() => {
      const now = Date.now();
      const verdict = heartbeatVerdict(conn, now);
      if (verdict) return stale(verdict);
      beats += 1;
      if (beats % HEARTBEAT_LOG_EVERY === 0) log("heartbeat", `rtt=${conn.lastRttMs ?? "-"}ms`, `server-ping-age=${now - conn.lastServerPingAt}ms`);
      try {
        conn.pingSentAt = now;
        ws.ping();
      } catch (error) {
        log("warn", "ping", String(error));
        stale("ping-failed");
      }
    }, PING_MS);

    ws.addEventListener("open", () => (conn.lastServerPingAt = Date.now()));
    ws.addEventListener("ping", () => (conn.lastServerPingAt = Date.now()));
    ws.addEventListener("pong", () => {
      conn.lastPongAt = Date.now();
      if (conn.pingSentAt) conn.lastRttMs = conn.lastPongAt - conn.pingSentAt;
    });

    ws.addEventListener("message", (frame) => {
      let envelope;
      try {
        envelope = JSON.parse(frame.data);
      } catch (error) {
        return log("warn", "frame", String(error));
      }
      if (envelope.envelope_id) ws.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
      if (envelope.type === "hello") {
        conn.hello = envelope;
        conn.lastServerPingAt = Date.now();
        conn.lifetimeMs = Number(envelope.debug_info?.approximate_connection_time ?? 0) * 1_000;
        const refreshIn = refreshDelayMs(conn.lifetimeMs, relayEnv("REFRESH_MS", 0));
        log("info", "hello", `${envelope.num_connections ?? 1} conn`, `lifetime=${Math.round(conn.lifetimeMs / 1_000)}s`, `refresh=${Math.round(refreshIn / 1_000)}s`);
        conn.refreshTimer = setTimeout(() => conn.shutdown("refresh"), refreshIn);
        conn.onHello?.();
        return;
      }
      if (envelope.type === "disconnect") {
        const reason = envelope.reason ?? "";
        conn.why = `disconnect:${reason}`;
        log("warn", "disconnect", reason);
        if (reason === "link_disabled") alertOnce("link_disabled", "relay: Slack 侧已关闭 Socket Mode（link_disabled），事件暂时收不到，需要人工重新开启");
        try {
          ws.close();
        } catch {}
        return;
      }
      if (envelope.type !== "events_api") return log("ignore", "envelope", envelope.type ?? "");
      onEvent(envelope.payload?.event);
    });

    ws.addEventListener("error", (event) => log("warn", "ws-error", String(event?.message ?? event)));
    ws.addEventListener("close", () => {
      conn.closed = true;
      clearInterval(conn.beatTimer);
      clearTimeout(conn.refreshTimer);
      conn.settle(conn.why ?? "closed");
    });

    return conn;
  }

  function connect(url, onEvent) {
    const conn = newConnection(url, onEvent);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.shutdown("hello-timeout");
        reject(new Error("hello timeout"));
      }, HELLO_TIMEOUT_MS);
      conn.onHello = () => {
        clearTimeout(timer);
        resolve(conn);
      };
      conn.waitClosed.then((why) => {
        clearTimeout(timer);
        reject(new Error(`closed before hello: ${why}`));
      });
    });
  }

  const runtime = createRuntime({
    api: botToken ? apiFor(botToken) : null,
    log,
    channel,
    post,
    emoji: progressEmoji,
  });

  const postMedia = createMediaUploader({
    api: botToken ? apiFor(botToken) : null,
    channel,
    token: botToken,
    log,
    reply: (ctx, text) => runtime.reply(ctx, text),
    alertOnce,
  });

  const downloadAttachments = createAttachmentDownloader({
    config,
    log,
    channel,
    token: botToken,
    api: botToken ? apiFor(botToken) : null,
  });

  const adapter = {
    name: "slack",
    surface: "本 thread",
    allowedUser,
    chunkLimit: CHUNK_LIMIT,
    timeoutMs: relayEnv("TIMEOUT_MS", 2 * 60 * 60_000),
    maxWorkers: relayEnv("MAX_WORKERS", 5),
    queueDepth: relayEnv("QUEUE_DEPTH", 3),
    worker: relayEnv("WORKER", "pi"),
    piBin: config.workerBin,
    replyRules,
    sessionFor,

    async start({ onMessage, onReady, core }) {
      coreRef = core;
      state = core.state;
      if (!appToken) {
        log("error", "missing-credential", config.envFile("slack-app.env"), "SLACK_APP_TOKEN");
        process.exit(1);
      }
      if (!channel || !allowedUser) {
        log("error", "missing-credential", config.envFile("slack-app.env"), !channel ? "AGENT_RELAY_SLACK_CHANNEL" : "AGENT_RELAY_ALLOWED_USER");
        process.exit(1);
      }
      try {
        cookies = readCookies();
      } catch (error) {
        log("error", "missing-credential", config.envFile(".slack-xoxc.tmp"), String(error));
      }
      try {
        webhookUrl = readFileSync(config.envFile("webhook.url"), "utf8").trim();
      } catch (error) {
        log("error", "missing-credential", config.envFile("webhook.url"), String(error));
      }

      const handle = async (event) => {
        const verdict = acceptsEvent(event, { channel, allowedUser, botUser });
        if (!verdict.ok) return log("ignore", verdict.why, event?.ts ?? "");
        const thread = verdict.thread;
        const stripped = stripMentions(event.text ?? "");
        const parsed = event.files?.length ? await downloadAttachments(event.files) : { saved: [], failed: [], truncated: 0 };
        const text = composeText(stripped, parsed);
        if (shouldAlertFiles(parsed)) alertOnce("files", FILES_ALERT);
        const rootText = await rootTextFor(thread);
        await onMessage({
          key: thread,
          session: sessionFor(thread),
          dedupeId: event.ts,
          messageId: event.ts,
          authorId: event.user,
          text,
          chatId: channel,
          rootText: rootText || text,
          replyTo: thread,
          replyIds: [thread, event.thread_ts].filter(Boolean),
          attachments: parsed.saved,
        });
      };

      log("info", "start", `channel=${channel}`, `allowed=${allowedUser}`, `state=${config.stateFile("slack")}`);
      try {
        pruneUploads(config.uploadsDir);
      } catch (error) {
        log("warn", "prune", String(error?.message ?? error));
      }
      setInterval(() => {
        const pruned = pruneThreads(state.convs);
        const dropped = Object.keys(state.convs).length - Object.keys(pruned).length;
        if (dropped > 0) {
          state.convs = pruned;
          core.save();
          log("info", "convs-pruned", `dropped=${dropped}`);
        }
      }, 86_400_000).unref();

      let backoff = 1_000;
      let conn = null;
      let authAlerts = 0;
      let readyAnnounced = false;
      for (;;) {
        if (!conn) {
          try {
            conn = await connect(await openSocket(), (event) => {
              handle(event).catch((error) => log("error", "handle", String(error)));
            });
            if (!readyAnnounced) {
              readyAnnounced = true;
              onReady?.();
            }
          } catch (error) {
            log("error", "connect", String(error));
            const authFailure = String(error).includes("invalid_auth") || String(error).includes("not_authed");
            authAlerts = authFailure ? authAlerts + 1 : 0;
            if (authFailure && authAlerts >= 3) alertOnce("auth", `relay: 收不到 Slack 事件，app token 鉴权失败（${error}）`);
            await new Promise((resolve) => setTimeout(resolve, backoff));
            backoff = Math.min(backoff * 2, 60_000);
            continue;
          }
          backoff = 1_000;
          authAlerts = 0;
        }

        const why = await conn.waitClosed;
        log("warn", "connection-lost", why);
        if (why.startsWith("stale:")) alertOnce("stale", `relay: 与 Slack 的连接已失效（${why.slice(6)}），正在自动重连`);

        if (why === "refresh") {
          try {
            const next = await connect(await openSocket(), (event) => {
              handle(event).catch((error) => log("error", "handle", String(error)));
            });
            const old = conn;
            conn = next;
            old.shutdown("rotated");
            log("info", "rotated", "refresh");
          } catch (error) {
            log("error", "rotate", String(error));
            conn.shutdown("rotate-failed");
            conn = null;
            await new Promise((resolve) => setTimeout(resolve, 1_000));
          }
          continue;
        }

        conn = null;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    },

    async reply(ctx, text) {
      return runtime.reply(ctx, text);
    },

    postMedia,

    async edit(ctx, messageId, text) {
      return runtime.edit(ctx, messageId, text);
    },

    async onProgress(ctx) {
      return runtime.onProgress(ctx);
    },

    async onProgressDone(ctx) {
      return runtime.onProgressDone(ctx);
    },

    prune() {
      return pruneUploads(config.uploadsDir);
    },

    async postNotice(text) {
      const api = botToken ? apiFor(botToken) : null;
      if (!api) {
        await post(null, text);
        return { messageId: null };
      }
      let last = null;
      for (const part of chunkText(text, CHUNK_LIMIT)) {
        const res = await api("chat.postMessage", { channel, text: part });
        if (!res.ok) throw new Error(`postNotice ${res.error}`);
        last = res.ts ?? last;
      }
      return { messageId: last };
    },
  };

  return adapter;
}
