#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chunkText } from "../shared/chunk.mjs";
import { relayEnv } from "../shared/env.mjs";
import { createRootCache } from "./shared/root-cache.mjs";

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

export const replyRules = "- 你的 stdout 会以 app `Intake Notifier` 的身份发回本 thread（不是你本人账号）。\n- 用 Slack mrkdwn：不要用 `#` 标题、不要用 Markdown 表格；粗体 `*x*`、代码块、短列表可用。";

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
  if (!stripMentions(event.text)) return { ok: false, why: "empty-text" };
  return { ok: true, thread: event.thread_ts ?? event.ts };
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

  const adapter = {
    name: "slack",
    surface: "本 thread",
    allowedUser,
    chunkLimit: CHUNK_LIMIT,
    timeoutMs: relayEnv("TIMEOUT_MS", 20 * 60_000),
    maxWorkers: relayEnv("MAX_WORKERS", 2),
    queueDepth: relayEnv("QUEUE_DEPTH", 3),
    worker: relayEnv("WORKER", "pi"),
    piBin: join(config.home, ".bun/bin/pi"),
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
        const text = event.files?.length ? `${stripped}\n[附件]`.trim() : stripped;
        const rootText = await rootTextFor(thread);
        await onMessage({
          key: thread,
          session: sessionFor(thread),
          dedupeId: event.ts,
          messageId: event.ts,
          authorId: event.user,
          text,
          chatId: channel,
          rootText: rootText ?? text,
          replyTo: thread,
          replyIds: [thread, event.thread_ts].filter(Boolean),
        });
      };

      log("info", "start", `channel=${channel}`, `allowed=${allowedUser}`, `state=${config.stateFile("slack")}`);
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

    async edit(ctx, messageId, text) {
      return runtime.edit(ctx, messageId, text);
    },

    async onProgress(ctx) {
      return runtime.onProgress(ctx);
    },

    async onProgressDone(ctx) {
      return runtime.onProgressDone(ctx);
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
