import { readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { spawn as spawnProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { runPrintWorker } from "./worker-print.mjs";
import { createRpcWorker, expandAttachments } from "./worker-rpc.mjs";
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
import { DELIVERY_RETRY_INTERVAL_MS, DELIVERY_RETRY_WINDOW_MS, deliveryError, hashOf, isRetryable, planParts } from "../jobs/delivery.mjs";
import { extractMedia } from "../jobs/media.mjs";
import { declaredTimeoutMs, headOfArgs, readSessionSignal, TOOL_GRACE_MS } from "../jobs/signals.mjs";
import { nextAction } from "../jobs/next-action.mjs";
import { createStateStore } from "../state/store.mjs";
import { createNoticeService } from "../notices/service.mjs";
import { NOTICE_TITLES } from "../notices/title.mjs";
import { RESTART_PROMPT, stallNoticePrompt, stallNoticeText } from "./stall-notice.mjs";
import { createPrompts } from "./prompts.mjs";
import { activeLoopCount, createLoop, isLoopId, normalizeLoopTitle, platformOfLoopId, validateLoopChange, validateLoopPromptSource, validateLoopTitle, validateSchedule } from "../loops/model.mjs";
import { resolveLoopPrompt } from "../loops/prompt.mjs";
import { LOOP_ROUNDS_PER_HOUR, loopLateMs, roundSkipReason, roundsInLastHour } from "../loops/schedule.mjs";
import { roundKeyFor, roundTitle, truncateOutput } from "../loops/round.mjs";
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
const STATUS_TEXT = { done: "完成", failed: "失败", retrying: "重试中", cancelled: "取消", interrupted: "被打断", queued: "排队", scheduled: "排定中" };
const BRIEF_MAX_BYTES = 8 * 1024;
const DEFAULT_GRACE_MS = 6 * 3_600_000;
const RUNAWAY_PER_HOUR = relayEnv("RUNAWAY_PER_HOUR", 12);
const REAP_POLL_MS = 50;
const RPC_IDLE_MS = relayEnv("RPC_IDLE_MS", 10 * 60_000);
const MAX_DELIVERY_ATTEMPTS = 3;
export const DELIVERY_BACKOFF_MS = [1_500, 5_000, 15_000];

export function createCore({ adapter, config, deps = {} }) {
  const now = deps.now ?? (() => Date.now());
  const instanceId = deps.instanceId ?? randomUUID();
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
  const deliveryBackoff = Number.isFinite(deps.deliveryRetryMs)
    ? DELIVERY_BACKOFF_MS.map(() => deps.deliveryRetryMs)
    : Array.isArray(deps.deliveryBackoffMs)
      ? deps.deliveryBackoffMs
      : DELIVERY_BACKOFF_MS;
  const store = deps.store ?? createStateStore({ file: config.stateFile(adapter.name), log });
  const loopHistoryDir = config.loopHistoryDir ?? join(config.configDir, "loops");
  const state = store.state;
  const save = store.save;
  const notices = deps.notices ?? createNoticeService({ state, save, adapter, now, log });
  const prompts = deps.prompts ?? createPrompts({ dir: config.promptsDir, userDir: config.userPromptsDir, log, cli: config.cli, configDir: config.configDir });
  const children = new Map();
  const stallTimers = new Map();
  const workers = new Map();
  const idleTimers = new Map();
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
    const activity = job.activity;
    if (activity && Number.isFinite(activity.at)) {
      return activity.open ? { kind: "tool", at: activity.at, tool: activity.open } : { kind: "entry", at: activity.at, tool: null };
    }
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
      task: state.convs?.[job.key]?.rootText || job.inbound?.rootText || "",
      round: job.inbound?.text ?? "",
      silenceMs,
      local: localStamp(at),
      reason: job.stallReason,
      tool,
    };
    try {
      const notice = await notices.emit({
        title: NOTICE_TITLES.stall,
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

  async function redeliver({ job: jobId = null, key = "" } = {}) {
    const target = (jobId ? state.jobs[jobId] : null) ?? latestJobFor(String(key || jobId || ""));
    if (!target || !target.answer) return { job: target?.id ?? null, key: String(key || jobId || ""), outcome: "nothing-to-redeliver" };
    target.status = "answered";
    target.error = undefined;
    target.deliveryAttempts = 0;
    target.updatedAt = isoNow();
    save();
    const status = await deliver(target);
    return { job: target.id, key: target.key, outcome: status };
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
          await notices.emit({ text: command.text, prompt: command.prompt ?? "", reply: command.reply ?? null, title: command.title ?? "" });
        } else if (command.op === "schedule") {
          const outcome = scheduleJob(command);
          appendLog({ event: "command-schedule", ...outcome, key: String(command.key ?? "") });
        } else if (command.op === "cancel") {
          const outcome = cancelScheduled(command);
          appendLog({ event: "command-cancel", ...outcome, dedupe: String(command.dedupe ?? "") });
        } else if (command.op === "redeliver") {
          const outcome = await redeliver(command);
          appendLog({ event: "command-redeliver", ...outcome });
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

  function optInTimeoutMs() {
    const configured = Number(adapter.timeoutMs ?? 0);
    return Number.isFinite(configured) && configured > 0 ? configured : null;
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
          job.loopRoundStatus = "failed";
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

  function workerMode() {
    return adapter.workerMode === "rpc" ? "rpc" : "print";
  }

  function armStallTimer(job, key) {
    const timer = setInterval(() => {
      checkStall(job).catch((error) => log("warn", "stall", String(error?.message ?? error)));
    }, STALL_CHECK_MS);
    timer.unref?.();
    stallTimers.set(key, timer);
  }

  function disarmStallTimer(key) {
    const timer = stallTimers.get(key);
    if (timer) clearInterval(timer);
    stallTimers.delete(key);
  }

  function startProgress(job) {
    const progressPromise = Promise.resolve(adapter.onProgress?.(ctxOf(job)))
      .then((progress) => {
        if (!progress) return;
        job.progress = progress;
        job.updatedAt = isoNow();
        save();
      })
      .catch((error) => log("warn", "progress", String(error?.message ?? error)));
    void progressPromise;
  }

  function spawnWorker(job, entry, inbound, prompt, full) {
    const refs = (inbound.attachments ?? []).map((attachment) => `@${attachment.path}`);
    const args = adapter.worker === "stub" ? ["-e", `console.log("[stub] session=${entry.session} full=${full}")`] : ["--print", "--session-id", entry.session, "--", ...refs, prompt];
    const bin = adapter.worker === "stub" ? process.execPath : adapter.piBin;
    const command = adapter.buildWorker ? adapter.buildWorker({ prompt, full, session: entry.session }) : { bin, args };
    const started = now();
    const timeoutMs = optInTimeoutMs();
    const mode = workerMode();
    const env = { ...process.env, AGENT_RELAY_SELF_CHAIN: String(job.chain ?? 0) };
    appendLog({ event: "dispatch", job: job.id, key: inbound.key, session: entry.session, full, mode });
    if (mode === "rpc" && adapter.worker !== "stub") return runRpcJob(job, entry, inbound, prompt, full);

    return new Promise((resolve) => {
      const settle = (result) => resolve(finishJob(job, entry, inbound, { started, timeoutMs, ...result }));
      const onSpawn = (handle) => {
        children.set(inbound.key, handle);
        job.lease = { pid: handle.pid ?? null, startTicks: handle.pid ? readStartTicks(handle.pid) : null, startedAt: now() };
        job.startedAt = started;
        job.updatedAt = isoNow();
        save();
        armStallTimer(job, inbound.key);
        startProgress(job);
      };
      runPrintWorker({
        config,
        command,
        env,
        timeoutMs,
        onSpawn,
        onTimeout: () => {
          terminate(inbound.key, "").catch((error) => log("warn", "timeout-stop", String(error?.message ?? error)));
        },
        onClose: settle,
        deps: { spawn },
      });
    });
  }

  async function finishJob(job, entry, inbound, { code, killed, stdout, stderr, started, timeoutMs }) {
    const body = String(stdout ?? "").trim();
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
      return;
    }
    const text = note
      ? note
      : killed
        ? `已终止：本轮超过 ${Math.round(timeoutMs / 60_000)} 分钟未结束。回复「继续」可以接着做，前面已完成的改动都在。\n\n${body.slice(-1500)}`.trim()
        : body || `[无输出] exit=${code}\n${String(stderr ?? "").trim().split("\n").slice(-10).join("\n")}`;
    const status = note ? "cancelled" : killed || code !== 0 ? "failed" : "answered";
    await applyWorkerResult(job, entry, inbound, { text, status, started, mode: "print", exit: code, killed });
  }

  function isAnswerSegment(reason, text) {
    if (reason !== "stop" && reason !== "length") return false;
    return String(text ?? "").trim().length > 0;
  }

  async function sendAnswerSegment(job, segment, run) {
    const media = mediaFor({ answer: segment.text });
    const plan = planParts({ answer: media ? media.text : segment.text, parts: [], chunkLimit: adapter.chunkLimit, canEdit: false, media });
    try {
      let sent = 0;
      for (const step of plan) {
        if (step.action === "skip") continue;
        if (step.kind === "media") await adapter.postMedia(ctxOf(job), step.files);
        else await replyNow(job, step.text);
        sent += 1;
      }
      appendLog({ event: "answer-sent", job: job.id, key: job.key, index: segment.index, chars: segment.text.length, parts: sent });
    } catch (error) {
      run.undelivered.push(segment.text);
      appendLog({ event: "answer-failed", job: job.id, key: job.key, index: segment.index, error: String(error?.message ?? error) });
    }
  }

  async function replyNow(job, text) {
    let failure = null;
    for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt += 1) {
      try {
        await adapter.reply(ctxOf(job), text);
        return;
      } catch (error) {
        failure = error;
        if (!isRetryable(error)) break;
        if (attempt < MAX_DELIVERY_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, deliveryBackoff[Math.min(attempt - 1, deliveryBackoff.length - 1)] ?? 0));
        }
      }
    }
    throw failure;
  }

  async function applyWorkerResult(job, entry, inbound, { text, status, started, mode = "print", exit = 0, killed = false, empty = false }) {
    disarmStallTimer(inbound.key);
    children.delete(inbound.key);
    appendLog({ event: "done", job: job.id, key: inbound.key, session: entry.session, exit, killed, elapsedMs: now() - started, mode });
    if (empty && isScheduled(job)) {
      job.answer = null;
      job.status = "done";
      job.lease = null;
      job.updatedAt = isoNow();
      save();
      appendLog({ event: "job-empty", job: job.id, key: inbound.key });
      runtimeInbounds.delete(job.id);
      return;
    }
    job.answer = text;
    job.status = status;
    job.lease = null;
    job.updatedAt = isoNow();
    if (job.origin === "loop") {
      job.loopOutput = text;
      job.loopRoundStatus = status;
    }
    save();
    if (job.origin === "loop") await deliverRound(job);
    else await deliver(job);
    await dropReceipts(job);
    if (job.origin === "loop") await finishRound(job);
    runtimeInbounds.delete(job.id);
  }

  function timeoutOfArgs(args) {
    const seconds = Number(args?.timeout);
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
  }

  function clearIdleTimer(key) {
    const timer = idleTimers.get(key);
    if (timer) clearTimeout(timer);
    idleTimers.delete(key);
  }

  function scheduleIdleClose(key) {
    clearIdleTimer(key);
    const timer = setTimeout(() => {
      idleTimers.delete(key);
      if (keyIsBusy(key)) return;
      const worker = workers.get(key);
      if (!worker) return;
      workers.delete(key);
      worker.close().catch((error) => log("warn", "rpc-idle-close", String(error?.message ?? error)));
    }, RPC_IDLE_MS);
    timer.unref?.();
    idleTimers.set(key, timer);
  }

  async function acquireWorker(key, session, chain) {
    clearIdleTimer(key);
    let worker = workers.get(key);
    if (worker && !worker.exited()) return worker;
    if (worker) workers.delete(key);
    worker = createRpcWorker({
      bin: adapter.worker === "stub" ? process.execPath : adapter.piBin,
      session,
      cwd: config.cwd,
      env: { ...process.env, AGENT_RELAY_SELF_CHAIN: String(chain ?? 0) },
      log,
      deps: { spawn },
    });
    workers.set(key, worker);
    const snapshot = await worker.state();
    if (snapshot?.sessionId && snapshot.sessionId !== session) {
      const file = sessionFileFor(session);
      if (file) await worker.command("switch_session", { sessionPath: file });
      else await worker.command("new_session", {});
    }
    return worker;
  }

  function runRpcJob(job, entry, inbound, prompt, full) {
    const key = inbound.key;
    const started = now();
    const timeoutMs = optInTimeoutMs();
    return (async () => {
      let worker;
      try {
        worker = await acquireWorker(key, entry.session, job.chain);
      } catch (error) {
        log("error", "rpc-handshake", String(error?.message ?? error));
        return applyWorkerResult(job, entry, inbound, {
          text: `[无输出] stop=rpc-handshake\n${String(error?.message ?? error)}`,
          status: "failed",
          started,
          mode: "rpc",
        });
      }
      const run = { text: "", stopReason: null, segments: [], undelivered: [], sending: Promise.resolve(), index: 0 };
      const deliverSegments = job.origin === "user";
      let settle;
      const settled = new Promise((resolve) => (settle = resolve));
      const offEvent = worker.onEvent((record) => {
        if (record.type === "agent_settled") {
          settle({ aborted: Boolean(record.aborted) });
          return;
        }
        if (record.type === "tool_execution_start") {
          job.activity = { at: now(), open: { name: record.toolName ?? null, startedAt: now(), declaredMs: record.toolName === "bash" ? timeoutOfArgs(record.args) : null, callIds: [record.toolCallId].filter(Boolean), head: headOfArgs(record.args), tools: [] } };
          return;
        }
        if (record.type === "tool_execution_end") {
          job.activity = { at: now(), open: null };
          return;
        }
        if (record.type === "turn_start" || record.type === "message_start" || record.type === "message_update" || record.type === "turn_end") {
          job.activity = { at: now(), open: job.activity?.open ?? null };
          return;
        }
        if (record.type === "message_end" && record.message?.role === "assistant") {
          const content = Array.isArray(record.message.content) ? record.message.content : [];
          const reason = record.message.stopReason ?? null;
          const text = content.filter((part) => part && part.type === "text").map((part) => part.text).join("");
          if (reason && reason !== "toolUse") {
            run.text = text;
            run.stopReason = reason;
          }

          if (!isAnswerSegment(reason, text)) return;
          run.index += 1;
          const segment = { index: run.index, text, stopReason: reason };
          run.segments.push(segment);
          appendLog({ event: "answer-segment", job: job.id, key: job.key, index: segment.index, chars: text.length, stopReason: reason });
          if (reason === "length") appendLog({ event: "answer-truncated", job: job.id, key: job.key, index: segment.index });
          if (!deliverSegments) return;
          run.sending = run.sending.then(() => sendAnswerSegment(job, segment, run));
        }
      });
      const offExit = worker.onExit(({ code, signal }) => settle({ exit: true, code, signal }));
      children.set(key, worker);
      job.lease = { pid: worker.pid ?? null, startTicks: worker.pid ? readStartTicks(worker.pid) : null, startedAt: now() };
      job.startedAt = started;
      job.activity = { at: now(), open: null };
      job.updatedAt = isoNow();
      save();
      armStallTimer(job, key);
      startProgress(job);
      const timer = timeoutMs === null ? null : setTimeout(() => {
        terminate(key, "").catch((error) => log("warn", "timeout-stop", String(error?.message ?? error)));
      }, timeoutMs);

      let disposition = "started";
      try {
        disposition = await worker.prompt(expandAttachments({ prompt, attachments: inbound.attachments }));
      } catch (error) {
        if (timer) clearTimeout(timer);
        offEvent();
        offExit();
        return applyWorkerResult(job, entry, inbound, {
          text: `[无输出] stop=rpc-prompt\n${String(error?.message ?? error)}`,
          status: "failed",
          started,
          mode: "rpc",
        });
      }

      const outcome = disposition === "handled" ? { handled: true } : await settled;
      await run.sending;
      if (timer) clearTimeout(timer);
      offEvent();
      offExit();
      scheduleIdleClose(key);
      const note = notes.get(key);
      notes.delete(key);
      await drainUnconsumedSteers(job, worker);
      if (note) return applyWorkerResult(job, entry, inbound, { text: note, status: "cancelled", started, mode: "rpc" });
      if (outcome.handled) return applyWorkerResult(job, entry, inbound, { text: "[无输出] stop=handled", status: "answered", started, mode: "rpc", empty: true });
      if (outcome.exit) {
        const tail = worker.stderrTail().trim().split("\n").slice(-10).join("\n");
        const text = `[无输出] exit=${outcome.code ?? "signal"}${tail ? `\n${tail}` : ""}`;
        return applyWorkerResult(job, entry, inbound, { text, status: "failed", started, mode: "rpc", exit: outcome.code ?? null, killed: true });
      }
      const pendingAnswer = run.undelivered.join("\n\n");
      const deliveredSegments = deliverSegments && run.segments.length > 0;
      if (outcome.aborted || run.stopReason === "error") {
        return applyWorkerResult(job, entry, inbound, {
          text: pendingAnswer || (deliveredSegments ? null : run.text || `[无输出] stop=${run.stopReason ?? "aborted"}`),
          status: "failed",
          started,
          mode: "rpc",
        });
      }
      if (pendingAnswer) return applyWorkerResult(job, entry, inbound, { text: pendingAnswer, status: "answered", started, mode: "rpc" });
      if (deliveredSegments) return applyWorkerResult(job, entry, inbound, { text: null, status: "answered", started, mode: "rpc" });
      if (!run.text) return applyWorkerResult(job, entry, inbound, { text: `[无输出] stop=${run.stopReason ?? "stop"}`, status: "answered", started, mode: "rpc", empty: true });
      return applyWorkerResult(job, entry, inbound, { text: run.text, status: "answered", started, mode: "rpc" });
    })();
  }

  async function drainUnconsumedSteers(job, worker) {
    const pending = (job.steers ?? []).filter((steer) => !steer.consumed);
    if (!pending.length) return;
    let snapshot = null;
    try {
      snapshot = await worker.state();
    } catch (error) {
      log("warn", "steer-state", String(error?.message ?? error));
    }
    if (!snapshot || !snapshot.pendingMessageCount) {
      for (const steer of pending) steer.consumed = true;
      save();
      return;
    }
    try {
      await worker.command("clear_queue");
    } catch (error) {
      log("warn", "steer-clear", String(error?.message ?? error));
    }
    for (const steer of pending) steer.consumed = true;
    await dropReceipts(job);
    const text = pending.map((steer) => steer.text).filter(Boolean).join("\n\n");
    const messageId = pending.map((steer) => steer.messageId).filter(Boolean).at(-1) ?? job.inbound?.messageId ?? null;
    save();
    if (!text) return;
    const inbound = {
      ...job.inbound,
      key: job.key,
      session: job.session,
      noticeId: null,
      dedupeId: `steer-resend-${job.id}-${pending.length}`,
      text,
      rootText: job.inbound?.rootText ?? text,
      messageId,
      attachments: [],
    };
    const next = createJob(state, inbound, isoNow);
    next.auto = "steer-resend";
    state.jobs[next.id] = next;
    state.inbox.push(next.id);
    state.seen[inbound.dedupeId] = next.id;
    save();
    appendLog({ event: "steer-resend", job: next.id, from: job.id, key: job.key });
    drainInbox();
  }

  function describeDeliveryFailure(error) {
    const message = String(error?.message ?? error ?? "reply-failed");
    return error?.code && !message.includes(String(error.code)) ? `${error.code}: ${message}` : message;
  }

  function mediaFor(job) {
    if (typeof adapter.postMedia !== "function") return null;
    const media = extractMedia(job.answer ?? "");
    return media.files.length || media.invalid.length ? media : null;
  }

  async function deliverParts(job) {
    const canEdit = typeof adapter.edit === "function";
    const canLocate = typeof adapter.locateReply === "function";
    const media = mediaFor(job);
    if (job.answer == null && !media) return;
    const plan = planParts({ answer: media ? media.text : job.answer ?? "", parts: job.parts, chunkLimit: adapter.chunkLimit, canEdit, media });
    for (const step of plan) {
      if (step.action === "skip") continue;
      try {
        if (step.action === "locate-or-send") {
          const located = canLocate ? await adapter.locateReply(ctxOf(job), { text: step.text, since: step.since }) : null;
          if (located) {
            job.parts = [...job.parts.filter((part) => part.i !== step.i), { i: step.i, messageId: String(located), hash: hashOf(step.text), sentAt: isoNow(), located: true }];
            job.updatedAt = isoNow();
            save();
            appendLog({ event: "delivery-located", job: job.id, key: job.key, part: step.i, messageId: String(located) });
            continue;
          }
          appendLog({ event: canLocate ? "delivery-locate-missed" : "delivery-no-locator", job: job.id, key: job.key, part: step.i });
        }
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
          if (!sent?.messageId) throw deliveryError("reply returned no messageId", { code: "no-message-id" });
          job.parts = [...job.parts.filter((part) => part.i !== step.i), { i: step.i, messageId: String(sent.messageId), hash: hashOf(step.text), sentAt: isoNow() }];
        }
        job.updatedAt = isoNow();
        save();
      } catch (error) {
        job.parts = [
          ...job.parts.filter((part) => part.i !== step.i),
          { i: step.i, messageId: null, hash: hashOf(step.text ?? ""), sentAt: isoNow(), uncertainSince: job.parts.find((part) => part.i === step.i)?.uncertainSince ?? now() },
        ];
        save();
        log("error", "reply", String(error?.message ?? error));
        throw error;
      }
    }
    return true;
  }

  async function deliver(job) {
    let failure = null;
    for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt += 1) {
      try {
        await deliverParts(job);
        failure = null;
        if (attempt > 1) appendLog({ event: "delivery-retried", job: job.id, key: job.key, attempts: attempt - 1 });
        break;
      } catch (error) {
        failure = error;
        job.deliveryAttempts = (job.deliveryAttempts ?? 0) + 1;
        job.deliveryFailedAt = job.deliveryFailedAt ?? isoNow();
        job.deliveryError = describeDeliveryFailure(error);
        save();
        appendLog({ event: "delivery-failed", job: job.id, key: job.key, attempt, part: uncertainPartOf(job), retryable: isRetryable(error), error: String(error?.message ?? error) });
        if (!isRetryable(error)) break;
        if (attempt < MAX_DELIVERY_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, deliveryBackoff[Math.min(attempt - 1, deliveryBackoff.length - 1)] ?? 0));
      }
    }
    const failed = Boolean(failure);
    if (!failed) {
      job.deliveryAttempts = 0;
      job.deliveryFailedAt = undefined;
      job.deliveryError = undefined;
      job.deliveryRetryAt = undefined;
    }
    try {
      await adapter.onProgressDone?.(ctxOf(job));
    } catch (error) {
      log("warn", "progress-done", String(error?.message ?? error));
    }
    job.progress = null;
    if (failed && job.status === "answered") {
      const windowLeft = deliveryRetryWindowLeft(job);
      if (isRetryable(failure) && windowLeft > 0) {
        job.status = "retrying";
        job.deliveryRetryAt = isoAt(now() + Math.min(DELIVERY_RETRY_INTERVAL_MS, windowLeft));
        appendLog({ event: "delivery-retry-scheduled", job: job.id, key: job.key, at: job.deliveryRetryAt });
      } else {
        job.status = "failed";
        job.error = "reply-failed";
        await announceUndelivered(job);
      }
    } else if (!failed && job.status === "answered") {
      job.status = "done";
      job.answer = undefined;
    }
    job.updatedAt = isoNow();
    save();
    return job.status;
  }

  function uncertainPartOf(job) {
    const uncertain = (job.parts ?? []).filter((part) => part.uncertainSince);
    return uncertain.length ? Math.max(...uncertain.map((part) => part.i)) : null;
  }

  function deliveryRetryWindowLeft(job) {
    const firstFailedAt = Date.parse(job.deliveryFailedAt ?? "");
    if (!Number.isFinite(firstFailedAt)) return 0;
    return DELIVERY_RETRY_WINDOW_MS - (now() - firstFailedAt);
  }

  async function announceUndelivered(job) {
    try {
      await notices.emit({
        text: `上一轮的回复没送出去（${job.deliveryError ?? "平台连接失败"}）。内容还在，\`agent-relay job redeliver ${job.key}\` 可以补发。`,
        reply: { mode: "conversation", key: job.key },
      });
      appendLog({ event: "delivery-gave-up", job: job.id, key: job.key, notified: true });
    } catch (error) {
      appendLog({ event: "delivery-notice-failed", job: job.id, key: job.key, error: String(error?.message ?? error) });
    }
  }

  function startJob(job) {
    const entry = state.convs[job.key] ?? { session: job.session, rootText: job.inbound.rootText, lastMsgTs: null, activeJob: null };
    entry.activeJob = job.id;
    state.convs[job.key] = entry;
    job.status = "running";
    job.instanceId = instanceId;
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
      .finally(async () => {
        running.delete(job.id);
        if (entry.activeJob === job.id) entry.activeJob = null;
        await dropReceipts(job);
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
      try {
        if (isFinished(job) || job.status === "interrupted") {
          if (state.inbox.includes(job.id)) state.inbox = state.inbox.filter((id) => id !== job.id);
          continue;
        }
        if (job.instanceId === instanceId) continue;
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
        if (action.type === "retry-delivery") {
          job.status = "answered";
          await deliver(job);
          touched += 1;
          continue;
        }
        job.answer = undefined;
        job.progress = null;
        touched += 1;
      } catch (error) {
        log("error", "recover-job", job.id, String(error?.message ?? error));
      }
    }
    pauseLegacySchedules();
    if (touched) save();
    drainInbox();
    return touched;
  }

  function pauseLegacySchedules() {
    const legacy = Object.values(state.loops ?? {}).filter((loop) => loop && loop.state === "armed" && !String(loop.cron ?? "").trim());
    if (!legacy.length) return 0;
    for (const loop of legacy) {
      loop.state = "paused";
      notices
        .emit({ text: `${loop.id} 用的是已移除的 every / at schedule，已暂停；用 --cron 重建后再 loop resume。`, title: NOTICE_TITLES.pause })
        .catch((error) => log("warn", "legacy-schedule-notice", String(error?.message ?? error)));
    }
    save();
    log("warn", "legacy-schedule-paused", legacy.map((loop) => loop.id).join(","));
    return legacy.length;
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
      const notice = await notices.emit({ text: bootNoticeText(at, localStamp), title: NOTICE_TITLES.boot });
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
    const source = resolveLoopPrompt(loop);
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
    job.loop = {
      id: loop.id,
      title: loop.title ?? null,
      round,
      prompt: source.text ?? "",
      promptFile: loop.promptFile ?? null,
      last: loopLastLine(loop),
      trigger,
      lateMs,
    };
    loop.lastRound = round;
    loop.lastRunId = runId;
    loop.lastRunAt = isoAt(at);
    loop.lastOutcome = null;
    state.meta.loopRoundStamps = [...(state.meta.loopRoundStamps ?? []), isoAt(at)].slice(-400);
    save();
    appendLog({ event: "loop-round", loop: loop.id, runId, job: job.id, trigger, lateMs });
    if (source.error) {
      job.status = "failed";
      job.error = source.error;
      job.loopRoundStatus = "failed";
      job.updatedAt = isoNow();
      save();
      appendLog({ event: "prompt-source", loop: loop.id, runId, error: source.error, path: loop.promptFile ?? null });
      await finishRound(job);
      return job;
    }
    drainInbox();
    return job;
  }

  function isNoopRound(text) {
    const body = String(text ?? "").trim();
    return !body || body === "NOOP" || body.startsWith("[无输出]");
  }

  async function deliverRound(job) {
    const text = String(job.answer ?? "").trim();
    if (isNoopRound(text)) {
      job.status = "done";
      job.noop = true;
      job.answer = undefined;
      job.updatedAt = isoNow();
      save();
      appendLog({ event: "round-noop", job: job.id, key: job.key, bytes: Buffer.byteLength(text) });
      return job.status;
    }
    for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt += 1) {
      try {
        const notice = await notices.emit({
          text,
          title: roundTitle(job.loop, job.loop.round),
          reply: { mode: "conversation", key: job.key },
        });
        job.noticeId = notice.id;
        job.parts = [{ i: 0, messageId: notice.messageId ?? null, hash: hashOf(text), sentAt: isoNow() }];
        job.status = "done";
        job.answer = undefined;
        job.updatedAt = isoNow();
        save();
        return job.status;
      } catch (error) {
        log("warn", "round-deliver", `attempt=${attempt}`, String(error?.message ?? error));
        job.deliveryAttempts = attempt;
        job.deliveryFailedAt = isoNow();
        if (attempt < MAX_DELIVERY_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, deliveryBackoff[Math.min(attempt - 1, deliveryBackoff.length - 1)] ?? 0));
      }
    }
    job.status = "failed";
    job.error = job.error ?? "reply-failed";
    job.updatedAt = isoNow();
    save();
    return job.status;
  }

  async function finishRound(job) {
    const loop = state.loops?.[job.loop?.id];
    const runId = roundKeyFor(job.loop.id, job.loop.round);
    const messageId = job.parts?.[0]?.messageId ?? null;
    const roundOk = job.loopRoundStatus !== "failed";
    const noop = Boolean(job.noop);
    const delivered = job.status === "done" && !noop;
    const outcome = noop && roundOk ? "noop" : roundOk && delivered && messageId ? "ok" : "failed";
    if (outcome === "failed" && !job.error) job.error = roundOk ? (delivered ? "no-message-id" : "reply-failed") : job.loopRoundStatus ?? "failed";
    if (loop) {
      loop.lastMessageId = messageId;
      loop.lastOutcome = outcome;
      loop.failStreak = outcome === "failed" ? Number(loop.failStreak ?? 0) + 1 : 0;
      if (loop.failStreak >= 3 && loop.state === "armed") {
        loop.state = "paused";
        notices
          .emit({ text: `${loop.id} 连续 ${loop.failStreak} 轮失败，已暂停：${job.error ?? outcome}`, title: NOTICE_TITLES.pause })
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

  function handleBoundReply(inbound, key) {
    const keyed = { ...inbound, key, session: adapter.sessionFor(key), rootText: state.convs[key]?.rootText ?? inbound.text };
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
    appendLog({ event: "bound-reply", job: job.id, key });
    drainInbox();
    return "accepted";
  }

  function throttleNotice() {
    const at = Date.parse(state.meta.loopThrottleAt ?? "");
    if (Number.isFinite(at) && now() - at < 3_600_000) return;
    state.meta.loopThrottleAt = isoAt(now());
    save();
    notices
      .emit({ text: `本平台这一小时的 loop 轮数已到上限（${LOOP_ROUNDS_PER_HOUR}），后面的轮次跳过。`, title: NOTICE_TITLES.throttle })
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
      if (reason === "busy") {
        loop.lastSkipAt = isoAt(at);
        save();
        appendLog({ event: "loop-skip", loop: loop.id, at: isoAt(at) });
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
      const id = String(command.id ?? "");
      if (!isLoopId(id) || platformOfLoopId(id) !== adapter.name) return { op, refused: "bad-loop-id" };
      const promptFile = String(command.promptFile ?? "").trim();
      const allowInline = Boolean(command.promptInline);
      const refused =
        validateSchedule({ cron: command.cron }) ??
        validateLoopTitle(command.title) ??
        validateLoopPromptSource({ id, prompt: command.prompt, promptFile, configDir: config.configDir, allowInline });
      if (refused) return { op, refused };
      if (loops[id]) return { op, refused: "duplicate", id };
      if (activeLoopCount(loops) >= 20) return { op, refused: "too-many-loops" };
      loops[id] = createLoop({
        id,
        prompt: command.prompt,
        promptFile,
        promptInline: allowInline,
        cron: command.cron ?? null,
        thread: command.thread !== false,
        title: command.title ?? null,
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
      if (command.cron !== undefined) {
        const refused = validateSchedule({ cron: command.cron });
        if (refused) return { op, refused };
        loop.cron = command.cron;
        loop.lastSkipAt = null;
      }
      if (command.promptFile !== undefined || command.prompt !== undefined) {
        const promptFile = String(command.promptFile ?? "").trim();
        const allowInline = Boolean(command.promptInline);
        const refused = validateLoopPromptSource({ id: loop.id, prompt: command.prompt, promptFile, configDir: config.configDir, allowInline });
        if (refused) return { op, refused };
        if (promptFile) {
          loop.promptFile = promptFile;
          loop.prompt = "";
          loop.promptInline = false;
        } else {
          loop.promptFile = null;
          loop.prompt = String(command.prompt ?? "").trim();
          loop.promptInline = Boolean(loop.prompt);
        }
      }
      if (command.title !== undefined) {
        const refused = validateLoopTitle(command.title);
        if (refused) return { op, refused };
        loop.title = normalizeLoopTitle(command.title);
      }
      if (command.thread !== undefined) loop.thread = command.thread !== false;
      save();
      return { op, id: loop.id };
    }
    return { op, refused: "unknown-op" };
  }

  async function startDueDeliveries() {
    for (const job of Object.values(state.jobs ?? {})) {
      if (job.status !== "retrying") continue;
      const due = Date.parse(job.deliveryRetryAt ?? "");
      if (Number.isFinite(due) && due > now()) continue;
      if (keyIsBusy(job.key)) continue;
      job.status = "answered";
      job.updatedAt = isoNow();
      save();
      await deliver(job);
      return 1;
    }
    return 0;
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
    if (notice.reply?.mode === "conversation" && notice.reply.key) return handleBoundReply(inbound, notice.reply.key);
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

  function adapterSteerEnabled() {
    return adapter.steer !== "off" && adapter.steer !== false;
  }

  async function steerTarget(inbound) {
    if (workerMode() !== "rpc" || adapter.worker === "stub") return null;
    if (!adapterSteerEnabled()) return null;
    const worker = workers.get(inbound.key);
    if (!worker || worker.exited()) return null;
    const activeId = state.convs[inbound.key]?.activeJob;
    const active = activeId ? state.jobs[activeId] : null;
    if (!active || isFinished(active) || active.origin !== "user") return null;
    try {
      const snapshot = await worker.state();
      return snapshot?.isStreaming ? { worker, job: active } : null;
    } catch (error) {
      log("warn", "steer-state", String(error?.message ?? error));
      return null;
    }
  }

  async function addReceipt(inbound) {
    if (typeof adapter.addReceipt !== "function") return null;
    try {
      const receipt = await adapter.addReceipt({ messageId: inbound.messageId ?? null, chatId: inbound.chatId ?? null, threadId: inbound.threadId ?? null });
      return receipt ? { ...receipt, messageId: receipt.messageId ?? inbound.messageId ?? null } : null;
    } catch (error) {
      log("warn", "receipt-add", String(error?.message ?? error));
      return null;
    }
  }

  async function dropReceipts(job) {
    const receipts = job.receipts ?? [];
    job.receipts = [];
    if (!receipts.length) return;
    for (const receipt of receipts) {
      try {
        await adapter.removeReceipt?.({ messageId: receipt.messageId ?? null, receipt });
      } catch (error) {
        log("warn", "receipt-remove", String(error?.message ?? error));
      }
    }
  }

  async function deliveredAsSteer(inbound) {
    const target = await steerTarget(inbound);
    if (!target) return false;
    state.seen[inbound.dedupeId] = target.job.id;
    const payload = expandAttachments({ prompt: inbound.text, attachments: inbound.attachments });
    let disposition = null;
    try {
      disposition = await target.worker.steer(payload);
    } catch (error) {
      log("warn", "steer", String(error?.message ?? error));
    }
    if (!disposition) {
      delete state.seen[inbound.dedupeId];
      return false;
    }
    const receipt = await addReceipt(inbound);
    target.job.steers = [...(target.job.steers ?? []), { ts: inbound.dedupeId, messageId: inbound.messageId ?? null, at: isoNow(), text: inbound.text, chars: String(inbound.text ?? "").length, disposition, consumed: false }];
    if (receipt) {
      target.job.receipts = [...(target.job.receipts ?? []), receipt];
      if (isFinished(target.job)) await dropReceipts(target.job);
    }
    target.job.updatedAt = isoNow();
    save();
    appendLog({ event: "steer", job: target.job.id, key: inbound.key, chars: String(inbound.text ?? "").length, disposition });
    return true;
  }

  async function handle(inbound) {
    if (adapter.allowedUser && inbound.authorId && inbound.authorId !== adapter.allowedUser) {
      log("ignore", "author", inbound.authorId);
      return "ignored";
    }
    const known = state.seen[inbound.dedupeId];
    const notice = notices.match(inbound.replyIds ?? []);
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
    if (await deliveredAsSteer(inbound)) return "steered";

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
    startDueDeliveries,
    startDueLoops,
    notices,
    prompts,
    redeliver,
    stats: () => ({ running: running.size, pending: state.inbox.length }),
    pruneLogs: () => {
      const logs = pruneOldFiles(logDir, RETENTION_MS, now());
      pruneOldFiles(commandDir, COMMAND_TTL_MS, now());
      const roundsHistory = pruneHistory(loopHistoryDir, now());
      const jobs = pruneState(state, now());
      if (jobs) save();
      try {
        const pruned = adapter.prune?.();
        if (pruned && typeof pruned.catch === "function") pruned.catch((error) => log("warn", "prune", String(error?.message ?? error)));
      } catch (error) {
        log("warn", "prune", String(error?.message ?? error));
      }
      return { logs, jobs, roundsHistory };
    },
    log,
  };
}
