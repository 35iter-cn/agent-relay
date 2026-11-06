import { readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { spawn as spawnProcess } from "node:child_process";
import { join } from "node:path";
import { appendDailyJsonl, createLog } from "../shared/log.mjs";
import { relayEnv } from "../shared/env.mjs";
import { isoAt, localStamp } from "../shared/time.mjs";
import { pruneOldFiles } from "../shared/retention.mjs";
import { ensurePrivateDir } from "../shared/fs.mjs";
import { pruneState } from "../state/prune.mjs";
import { bootNoticeText, readBootId, shouldAnnounceBoot } from "../shared/boot.mjs";
import { createJob, ctxOf, isFinished } from "../jobs/model.mjs";
import { readProcStartTicks } from "../jobs/lease.mjs";
import { hashOf, planParts } from "../jobs/delivery.mjs";
import { extractMedia } from "../jobs/media.mjs";
import { declaredTimeoutMs, readSessionSignal, TOOL_GRACE_MS } from "../jobs/signals.mjs";
import { nextAction } from "../jobs/next-action.mjs";
import { createStateStore } from "../state/store.mjs";
import { createNoticeService } from "../notices/service.mjs";
import { RESTART_PROMPT, stallNoticePrompt, stallNoticeText } from "./stall-notice.mjs";
import { createPrompts } from "./prompts.mjs";
import { activeLoopCount, createLoop, isLoopId, nextLoopId, platformOfLoopId, validateLoopChange, validatePrompt, validateSchedule } from "../loops/model.mjs";
import { LOOP_ROUNDS_PER_HOUR, LOOP_TIMEOUT_MS, loopLateMs, roundSkipReason, roundsInLastHour } from "../loops/schedule.mjs";
import { matchRound, pruneRounds, roundKeyFor, roundTitle, truncateOutput } from "../loops/round.mjs";
import { appendRound, findRound, listRounds, pruneHistory } from "../loops/history.mjs";

const STALL_MS = relayEnv("STALL_MS", 10 * 60_000);
const TOOL_STALL_MS = relayEnv("TOOL_STALL_MS", 10 * 60_000);
const STALL_CHECK_MS = relayEnv("STALL_CHECK_MS", 60_000);
const RETENTION_MS = 72 * 3_600_000;
const SEEN_RETENTION_MS = 72 * 3_600_000;
const MAX_SEEN = 5000;
const COMMAND_TTL_MS = 10 * 60_000;
const INTERRUPT_NOTICE = "⏸ 这一轮被 relay 重启打断：还在跑的进程已终止，会话与已完成的改动都保留，被打断那轮没发出来的输出不补发。直接回复这条消息就会接着之前的会话继续。";
const ACTION_KINDS = { cancel: true, restart: true };
const STATUS_TEXT = { done: "完成", failed: "失败", cancelled: "取消", interrupted: "被打断", queued: "排队", scheduled: "排定中" };
const BRIEF_MAX_BYTES = 8 * 1024;
const DEFAULT_GRACE_MS = 6 * 3_600_000;
const RUNAWAY_PER_HOUR = relayEnv("RUNAWAY_PER_HOUR", 12);
const SELF_TIMEOUT_MS = 15 * 60_000;
const REAP_POLL_MS = 50;
const MAX_DELIVERY_ATTEMPTS = 3;
const DELIVERY_RETRY_MS = 1_500;

export function createCore({ adapter, config, deps = {} }) {
  const now = deps.now ?? (() => Date.now());
  const spawn = deps.spawn ?? spawnProcess;
  const readStartTicks = deps.readStartTicks ?? readProcStartTicks;
  const readBootIdImpl = deps.readBootId ?? readBootId;
  const kill = deps.kill ?? ((target, signal) => process.kill(target, signal));
  const probeAlive = deps.probeAlive ?? ((pid) => {
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error?.code === "EPERM";
    }
  });
  const log = deps.log ?? createLog();
  const stallGraceMs = deps.stallGraceMs ?? 5_000;
  const deliveryRetryMs = deps.deliveryRetryMs ?? DELIVERY_RETRY_MS;
  const store = deps.store ?? createStateStore({ file: config.stateFile(adapter.name), log });
  const loopHistoryDir = config.loopHistoryDir ?? join(config.configDir, "loops");
  const state = store.state;
  const save = store.save;
  const notices = deps.notices ?? createNoticeService({ state, save, adapter, now, log });
  const prompts = deps.prompts ?? createPrompts({ dir: config.promptsDir, userDir: config.userPromptsDir, log, cli: config.cli, configDir: config.configDir });
  const children = new Map();
  const notes = new Map();
  const runtimeInbounds = new Map();
  const running = new Set();
  const logDir = join(config.logDir, adapter.name);
  const commandDir = config.commandDir(adapter.name);
  ensurePrivateDir(logDir);
  ensurePrivateDir(commandDir);

  const isoNow = () => isoAt(now());

  function appendLog(record) {
    appendDailyJsonl(logDir, record, { now });
  }

  function hasSession(session) {
    try {
      return readdirSync(config.sessionsDir).some((file) => file.endsWith(`_${session}.jsonl`));
    } catch {
      return false;
    }
  }

  function sessionFileFor(session) {
    try {
      const name = readdirSync(config.sessionsDir).find((file) => file.endsWith(`_${session}.jsonl`));
      return name ? join(config.sessionsDir, name) : null;
    } catch {
      return null;
    }
  }

  function fallbackActivityAt(job, session) {
    const file = sessionFileFor(session);
    if (file) {
      try {
        return statSync(file).mtimeMs;
      } catch {}
    }
    return job.lease?.startedAt ?? Date.parse(job.createdAt);
  }

  function progress(job, session) {
    const signal = readSessionSignal(sessionFileFor(session));
    if (signal.ok) {
      if (signal.open && Number.isFinite(signal.open.startedAt)) return { kind: "tool", at: signal.open.startedAt, tool: signal.open };
      if (Number.isFinite(signal.lastEntryAt)) return { kind: "entry", at: signal.lastEntryAt, tool: null };
    }
    return { kind: "fallback", at: fallbackActivityAt(job, session), tool: null };
  }

  async function checkStall(job) {
    if (job.status !== "running" || job.stallNotifiedAt) return null;
    const { kind, at, tool } = progress(job, job.session);
    const silenceMs = now() - at;
    if (!Number.isFinite(silenceMs)) return null;
    const declared = declaredTimeoutMs(tool);
    if (declared !== null && silenceMs < declared + TOOL_GRACE_MS) return null;
    if (silenceMs < (kind === "tool" ? TOOL_STALL_MS : STALL_MS)) return null;
    job.stallNotifiedAt = isoNow();
    job.stallSilenceMs = silenceMs;
    job.stallReason = kind === "tool" ? "tool" : kind === "entry" ? "silent" : "fallback";
    job.stallTool = tool?.name ?? null;
    job.stallRunningMs = kind === "tool" ? silenceMs : null;
    job.lastActivityAt = isoAt(at);
    save();
    appendLog({ event: "stall", job: job.id, key: job.key, session: job.session, silenceMs, reason: job.stallReason, tool: job.stallTool, callIds: tool?.callIds ?? [], runningMs: job.stallRunningMs, pid: job.lease?.pid ?? null });
    const fields = {
      key: job.key,
      session: job.session,
      pid: job.lease?.pid ?? null,
      silenceMs,
      local: localStamp(at),
      reason: job.stallReason,
      tool,
    };
    try {
      const notice = await notices.emit({
        text: stallNoticeText(fields),
        prompt: stallNoticePrompt({
          key: job.key,
          platform: adapter.name,
          cli: config.cli,
          instructions: prompts.read("stall-instructions.md").trim(),
          actions: prompts.stallActions(adapter.name),
        }),
      });
      save();
      return notice;
    } catch (error) {
      log("error", "stall-notify", String(error?.message ?? error));
      return null;
    }
  }

  function latestJobFor(key) {
    return Object.values(state.jobs)
      .filter((job) => job.key === key)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0] ?? null;
  }

  async function replyToJob(job, text) {
    if (!job) return false;
    try {
      await adapter.reply(ctxOf(job), text);
      return true;
    } catch (error) {
      log("error", "action-reply", String(error?.message ?? error));
      return false;
    }
  }

  function dropQueued(key) {
    const dropped = [];
    for (const [id, job] of Object.entries(state.jobs)) {
      if (!job || job.key !== key || job.status !== "queued") continue;
      job.status = "cancelled";
      job.error = "stopped";
      job.updatedAt = isoNow();
      dropped.push(id);
    }
    if (dropped.length) state.inbox = state.inbox.filter((id) => !dropped.includes(id));
    if (dropped.length) save();
    return dropped;
  }

  function notRunningText(action, job) {
    const status = STATUS_TEXT[job?.status] ?? "结束";
    const verb = action === "cancel" ? "取消" : "重启";
    return `当前没有在跑的任务：最近一条 job（${job.id}）已经${status}，不需要${verb}。`;
  }

  async function finishStalled({ key, action, text }) {
    const activeId = state.convs[key]?.activeJob;
    const active = activeId ? state.jobs[activeId] : null;
    const runningNow = Boolean(active) && children.has(key);
    if (!runningNow) {
      const dropped = dropQueued(key);
      if (!dropped.length) {
        const target = active ?? latestJobFor(key);
        appendLog({ event: "action", action, key, job: target?.id ?? null, note: "not-running" });
        if (target) await replyToJob(target, notRunningText(action, target));
        return false;
      }
      appendLog({ event: "action", action, key, job: dropped.join(","), note: "dequeued" });
      if (action !== "restart") {
        await replyToJob(active ?? latestJobFor(key), `已取消排队中的 ${dropped.length} 个任务（还没开始跑）。`);
        return true;
      }
    }
    const job = runningNow ? active : null;
    let outcome = "dequeued";
    if (job) {
      const lastAt = Date.parse(job.lastActivityAt ?? "");
      const notifiedAt = Date.parse(job.stallNotifiedAt ?? "");
      const at = [lastAt, notifiedAt].find(Number.isFinite) ?? now();
      const startedAt = job.lease?.startedAt ?? Date.parse(job.createdAt);
      const minutes = Math.max(0, Math.round((at - startedAt) / 60_000));
      job.stallCancelled = true;
      job.cutoffAt = isoAt(at);
      save();
      outcome = await terminate(key, `已终止：这一轮卡住了。工时按最后一次进展截止，计入 ${minutes} 分钟（到 ${localStamp(at)}）。`);
      job.updatedAt = isoNow();
      save();
      appendLog({ event: "action", action, key, job: job.id, outcome });
      if (action !== "restart") return true;
    } else {
      appendLog({ event: "action", action, key, job: null, outcome });
    }
    const base = latestJobFor(key) ?? job;
    if (!base) return false;
    const prompt = [RESTART_PROMPT, String(text ?? "").trim()].filter(Boolean).join("\n\n");
    const inbound = {
      ...base.inbound,
      key,
      session: base.session,
      noticeId: null,
      dedupeId: `stall-restart-${now()}`,
      text: prompt,
      rootText: base.inbound?.rootText ?? prompt,
    };
    const next = createJob(state, inbound, isoNow);
    next.auto = "stall-restart";
    state.jobs[next.id] = next;
    state.inbox.push(next.id);
    state.seen[inbound.dedupeId] = next.id;
    save();
    appendLog({ event: "restart", job: next.id, from: job?.id ?? null, key });
    drainInbox();
    return true;
  }

  async function applyAction({ action, key, text } = {}) {
    if (!action || !key || !ACTION_KINDS[action]) return false;
    return finishStalled({ key, action, text });
  }

  async function drainCommands() {
    let names = [];
    try {
      names = readdirSync(commandDir).filter((name) => name.endsWith(".json")).sort();
    } catch {
      return 0;
    }
    let handled = 0;
    for (const name of names) {
      const file = join(commandDir, name);
      let command = null;
      try {
        command = JSON.parse(readFileSync(file, "utf8"));
      } catch {}
      try {
        unlinkSync(file);
      } catch {}
      if (!command) continue;
      const writtenAt = Date.parse(command.at ?? "");
      if (!Number.isFinite(writtenAt) || now() - writtenAt > COMMAND_TTL_MS) continue;
      try {
        if (command.op === "emit") {
          await notices.emit({ text: command.text, prompt: command.prompt ?? "" });
        } else if (command.op === "schedule") {
          const outcome = scheduleJob(command);
          appendLog({ event: "command-schedule", ...outcome, key: String(command.key ?? "") });
        } else if (command.op === "cancel") {
          const outcome = cancelScheduled(command);
          appendLog({ event: "command-cancel", ...outcome, dedupe: String(command.dedupe ?? "") });
        } else if (String(command.op ?? "").startsWith("loop-")) {
          const outcome = await applyLoopCommand(command);
          appendLog({ event: command.op, ...outcome });
        } else {
          await applyAction(command);
        }
        handled += 1;
      } catch (error) {
        log("error", "command", String(error?.message ?? error));
      }
    }
    return handled;
  }

  function pruneSeen() {
    const ids = Object.keys(state.seen);
    if (!ids.length) return;
    const cutoff = now() - SEEN_RETENTION_MS;
    for (const dedupeId of ids) {
      const value = state.seen[dedupeId];
      const job = value === "legacy" ? null : state.jobs[value];
      if (job && !isFinished(job)) continue;
      const stamp = job ? Date.parse(job.updatedAt) : 0;
      if (job && Number.isFinite(stamp) && stamp > cutoff) continue;
      if (ids.length > MAX_SEEN || (job && Number.isFinite(stamp) && stamp <= cutoff)) delete state.seen[dedupeId];
    }
  }

  function runtimeInbound(job) {
    let inbound = runtimeInbounds.get(job.id);
    if (!inbound) {
      inbound = { ...job.inbound, key: job.key, session: job.session, noticeId: job.noticeId ?? null };
      runtimeInbounds.set(job.id, inbound);
    }
    return inbound;
  }

  function runningJobs() {
    const at = now();
    return [...children.keys()]
      .map((key) => {
        const activeId = state.convs[key]?.activeJob;
        const job = activeId ? state.jobs[activeId] : null;
        if (!job) return null;
        const leaseStartedAt = job.lease?.startedAt;
        const created = Date.parse(job.createdAt ?? "");
        const started = Number.isFinite(leaseStartedAt) ? leaseStartedAt : created;
        const from = Number.isFinite(started) ? started : at;
        return { started: from, label: `${job.id}，已跑 ${Math.max(0, Math.round((at - from) / 60_000))} 分钟` };
      })
      .filter(Boolean)
      .sort((a, b) => a.started - b.started)
      .map((item) => ({ label: item.label }));
  }

  function isScheduled(job) {
    return job.origin === "self" || job.origin === "external";
  }

  function jobTimeoutMs(job) {
    if (job.origin === "loop") return Math.min(adapter.timeoutMs, LOOP_TIMEOUT_MS);
    if (isScheduled(job)) return Math.min(adapter.timeoutMs, SELF_TIMEOUT_MS);
    return adapter.timeoutMs;
  }

  function buildPrompt(job, entry) {
    const inbound = runtimeInbound(job);
    const root = entry.rootText || inbound.text;
    const base = { platform: adapter.name, adapter, inbound, root, running: runningJobs() };
    if (job.origin === "loop" && job.loop) return prompts.loopRound({ ...base, loop: job.loop });
    if (isScheduled(job)) {
      return prompts.selfJob({
        ...base,
        brief: inbound.text,
        origin: job.origin,
        chain: job.chain ?? 0,
        dueAt: job.dueAt ?? null,
        deliveredAt: isoAt(job.startedAt ?? now()),
        lateMs: job.lateMs ?? 0,
      });
    }
    if (job.noticeId) {
      const notice = notices.get(job.noticeId);
      if (notice) return prompts.noticeReply({ ...base, notice });
    }
    return prompts.conversation(base);
  }

  function execute(job, entry) {
    const inbound = runtimeInbound(job);
    const full = !hasSession(entry.session);
    if (isScheduled(job) || job.origin === "loop") {
      const built = buildPrompt(job, entry);
      const render = (prompt) => {
        if (job.origin === "loop" && !String(prompt ?? "").trim()) {
          appendLog({ event: "empty-prompt", job: job.id, key: inbound.key });
          job.status = "failed";
          job.error = "empty-prompt";
          job.updatedAt = isoNow();
          save();
          return finishRound(job);
        }
        return spawnWorker(job, entry, inbound, prompt, false);
      };
      return typeof built?.then === "function" ? built.then(render) : render(built);
    }
    if (!full) return spawnWorker(job, entry, inbound, inbound.text, false);
    const built = buildPrompt(job, entry);
    const run = (prompt) => {
      if (String(prompt ?? "").trim()) return spawnWorker(job, entry, inbound, prompt, true);
      appendLog({ event: "empty-prompt", job: job.id, key: inbound.key });
      job.status = "failed";
      job.error = "empty-prompt";
      job.updatedAt = isoNow();
      save();
      return adapter.reply(ctxOf(job), `prompt 模板为空，本轮没有启动：检查 ${config.promptsDir} 下的 thread.md / notice.md。`).catch((error) => log("error", "empty-prompt", String(error?.message ?? error)));
    };
    if (typeof built?.then === "function") return built.then(run);
    return run(built);
  }

  function spawnWorker(job, entry, inbound, prompt, full) {
    const refs = (inbound.attachments ?? []).map((attachment) => `@${attachment.path}`);
    const args = adapter.worker === "stub" ? ["-e", `console.log("[stub] session=${entry.session} full=${full}")`] : ["--print", "--session-id", entry.session, "--", ...refs, prompt];
    const bin = adapter.worker === "stub" ? process.execPath : adapter.piBin;
    const command = adapter.buildWorker ? adapter.buildWorker({ prompt, full, session: entry.session }) : { bin, args };
    const started = now();
    const timeoutMs = jobTimeoutMs(job);
    appendLog({ event: "dispatch", job: job.id, key: inbound.key, session: entry.session, full });

    return new Promise((resolve) => {
      const child = spawn(command.bin, command.args, {
        cwd: config.cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, AGENT_RELAY_SELF_CHAIN: String(job.chain ?? 0) },
      });
      let stdout = "";
      let stderr = "";
      let killed = false;
      children.set(inbound.key, child);
      job.lease = { pid: child.pid ?? null, startTicks: child.pid ? readStartTicks(child.pid) : null, startedAt: now() };
      job.startedAt = started;
      job.updatedAt = isoNow();
      save();
      const stallTimer = setInterval(() => {
        checkStall(job).catch((error) => log("warn", "stall", String(error?.message ?? error)));
      }, STALL_CHECK_MS);
      stallTimer.unref?.();
      const timer = setTimeout(() => {
        killed = true;
        terminate(inbound.key, "").catch((error) => log("warn", "timeout-stop", String(error?.message ?? error)));
      }, timeoutMs);
      const progressPromise = Promise.resolve(adapter.onProgress?.(ctxOf(job))).then((progress) => {
        if (!progress) return;
        job.progress = progress;
        job.updatedAt = isoNow();
        save();
      }).catch((error) => log("warn", "progress", String(error?.message ?? error)));
      void progressPromise;
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", (error) => stderr += `${error}\n`);
      child.on("close", async (code) => {
        clearTimeout(timer);
        clearInterval(stallTimer);
        children.delete(inbound.key);
        appendLog({ event: "done", job: job.id, key: inbound.key, session: entry.session, exit: code, killed, elapsedMs: now() - started });
        const body = stdout.trim();
        const note = notes.get(inbound.key);
        notes.delete(inbound.key);
        if (isScheduled(job) && !note && !killed && code === 0 && !body) {
          job.answer = null;
          job.status = "done";
          job.lease = null;
          job.updatedAt = isoNow();
          save();
          appendLog({ event: "job-empty", job: job.id, key: inbound.key });
          runtimeInbounds.delete(job.id);
          resolve();
          return;
        }
        const text = note
          ? note
          : killed
            ? `已终止：本轮超过 ${Math.round(timeoutMs / 60_000)} 分钟未结束。回复「继续」可以接着做，前面已完成的改动都在。\n\n${body.slice(-1500)}`.trim()
            : body || `[无输出] exit=${code}\n${stderr.trim().split("\n").slice(-10).join("\n")}`;
        job.answer = text;
        job.status = note ? "cancelled" : killed || code !== 0 ? "failed" : "answered";
        job.lease = null;
        job.updatedAt = isoNow();
        if (job.origin === "loop") job.loopOutput = text;
        save();
        await deliver(job);
        if (job.origin === "loop") await finishRound(job);
        runtimeInbounds.delete(job.id);
        resolve();
      });
    });
  }

  function mediaFor(job) {
    return typeof adapter.postMedia === "function" ? extractMedia(job.answer ?? "") : null;
  }

  async function deliverParts(job) {
    const canEdit = typeof adapter.edit === "function";
    const media = mediaFor(job);
    const plan = planParts({ answer: media ? media.text : job.answer ?? "", parts: job.parts, chunkLimit: adapter.chunkLimit, canEdit, media });
    for (const step of plan) {
      if (step.action === "skip") continue;
      try {
        if (step.kind === "media") {
          await adapter.postMedia(ctxOf(job), step.files);
          job.parts = [...job.parts.filter((part) => part.i !== step.i), { i: step.i, kind: "media", messageId: null, hash: step.hash, sentAt: isoNow() }];
        } else if (step.action === "edit") {
          const ok = await adapter.edit(ctxOf(job), step.messageId, step.text);
          if (!ok) {
            log("warn", "edit-skip", job.id, step.i);
            continue;
          }
          job.parts = [...job.parts.filter((part) => part.i !== step.i), { i: step.i, messageId: step.messageId, hash: hashOf(step.text), sentAt: isoNow() }];
        } else {
          const sent = await adapter.reply(ctxOf(job), step.text);
          job.parts = [...job.parts.filter((part) => part.i !== step.i), { i: step.i, messageId: sent?.messageId ?? null, hash: hashOf(step.text), sentAt: isoNow() }];
        }
        job.updatedAt = isoNow();
        save();
      } catch (error) {
        log("error", "reply", String(error?.message ?? error));
        return false;
      }
    }
    return true;
  }

  async function deliver(job) {
    let failed = true;
    for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt += 1) {
      failed = !(await deliverParts(job));
      if (!failed) break;
      job.deliveryAttempts = (job.deliveryAttempts ?? 0) + 1;
      job.deliveryFailedAt = isoNow();
      if (attempt < MAX_DELIVERY_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, deliveryRetryMs));
    }
    if (!failed) {
      job.deliveryAttempts = 0;
      job.deliveryFailedAt = undefined;
    }
    try {
      await adapter.onProgressDone?.(ctxOf(job));
    } catch (error) {
      log("warn", "progress-done", String(error?.message ?? error));
    }
    job.progress = null;
    if (failed && job.status === "answered") {
      job.status = "failed";
      job.error = "reply-failed";
    } else if (!failed && job.status === "answered") {
      job.status = "done";
      job.answer = undefined;
    }
    job.updatedAt = isoNow();
    save();
    return job.status;
  }

  function startJob(job) {
    const entry = state.convs[job.key] ?? { session: job.session, rootText: job.inbound.rootText, lastMsgTs: null, activeJob: null };
    entry.activeJob = job.id;
    state.convs[job.key] = entry;
    job.status = "running";
    job.lease = { pid: null, startTicks: null, startedAt: now() };
    job.updatedAt = isoNow();
    running.add(job.id);
    save();
    execute(job, entry)
      .catch((error) => {
        log("error", "execute", String(error?.message ?? error));
        job.status = "failed";
        job.error = String(error?.message ?? error);
      })
      .finally(() => {
        running.delete(job.id);
        if (entry.activeJob === job.id) entry.activeJob = null;
        job.updatedAt = isoNow();
        runtimeInbounds.delete(job.id);
        save();
        drainInbox();
      });
  }

  function keyIsBusy(key) {
    const activeId = state.convs[key]?.activeJob;
    if (!activeId) return false;
    const holder = state.jobs[activeId];
    return Boolean(holder) && !isFinished(holder);
  }

  function drainInbox() {
    while (running.size < adapter.maxWorkers) {
      const index = state.inbox.findIndex((id) => {
        const job = state.jobs[id];
        if (!job || job.status !== "queued") return false;
        return !keyIsBusy(job.key);
      });
      if (index < 0) return;
      const [jobId] = state.inbox.splice(index, 1);
      startJob(state.jobs[jobId]);
    }
  }

  function parseCommand(text) {
    const trimmed = String(text ?? "").trim();
    const lower = trimmed.toLowerCase();
    if (lower === "停" || lower === "stop" || /^\/stop(@\w+)?$/.test(lower)) return "stop";
    if (trimmed === "重跑" || /^\/重跑$/.test(trimmed) || /^\/rerun(@\w+)?$/i.test(trimmed)) return "retry";
    return null;
  }

  function ctxFor(inbound, job) {
    if (job) return ctxOf(job);
    return {
      jobId: null,
      key: inbound.key,
      chatId: inbound.chatId ?? null,
      messageId: inbound.messageId ?? null,
      threadId: inbound.threadId ?? null,
      replyTo: inbound.replyTo ?? null,
      progress: null,
      text: inbound.text,
      rootText: inbound.rootText ?? inbound.text,
    };
  }

  async function runStop(inbound) {
    const activeId = state.convs[inbound.key]?.activeJob;
    const job = activeId ? state.jobs[activeId] : null;
    const cancelled = cancel(inbound.key);
    if (job && job.status === "running") {
      job.status = "cancelled";
      job.lease = null;
      job.updatedAt = isoNow();
    }
    const dropped = dropQueued(inbound.key);
    state.seen[inbound.dedupeId] = "legacy";
    save();
    appendLog({ event: "stop", key: inbound.key, cancelled, job: job?.id ?? null, dequeued: dropped });
    if (cancelled) return "accepted";
    let text = "当前没有在跑的任务。";
    if (dropped.length) text = `已取消排队中的 ${dropped.length} 个任务（还没开始跑）。`;
    try {
      await adapter.reply(ctxFor(inbound, job), text);
    } catch (error) {
      log("error", "stop-reply", String(error?.message ?? error));
    }
    return "accepted";
  }

  async function runRetry(inbound) {
    const target = Object.values(state.jobs)
      .filter((job) => job.key === inbound.key && job.status === "interrupted")
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
    if (!target) {
      try {
        await adapter.reply(ctxFor(inbound, null), "这个会话没有可重跑的中断任务。");
      } catch (error) {
        log("error", "retry-reply", String(error?.message ?? error));
      }
      return "accepted";
    }
    const attempt = Number(target.attempts ?? 1) + 1;
    const retryInbound = {
      ...target.inbound,
      key: target.key,
      session: target.session,
      noticeId: target.noticeId ?? null,
      dedupeId: `${target.inbound.dedupeId}#retry${attempt - 1}`,
      authorId: inbound.authorId ?? target.inbound.authorId,
      chatId: inbound.chatId ?? target.inbound.chatId,
      messageId: inbound.messageId ?? target.inbound.messageId,
      threadId: inbound.threadId ?? target.inbound.threadId,
    };
    const job = createJob(state, retryInbound, isoNow);
    job.attempts = attempt;
    state.jobs[job.id] = job;
    state.inbox.push(job.id);
    state.seen[retryInbound.dedupeId] = job.id;
    state.seen[inbound.dedupeId] = job.id;
    target.retriedBy = job.id;
    target.updatedAt = isoNow();
    save();
    appendLog({ event: "retry", job: job.id, from: target.id, key: job.key });
    drainInbox();
    return "accepted";
  }

  async function interrupt(job) {
    if (!job.noticeSent && isScheduled(job)) {
      job.noticeSent = true;
    }
    if (!job.noticeSent) {
      try {
        await adapter.reply(ctxOf(job), INTERRUPT_NOTICE);
      } catch (error) {
        log("error", "interrupt-reply", String(error?.message ?? error));
      }
      try {
        await adapter.onProgressDone?.(ctxOf(job));
      } catch (error) {
        log("warn", "progress-done", String(error?.message ?? error));
      }
      job.noticeSent = true;
    }
    job.status = isScheduled(job) ? "cancelled" : "interrupted";
    job.error = isScheduled(job) ? "interrupted" : job.error;
    job.lease = null;
    job.answer = undefined;
    job.progress = null;
    job.updatedAt = isoNow();
    save();
    appendLog({ event: "interrupted", job: job.id, key: job.key });
  }

  async function recover() {
    const canEdit = typeof adapter.edit === "function";
    let touched = 0;
    for (const job of Object.values(state.jobs)) {
      if (isFinished(job) || job.status === "interrupted") {
        if (state.inbox.includes(job.id)) state.inbox = state.inbox.filter((id) => id !== job.id);
        continue;
      }
      const action = nextAction(job, { canEdit, chunkLimit: adapter.chunkLimit, media: mediaFor(job), readStartTicks, probeAlive });
      if (action.type === "none") continue;
      if (action.type === "rerun") {
        if (!state.inbox.includes(job.id)) state.inbox.push(job.id);
        touched += 1;
        continue;
      }
      if (action.type === "reap-then-interrupt") {
        await reapWorker(action.pid);
        await interrupt(job);
        touched += 1;
        continue;
      }
      if (action.type === "interrupt") {
        await interrupt(job);
        touched += 1;
        continue;
      }
      if (action.type === "resend") {
        await deliver(job);
        touched += 1;
        continue;
      }
      job.answer = undefined;
      job.progress = null;
      touched += 1;
    }
    if (touched) save();
    drainInbox();
    return touched;
  }

  async function onReady() {
    if (adapter.bootNotice === false) return false;
    const bootId = readBootIdImpl();
    if (!bootId) {
      log("warn", "boot-notice", "no-boot-id");
      return false;
    }
    if (!shouldAnnounceBoot(state.meta.bootNotice?.bootId, bootId)) return false;
    const at = new Date(now());
    try {
      const notice = await notices.emit({ text: bootNoticeText(at, localStamp) });
      state.meta.bootNotice = { bootId, at: at.toISOString(), noticeId: notice.id };
      save();
      log("info", "boot-notice", bootId, notice.id);
      return true;
    } catch (error) {
      log("error", "boot-notice", String(error?.message ?? error));
      return false;
    }
  }

  function acceptJob(inbound, { notice = null } = {}) {
    const job = createJob(state, inbound, isoNow);
    state.jobs[job.id] = job;
    state.inbox.push(job.id);
    state.seen[inbound.dedupeId] = job.id;
    const entry = state.convs[job.key] ?? { session: job.session, rootText: job.inbound.rootText, lastMsgTs: null, activeJob: null };
    if (!entry.activeJob) entry.activeJob = null;
    entry.lastMsgTs = job.createdAt;
    if (!entry.rootText) entry.rootText = job.inbound.rootText;
    if (notice) entry.noticeId = notice.id;
    state.convs[job.key] = entry;
    pruneSeen();
    save();
    appendLog({ event: "accepted", job: job.id, key: job.key, session: job.session, notice: notice?.id ?? null });
    return job;
  }

  function callerChain() {
    const inside = process.env.AGENT_RELAY_SELF_CHAIN;
    return { inside: inside !== undefined, depth: Number(inside ?? 0) + 1 };
  }

  function recentlyScheduled(key) {
    const since = now() - 3_600_000;
    return Object.values(state.jobs ?? {}).filter((job) => job.key === key && job.origin !== "user" && Date.parse(job.createdAt ?? "") > since).length;
  }

  function findJobByDedupe(dedupe) {
    const id = state.seen?.[dedupe];
    if (id && state.jobs[id]) return state.jobs[id];
    return Object.values(state.jobs ?? {}).find((job) => job.inbound?.dedupeId === dedupe) ?? null;
  }

  function scheduleJob({ key, dedupe, brief, dueAt, graceMs = DEFAULT_GRACE_MS } = {}) {
    if (typeof adapter.selfContext !== "function") return { rejected: "platform" };
    if (!state.convs[key]) return { rejected: "unknown-key" };
    if (state.seen[dedupe]) return { rejected: "duplicate" };
    const body = String(brief ?? "").trim();
    if (!body) return { rejected: "empty" };
    if (Buffer.byteLength(body) > BRIEF_MAX_BYTES) return { rejected: "too-long" };
    if (recentlyScheduled(key) >= RUNAWAY_PER_HOUR) return { rejected: "runaway" };
    const parsed = Date.parse(dueAt ?? "");
    const at = Number.isFinite(parsed) ? parsed : now();
    const context = adapter.selfContext(key);
    if (!context) return { rejected: "platform" };
    const inbound = {
      key,
      session: adapter.sessionFor(key),
      dedupeId: dedupe,
      text: body,
      rootText: state.convs[key]?.rootText ?? body,
      authorId: "self",
      messageId: null,
      ...context,
    };

    const caller = callerChain();
    if (at <= now()) {
      if (running.size >= adapter.maxWorkers && state.inbox.length >= adapter.queueDepth) return { rejected: "queue-full" };
      const started = acceptJob(inbound);
      started.origin = caller.inside ? "self" : "external";
      started.chain = caller.depth;
      started.dueAt = isoAt(at);
      started.expiresAt = isoAt(at + graceMs);
      save();
      appendLog({ event: "job-started", job: started.id, key, chain: started.chain });
      drainInbox();
      return { job: started.id };
    }

    const job = createJob(state, inbound, isoNow);
    job.origin = caller.inside ? "self" : "external";
    job.chain = caller.depth;
    job.dueAt = isoAt(at);
    job.expiresAt = isoAt(at + graceMs);
    job.status = "scheduled";
    state.jobs[job.id] = job;
    state.seen[dedupe] = job.id;
    const entry = state.convs[key] ?? { session: job.session, rootText: job.inbound.rootText, lastMsgTs: null, activeJob: null };
    if (!entry.rootText) entry.rootText = job.inbound.rootText;
    state.convs[key] = entry;
    pruneSeen();
    save();
    appendLog({ event: "job-scheduled", job: job.id, key, due: job.dueAt, chain: job.chain });
    return { job: job.id };
  }

  function cancelScheduled({ dedupe } = {}) {
    const job = findJobByDedupe(dedupe);
    if (!job) return { rejected: "unknown" };
    if (job.status !== "scheduled") return { rejected: "not-scheduled", job: job.id, status: job.status };
    job.status = "cancelled";
    job.error = "cancelled";
    job.updatedAt = isoNow();
    save();
    appendLog({ event: "job-cancelled", job: job.id, key: job.key, dedupe });
    return { job: job.id };
  }

  function loopLastLine(loop) {
    const at = Date.parse(loop.lastRunAt ?? "");
    if (!Number.isFinite(at)) return "这是第一轮。";
    return `${localStamp(at)} ${loop.lastOutcome ?? "-"}（${loop.lastRunId ?? "-"}）`;
  }

  function openRoundJob(loop) {
    const jobId = state.seen?.[loop.lastRunId];
    if (!jobId || jobId === "legacy") return null;
    const job = state.jobs?.[jobId];
    return job && !isFinished(job) ? job : null;
  }

  async function runLoopRound(loop, { trigger = "tick" } = {}) {
    const at = now();
    const round = Number(loop.lastRound ?? 0) + 1;
    const runId = roundKeyFor(loop.id, round);
    const header = roundTitle(loop, round);
    const lateMs = loopLateMs(loop, at);
    const job = acceptJob({
      key: runId,
      session: adapter.sessionFor(runId),
      dedupeId: runId,
      text: header,
      rootText: header,
      chatId: null,
      messageId: null,
      threadId: null,
      replyTo: null,
      attachments: [],
    });
    job.origin = "loop";
    job.chain = 0;
    job.dueAt = isoAt(at - lateMs);
    job.lateMs = lateMs;
    job.loop = { id: loop.id, round, prompt: loop.prompt, last: loopLastLine(loop), trigger, lateMs };
    loop.lastRound = round;
    loop.lastRunId = runId;
    loop.lastRunAt = isoAt(at);
    loop.lastOutcome = null;
    if (loop.at) loop.state = "done";
    state.meta.loopRoundStamps = [...(state.meta.loopRoundStamps ?? []), isoAt(at)].slice(-400);
    save();
    appendLog({ event: "loop-round", loop: loop.id, runId, job: job.id, trigger, lateMs });
    drainInbox();
    return job;
  }

  async function finishRound(job) {
    const loop = state.loops?.[job.loop?.id];
    const runId = roundKeyFor(job.loop.id, job.loop.round);
    const messageId = job.parts?.[0]?.messageId ?? null;
    const delivered = job.status === "done" || job.status === "answered";
    const outcome = delivered && messageId ? "ok" : "failed";
    if (outcome === "failed" && !job.error) job.error = delivered ? "no-message-id" : job.status;
    if (messageId) {
      state.loopRuns[messageId] = { loopId: job.loop.id, runId, key: job.key, rootText: job.inbound.rootText, at: isoNow() };
    }
    if (loop) {
      loop.lastMessageId = messageId;
      loop.lastOutcome = outcome;
      loop.failStreak = outcome === "ok" ? 0 : Number(loop.failStreak ?? 0) + 1;
      if (loop.failStreak >= 3 && loop.state === "armed") {
        loop.state = "paused";
        notices
          .emit({ text: `⏸ ${loop.id} 连续 ${loop.failStreak} 轮失败，已暂停：${job.error ?? outcome}` })
          .catch((error) => log("warn", "loop-pause-notice", String(error?.message ?? error)));
      }
    }
    appendRound(loopHistoryDir, job.loop.id, {
      runId,
      loopId: job.loop.id,
      round: job.loop.round,
      at: isoNow(),
      trigger: job.loop.trigger,
      jobId: job.id,
      key: job.key,
      messageId,
      outcome,
      error: job.error ?? null,
      lateMs: job.loop.lateMs ?? 0,
      output: truncateOutput(job.loopOutput ?? ""),
    });
    save();
    await openRoundThread(job, messageId);
  }

  async function openRoundThread(job, messageId) {
    const loop = state.loops?.[job.loop?.id];
    if (!loop?.thread || !messageId) return;
    if (typeof adapter.openRoundThread !== "function") return;
    try {
      const opened = await adapter.openRoundThread({ messageId, name: roundTitle(loop, job.loop.round), key: job.key });
      if (opened?.threadId) appendLog({ event: "loop-thread", loop: loop.id, threadId: opened.threadId, key: job.key });
    } catch (error) {
      log("warn", "round-thread", String(error?.message ?? error));
    }
  }

  function handleRoundReply(inbound, round) {
    const keyed = { ...inbound, key: round.key, session: adapter.sessionFor(round.key), rootText: round.rootText ?? inbound.text };
    const job = acceptJob(keyed);
    if (running.size >= adapter.maxWorkers && state.inbox.length > adapter.queueDepth) {
      state.inbox = state.inbox.filter((id) => id !== job.id);
      job.status = "failed";
      job.error = "queue-full";
      job.updatedAt = isoNow();
      delete state.seen[keyed.dedupeId];
      save();
      log("ignore", "queue-full", job.id);
      return "busy";
    }
    appendLog({ event: "loop-reply", loop: round.loopId, runId: round.runId, job: job.id, key: round.key });
    drainInbox();
    return "accepted";
  }

  function throttleNotice() {
    const at = Date.parse(state.meta.loopThrottleAt ?? "");
    if (Number.isFinite(at) && now() - at < 3_600_000) return;
    state.meta.loopThrottleAt = isoAt(now());
    save();
    notices
      .emit({ text: `⏳ 本平台这一小时的 loop 轮数已到上限（${LOOP_ROUNDS_PER_HOUR}），后面的轮次跳过。` })
      .catch((error) => log("warn", "loop-throttle-notice", String(error?.message ?? error)));
  }

  async function startDueLoops() {
    const at = now();
    let started = 0;
    for (const loop of Object.values(state.loops ?? {})) {
      const reason = roundSkipReason({
        loop,
        nowMs: at,
        openJob: openRoundJob(loop),
        running: running.size,
        maxWorkers: adapter.maxWorkers,
        roundsLastHour: roundsInLastHour(state.meta.loopRoundStamps, at) + started,
        hourLimit: LOOP_ROUNDS_PER_HOUR,
      });
      if (reason === "throttled") {
        throttleNotice();
        continue;
      }
      if (reason) continue;
      await runLoopRound(loop, { trigger: "tick" });
      started += 1;
    }
    return started;
  }

  async function applyLoopCommand(command) {
    const op = String(command.op ?? "");
    const loops = state.loops;
    const platform = platformOfLoopId(command.id);
    if (op === "loop-create") {
      const refused = validateSchedule({ every: command.every, at: command.loopAt }) ?? validatePrompt(command.prompt);
      if (refused) return { op, refused };
      const id = isLoopId(command.id) && platformOfLoopId(command.id) === adapter.name ? command.id : nextLoopId(loops, adapter.name);
      if (loops[id]) return { op, refused: "duplicate", id };
      if (activeLoopCount(loops) >= 20) return { op, refused: "too-many-loops" };
      loops[id] = createLoop({
        id,
        prompt: command.prompt,
        every: command.every ?? null,
        at: command.loopAt ?? null,
        thread: command.thread !== false,
        createdBy: command.createdBy ?? null,
        nowIso: isoNow(),
      });
      save();
      return { op, id };
    }
    if (op === "loop-run") {
      const loop = loops[command.id];
      if (!loop) return { op, refused: "not-found" };
      if (loop.state === "deleted") return { op, refused: "deleted" };
      if (openRoundJob(loop)) return { op, refused: "busy" };
      const job = await runLoopRound(loop, { trigger: "manual" });
      return { op, id: loop.id, job: job.id };
    }
    const loop = loops[command.id];
    if (!loop) return { op, refused: "not-found" };
    if (op === "loop-state") {
      const next = String(command.state ?? "");
      if (!["armed", "paused", "deleted"].includes(next)) return { op, refused: "bad-state" };
      loop.state = next;
      if (next === "armed") loop.failStreak = 0;
      save();
      return { op, id: loop.id, state: loop.state };
    }
    if (op === "loop-update") {
      if (command.every !== undefined || command.loopAt !== undefined) {
        const refused = validateSchedule({ every: command.every ?? null, at: command.loopAt ?? null });
        if (refused) return { op, refused };
        loop.every = command.every ?? null;
        loop.at = command.loopAt ?? null;
        if (loop.at) loop.state = "armed";
      }
      if (command.prompt !== undefined) {
        const refused = validatePrompt(command.prompt);
        if (refused) return { op, refused };
        loop.prompt = String(command.prompt).trim();
      }
      if (command.thread !== undefined) loop.thread = command.thread !== false;
      save();
      return { op, id: loop.id };
    }
    return { op, refused: "unknown-op" };
  }

  function startDueJobs() {
    let touched = 0;
    for (const job of Object.values(state.jobs ?? {})) {
      if (job.status !== "scheduled") continue;
      const due = Date.parse(job.dueAt ?? "");
      if (!Number.isFinite(due) || due > now()) continue;
      if (Date.parse(job.expiresAt ?? "") < now()) {
        job.status = "cancelled";
        job.error = "expired";
        job.updatedAt = isoNow();
        appendLog({ event: "job-expired", job: job.id, key: job.key, due: job.dueAt });
        touched += 1;
        continue;
      }
      if (keyIsBusy(job.key)) {
        if (!job.waitLoggedAt) {
          job.waitLoggedAt = isoNow();
          appendLog({ event: "job-waiting-key", job: job.id, key: job.key, lateMs: now() - due });
          touched += 1;
        }
        continue;
      }
      job.status = "queued";
      job.lateMs = now() - due;
      job.waitLoggedAt = undefined;
      job.updatedAt = isoNow();
      if (!state.inbox.includes(job.id)) state.inbox.push(job.id);
      appendLog({ event: "job-due", job: job.id, key: job.key, lateMs: job.lateMs, chain: job.chain });
      touched += 1;
    }
    if (touched) save();
    drainInbox();
    return touched;
  }

  async function handleNoticeReply(inbound, notice) {
    const key = `notice-${notice.id}`;
    const keyed = {
      ...inbound,
      key,
      session: adapter.sessionFor(key),
      noticeId: notice.id,
      rootText: notice.text,
    };
    const job = acceptJob(keyed, { notice });
    if (running.size >= adapter.maxWorkers && state.inbox.length > adapter.queueDepth) {
      state.inbox = state.inbox.filter((id) => id !== job.id);
      job.status = "failed";
      job.error = "queue-full";
      job.updatedAt = isoNow();
      delete state.seen[keyed.dedupeId];
      save();
      log("ignore", "queue-full", job.id);
      try {
        await adapter.reply(runtimeInbound(job), "当前繁忙：已有任务在跑且排队已满，稍后再发一次。");
      } catch (error) {
        log("error", "busy-reply", String(error?.message ?? error));
      }
      return "busy";
    }
    drainInbox();
    return "accepted";
  }

  async function handle(inbound) {
    if (adapter.allowedUser && inbound.authorId && inbound.authorId !== adapter.allowedUser) {
      log("ignore", "author", inbound.authorId);
      return "ignored";
    }
    const command = parseCommand(inbound.text);
    const known = state.seen[inbound.dedupeId];
    if (command) {
      if (known && known !== "legacy") {
        log("ignore", "duplicate-command", inbound.dedupeId);
        return "duplicate";
      }
      return command === "stop" ? runStop(inbound) : runRetry(inbound);
    }
    const notice = notices.match(inbound.replyIds ?? []);
    if (known === "legacy") {
      log("ignore", "duplicate-legacy", inbound.dedupeId);
      return "duplicate";
    }
    const existing = known ? state.jobs[known] : null;
    if (existing && !isFinished(existing)) {
      log("ignore", "duplicate-in-flight", existing.id);
      return "accepted";
    }
    if (known) {
      log("ignore", "duplicate", inbound.dedupeId);
      return "duplicate";
    }
    if (notice) return handleNoticeReply(inbound, notice);
    const round = matchRound(state.loopRuns, inbound.replyIds ?? []);
    if (round) return handleRoundReply(inbound, round);

    const job = acceptJob(inbound);
    if (running.size >= adapter.maxWorkers && state.inbox.length > adapter.queueDepth) {
      state.inbox = state.inbox.filter((id) => id !== job.id);
      job.status = "failed";
      job.error = "queue-full";
      job.updatedAt = isoNow();
      delete state.seen[inbound.dedupeId];
      save();
      log("ignore", "queue-full", job.id);
      try {
        await adapter.reply(runtimeInbound(job), "当前繁忙：已有任务在跑且排队已满，稍后再发一次。");
      } catch (error) {
        log("error", "busy-reply", String(error?.message ?? error));
      }
      return "busy";
    }
    drainInbox();
    return "accepted";
  }

  async function reapWorker(pid) {
    if (!pid || !probeAlive(pid)) return "absent";
    try {
      kill(-pid, "SIGTERM");
    } catch {
      return "absent";
    }
    const deadline = Date.now() + stallGraceMs;
    while (probeAlive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, REAP_POLL_MS));
    if (!probeAlive(pid)) return "soft";
    try {
      kill(-pid, "SIGKILL");
    } catch {}
    return "hard";
  }

  function terminate(key, note, { graceMs = stallGraceMs } = {}) {
    const child = children.get(key);
    if (!child) return Promise.resolve("absent");
    notes.set(key, note);
    return new Promise((resolve) => {
      let done = false;
      const finish = (result) => {
        if (done) return;
        done = true;
        clearInterval(watch);
        clearTimeout(timer);
        resolve(result);
      };
      const watch = setInterval(() => {
        if (!children.has(key)) finish("soft");
      }, 250);
      const timer = setTimeout(() => {
        if (!children.has(key)) return finish("soft");
        try {
          kill(-child.pid, "SIGKILL");
        } catch {
          try {
            child.kill("SIGKILL");
          } catch {}
        }
        finish("hard");
      }, graceMs);
      watch.unref?.();
      timer.unref?.();
      try {
        kill(-child.pid, "SIGTERM");
      } catch {
        try {
          child.kill("SIGTERM");
        } catch {}
      }
    });
  }

  function cancel(key, note = "已按指令终止本轮") {
    if (!children.has(key)) return false;
    terminate(key, note).catch((error) => log("warn", "cancel-stop", String(error?.message ?? error)));
    return true;
  }

  return {
    state,
    save,
    handle,
    recover,
    onReady,
    cancel,
    applyAction,
    drainCommands,
    checkStall,
    scheduleJob,
    cancelScheduled,
    startDueJobs,
    startDueLoops,
    notices,
    prompts,
    stats: () => ({ running: running.size, pending: state.inbox.length }),
    pruneLogs: () => {
      const logs = pruneOldFiles(logDir, RETENTION_MS, now());
      pruneOldFiles(commandDir, COMMAND_TTL_MS, now());
      notices.prune();
      const rounds = pruneRounds(state.loopRuns, now());
      const roundsHistory = pruneHistory(loopHistoryDir, now());
      if (rounds) save();
      const jobs = pruneState(state, now());
      if (jobs) save();
      try {
        const pruned = adapter.prune?.();
        if (pruned && typeof pruned.catch === "function") pruned.catch((error) => log("warn", "prune", String(error?.message ?? error)));
      } catch (error) {
        log("warn", "prune", String(error?.message ?? error));
      }
      return { logs, jobs, rounds, roundsHistory };
    },
    log,
  };
}
