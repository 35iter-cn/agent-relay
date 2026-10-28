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
import { declaredTimeoutMs, readSessionSignal, TOOL_GRACE_MS } from "../jobs/signals.mjs";
import { nextAction } from "../jobs/next-action.mjs";
import { createStateStore } from "../state/store.mjs";
import { createNoticeService } from "../notices/service.mjs";
import { RESTART_PROMPT, stallNoticePrompt, stallNoticeText } from "./stall-notice.mjs";
import { createPrompts } from "./prompts.mjs";

const STALL_MS = relayEnv("STALL_MS", 10 * 60_000);
const TOOL_STALL_MS = relayEnv("TOOL_STALL_MS", 10 * 60_000);
const STALL_CHECK_MS = 60_000;
const RETENTION_MS = 72 * 3_600_000;
const SEEN_RETENTION_MS = 72 * 3_600_000;
const MAX_SEEN = 5000;
const COMMAND_TTL_MS = 10 * 60_000;
const INTERRUPT_NOTICE = "⏸ 这一轮被 relay 重启打断：还在跑的进程已终止，会话与已完成的改动都保留，被打断那轮没发出来的输出不补发。直接回复这条消息就会接着之前的会话继续。";
const ACTION_KINDS = { cancel: true, restart: true };
const STATUS_TEXT = { done: "完成", failed: "失败", cancelled: "取消", interrupted: "被打断", queued: "排队" };
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
  const jev = deps.jev ?? null;
  const usage = deps.usage ?? null;
  const stallGraceMs = deps.stallGraceMs ?? 5_000;
  const deliveryRetryMs = deps.deliveryRetryMs ?? DELIVERY_RETRY_MS;
  const store = deps.store ?? createStateStore({ file: config.stateFile(adapter.name), log });
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

  function buildPrompt(job, entry) {
    const inbound = runtimeInbound(job);
    const root = entry.rootText || inbound.text;
    const base = { platform: adapter.name, adapter, inbound, root, running: runningJobs() };
    if (job.noticeId) {
      const notice = notices.get(job.noticeId);
      if (notice) return prompts.noticeReply({ ...base, notice });
    }
    if (prompts.variant(root) === "candidate" || typeof jev?.judgeChoice !== "function") return prompts.conversation(base);
    return jev.judgeChoice({
      id: "prompt-variant",
      state: root,
      instructions: "要给这条消息拼装 prompt 模板，应该选哪个变体？",
      criteria: {
        candidate_rules: "在播报新候选任务，带候选编号或任务链接",
        task_skeleton: "用户在给指令、表态或提问，不是在播报候选",
      },
    }).then((verdict) => prompts.conversation({ ...base, variant: verdict?.choice === "candidate_rules" ? "candidate" : "task" }));
  }

  function execute(job, entry) {
    const inbound = runtimeInbound(job);
    const full = !hasSession(entry.session);
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
    appendLog({ event: "dispatch", job: job.id, key: inbound.key, session: entry.session, full });

    return new Promise((resolve) => {
      const child = spawn(command.bin, command.args, {
        cwd: config.cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
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
      }, adapter.timeoutMs);
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
        const text = note
          ? note
          : killed
            ? `已终止：本轮超过 ${Math.round(adapter.timeoutMs / 60_000)} 分钟未结束。回复「继续」可以接着做，前面已完成的改动都在。\n\n${body.slice(-1500)}`.trim()
            : body || `[无输出] exit=${code}\n${stderr.trim().split("\n").slice(-10).join("\n")}`;
        job.answer = text;
        job.status = note ? "cancelled" : killed || code !== 0 ? "failed" : "answered";
        job.lease = null;
        job.updatedAt = isoNow();
        save();
        await deliver(job);
        usage?.recordRun({
          job,
          platform: adapter.name,
          key: inbound.key,
          session: entry.session,
          answer: text,
          status: job.status,
          startedAt: job.startedAt ?? Date.parse(job.createdAt),
        });
        runtimeInbounds.delete(job.id);
        resolve();
      });
    });
  }

  async function deliverParts(job) {
    const canEdit = typeof adapter.edit === "function";
    const plan = planParts({ answer: job.answer ?? "", parts: job.parts, chunkLimit: adapter.chunkLimit, canEdit });
    for (const step of plan) {
      if (step.action === "skip") continue;
      try {
        if (step.action === "edit") {
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
    job.status = "interrupted";
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
      const action = nextAction(job, { canEdit, chunkLimit: adapter.chunkLimit, readStartTicks, probeAlive });
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
    notices,
    prompts,
    stats: () => ({ running: running.size, pending: state.inbox.length }),
    pruneLogs: () => {
      const logs = pruneOldFiles(logDir, RETENTION_MS, now());
      pruneOldFiles(commandDir, COMMAND_TTL_MS, now());
      notices.prune();
      const jobs = pruneState(state, now());
      if (jobs) save();
      try {
        const pruned = adapter.prune?.();
        if (pruned && typeof pruned.catch === "function") pruned.catch((error) => log("warn", "prune", String(error?.message ?? error)));
      } catch (error) {
        log("warn", "prune", String(error?.message ?? error));
      }
      return { logs, jobs };
    },
    log,
  };
}
