#!/usr/bin/env bun
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { GROUP_PATTERN, createConfig } from "./config.mjs";
import { ensurePrivateDir } from "./shared/fs.mjs";
import { createLog } from "./shared/log.mjs";
import { createCore } from "./runtime/core.mjs";
import { acquireInstanceLock } from "./runtime/instance-lock.mjs";
import { definePlatform, isPlatform, PLATFORMS } from "./platforms/contract.mjs";
import { durationMs } from "./shared/duration.mjs";
import { readJson } from "./shared/json.mjs";
import { localStamp } from "./shared/time.mjs";
import { MAX_LOOPS, canonicalPromptPath, isLoopId, loopIdForSlug, platformOfLoopId, validateLoopPromptSource, validateLoopTitle, validateSchedule, validateSlug } from "./loops/model.mjs";
import { loopDueAt } from "./loops/schedule.mjs";
import { validatePromptFile } from "./loops/prompt.mjs";
import { loopHelp } from "./loops/help.mjs";
import { jobHelp, scheduleHelp } from "./jobs/help.mjs";
import { findRound, listRounds } from "./loops/history.mjs";
import { withTitle } from "./notices/title.mjs";
import { restartHelp } from "./restart/help.mjs";
import { createSystemctl, executeRestart, spawnDetachedRestart } from "./restart/execute.mjs";

export const LOOP_ACTIONS = new Set(["create", "list", "show", "update", "pause", "resume", "delete", "run", "log", "show-run", "doctor"]);
export const JOB_ACTIONS = new Set(["cancel", "list", "redeliver", "restart"]);
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const COMMAND_WAIT_MS = 20_000;
const COMMAND_POLL_MS = 500;

export function usage(stream = process.stderr) {
  stream.write(
    [
      "usage:",
      `  agent-relay serve <${PLATFORMS.join("|")}>`,
      "  agent-relay notice emit --platform <p> (--text <text> | --text-file <path>) [--title <text>] [--to <group>] [--prompt <text> | --prompt-file <path>] [--reply-mode conversation --reply-key <key>]",
      "  agent-relay notice get --platform <p> <id>",
      "  agent-relay schedule --platform <p> --key <k> --name <n> [--in <dur> | --at <iso>] [--grace <dur>] [--join]  (prompt on stdin)",
      "  agent-relay schedule list|cancel|help …",
      "  agent-relay job help | agent-relay job list|cancel|restart|redeliver …",
      "  agent-relay restart [--wait <dur>|0] [--reason <text>] | agent-relay restart status|cancel|help",
      "  agent-relay loop help | agent-relay loop create|list|show|update|pause|resume|delete|run|log|show-run …",
    ].join("\n") + "\n",
  );
  process.exit(2);
}

export async function loadPlatform(platform, config, log) {
  const module = await import(`./platforms/${platform}.mjs`);
  return definePlatform(module.createPlatform({ config, log }));
}

export function parseFlags(args) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const [name, inline] = arg.slice(2).split("=");
      if (inline !== undefined) flags[name] = inline;
      else if (args[i + 1] !== undefined && !args[i + 1].startsWith("--")) flags[name] = args[++i];
      else flags[name] = true;
    } else {
      rest.push(arg);
    }
  }
  return { flags, rest };
}

export function jobArgs(rest) {
  const [verb, ...args] = rest;
  const { flags, rest: positional } = parseFlags(args);
  return { verb, flags, positional };
}

export function jobCancelName(flags, positional) {
  if (typeof flags.name === "string") return flags.name;
  return positional[0] ?? "";
}

export async function readStdinText(limit = PROMPT_MAX_BYTES, stream = process.stdin) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    const room = limit + 1 - size;
    if (room <= 0) break;
    const slice = buf.subarray(0, room);
    chunks.push(slice);
    size += slice.length;
    if (size > limit) break;
  }
  return { text: Buffer.concat(chunks).toString("utf8"), overflow: size > limit };
}

export function promptPath(config, name) {
  return join(config.userPromptsDir, "jobs", String(name), "prompt.md");
}

export async function sendCommand(config, platform, command, { waitMs = COMMAND_WAIT_MS, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const dir = ensurePrivateDir(config.commandDir(platform));
  const file = join(dir, `${Date.now()}-${process.pid}.json`);
  const resultFile = `${file}.result`;
  writeFileSync(file, `${JSON.stringify({ ...command, at: new Date().toISOString() })}\n`, { encoding: "utf8", mode: 0o600 });
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline && !existsSync(resultFile)) await sleep(COMMAND_POLL_MS);
  let result = null;
  if (existsSync(resultFile)) {
    try {
      result = JSON.parse(readFileSync(resultFile, "utf8"));
    } catch {}
    try {
      unlinkSync(resultFile);
    } catch {}
  }
  return { delivered: result !== null, result, file };
}

export function reportSent(sent, word) {
  const refused = sent?.result?.refused;
  if (refused) {
    process.stderr.write(`refused: ${refused}\n`);
    process.exitCode = 3;
    return false;
  }
  if (!sent?.delivered) {
    process.stdout.write("pending\n");
    process.exitCode = 1;
    return false;
  }
  process.stdout.write(`${word}\n`);
  process.exitCode = 0;
  return true;
}

export const PROMPT_MAX_BYTES = 8 * 1024;
export const DEFAULT_GRACE_MS = 6 * 3_600_000;

export { durationMs };

export function dueFrom(flags, nowMs = Date.now()) {
  if (typeof flags.at === "string") {
    const at = Date.parse(flags.at);
    return Number.isFinite(at) ? new Date(at).toISOString() : null;
  }
  if (flags.in !== undefined) {
    const ms = durationMs(flags.in, null);
    return ms === null ? null : new Date(nowMs + ms).toISOString();
  }
  return null;
}

export function precheckSchedule(stateFile, { key, name, prompt, taken = false } = {}) {
  if (!NAME_PATTERN.test(String(name ?? ""))) return "name-invalid";
  if (!prompt || !String(prompt).trim()) return "empty-prompt";
  if (Buffer.byteLength(String(prompt)) > PROMPT_MAX_BYTES) return "too-long";
  let state = null;
  try {
    state = JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    return "no-state";
  }
  if (!state?.convs?.[key]) return "unknown-key";
  if (state.seen?.[name] || taken) return "name-taken";
  return null;
}

function firstLine(text) {
  return String(text ?? "").split("\n")[0].slice(0, 60);
}

export function findRedeliverable(stateFile, query) {
  let state = null;
  try {
    state = JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    return null;
  }
  const jobs = Object.values(state?.jobs ?? {});
  const wanted = String(query ?? "").trim();
  if (!wanted) return null;
  const direct = state?.jobs?.[wanted];
  if (direct) return direct.answer ? direct : null;
  return jobs
    .filter((job) => job?.key === wanted && job.answer)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0] ?? null;
}

export function readNotice(stateFile, id) {
  let state = null;
  try {
    state = JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    return null;
  }
  const notice = state?.notices?.[String(id ?? "")];
  if (!notice) return null;
  return notice.text || notice.prompt ? notice : null;
}

export function listJobs(stateFile, key) {
  let state = null;
  try {
    state = JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    return [];
  }
  return Object.values(state?.jobs ?? {})
    .filter((job) => job.status === "scheduled" || job.status === "running")
    .filter((job) => !key || job.key === key)
    .sort((a, b) => String(a.dueAt ?? "").localeCompare(String(b.dueAt ?? "")))
    .map((job) => `${job.status}\t${job.id}\t${job.key}\t${job.inbound?.name ?? "-"}\t${job.dueAt ?? "-"}\t${job.inbound?.promptFile ?? firstLine(job.inbound?.text)}`);
}

export function loopPromptFlags(flags) {
  const file = typeof flags["prompt-file"] === "string" ? flags["prompt-file"].trim() : "";
  const text = typeof flags.prompt === "string" ? flags.prompt.trim() : "";
  if (file && text) return { error: "prompt-source-ambiguous" };
  if (file) return { promptFile: resolve(file) };
  if (typeof flags.prompt === "string") return { prompt: text };
  return {};
}

export function textFlag(flags, name) {
  const file = flags[`${name}-file`];
  if (typeof file === "string") return readFileSync(file, "utf8").trim();
  return typeof flags[name] === "string" ? flags[name].trim() : "";
}

export async function emitNotice(config, platform, text, prompt = "", log = createLog(), reply = null, title = "", group = "") {
  const sent = await sendCommand(config, platform, { op: "emit", text, prompt, reply, title, group }).catch((error) => {
    log("warn", "notice-command", String(error?.message ?? error));
    return { delivered: false };
  });
  if (sent.delivered) return { delivered: true };
  const adapter = await loadPlatform(platform, config, log);
  const posted = await adapter.postNotice(withTitle(title, text), { group });
  return { delivered: false, messageId: posted?.messageId ?? null, chatId: posted?.chatId ?? null };
}

export function loopPlatform(flags, env = process.env) {
  const explicit = typeof flags.platform === "string" ? flags.platform : "";
  if (isPlatform(explicit)) return explicit;
  return isPlatform(env.AGENT_RELAY_PLATFORM) ? env.AGENT_RELAY_PLATFORM : "";
}

export function readLoops(file) {
  const state = readJson(file, null);
  return state?.loops ?? {};
}

export function listLoopRows(config, platforms, { all = false, nowMs = Date.now() } = {}) {
  const rows = [];
  for (const platform of platforms) {
    for (const loop of Object.values(readLoops(config.stateFile(platform)))) {
      if (!all && loop.state === "deleted") continue;
      const due = loopDueAt(loop);
      rows.push({
        platform,
        id: loop.id,
        state: loop.state,
        schedule: `cron ${loop.cron ?? "-"}`,
        due,
        overMs: loop.state === "armed" && Number.isFinite(due) ? Math.max(0, nowMs - due) : 0,
        lastOutcome: loop.lastOutcome ?? "-",
        prompt: String(loop.promptFile ?? loop.prompt ?? ""),
      });
    }
  }
  return rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

export function formatLoopRows(rows) {
  return rows.map((row) => {
    const due = Number.isFinite(row.due) ? localStamp(row.due) : "-";
    const late = row.overMs > 60_000 ? ` overdue ${Math.round(row.overMs / 60_000)}m` : "";
    return `${row.id}\t${row.state}\t${row.schedule}\t${due}${late}\t${row.lastOutcome}\t${firstLine(row.prompt)}`;
  });
}

export function doctorLoopRows(config, platforms) {
  const allowedWarnings = new Set(["legacy-id", "inline-prompt-allowed", "skip-recent"]);
  const rows = [];
  for (const platform of platforms) {
    for (const loop of Object.values(readLoops(config.stateFile(platform)))) {
      if (loop.state === "deleted") continue;
      const id = String(loop.id ?? "");
      const problems = [];
      if (!isLoopId(id)) problems.push("bad-loop-id");
      else if (/^loop-[a-z]+-\d+$/.test(id)) problems.push("legacy-id");
      if (loop.promptFile) {
        if (resolve(String(loop.promptFile)) !== resolve(canonicalPromptPath(config.configDir, id))) problems.push("prompt-file-not-canonical");
        const refused = validatePromptFile(loop.promptFile);
        if (refused) problems.push(refused);
      } else if (String(loop.prompt ?? "").trim()) {
        problems.push(loop.promptInline ? "inline-prompt-allowed" : "inline-prompt");
      } else {
        problems.push("empty-prompt");
      }
      if (validateSchedule({ cron: loop.cron })) problems.push("bad-schedule");
      const skippedAt = Date.parse(loop.lastSkipAt ?? "");
      if (Number.isFinite(skippedAt) && Date.now() - skippedAt < 7 * 86_400_000) problems.push("skip-recent");
      const level = !problems.length ? "ok" : problems.every((item) => allowedWarnings.has(item)) ? "warn" : "fail";
      rows.push({ platform, id, level, problems });
    }
  }
  return rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

export function restartUnitFor(config, platform) {
  const unit = config.options?.relay?.restart?.unit ?? "agent-relay@%p";
  return String(unit).replace("%p", platform);
}

export function readRestartSlot(config, platform) {
  const state = readJson(config.stateFile(platform));
  return state?.restart ?? null;
}

// Every platform, one request each. A platform that cannot take one is reported and
// the others still go: a fan-out has no rollback.
export async function requestRestartAll(config, flags, deps = {}) {
  const dispatch = deps.sendCommand ?? sendCommand;
  const paths = deps.PLATFORMS ?? PLATFORMS;
  const fallbackWait = config.options?.relay?.restart?.waitMs ?? 3_600_000;
  let ask = fallbackWait;
  if (flags.wait === "0") ask = 0;
  else if (flags.wait !== undefined) {
    ask = durationMs(flags.wait, null);
    if (ask === null || !Number.isFinite(ask)) {
      process.stderr.write("refused: wait-invalid\n");
      process.exitCode = 3;
      return { refused: "wait-invalid" };
    }
  }
  const by = process.env.AGENT_RELAY_KEY ?? "";
  const lines = [];
  let code = 0;
  for (const platform of paths) {
    let sent = null;
    try {
      sent = await dispatch(config, platform, { op: "restart", waitMs: ask, reason: String(flags.reason ?? ""), by });
    } catch (error) {
      sent = { delivered: false };
    }
    if (sent?.result?.refused === "unknown-command") {
      // The daemon predates this verb (it is the one being upgraded): nothing to queue.
      const line = await restartDirectOrSkip(config, platform, deps, "daemon too old for this verb");
      lines.push(`${platform}: ${line}`);
      code = Math.max(code, 1);
      continue;
    }
    if (sent?.result?.refused) {
      lines.push(`${platform}: refused: ${sent.result.refused}`);
      code = Math.max(code, 3);
      continue;
    }
    if (!sent?.delivered) {
      const line = await restartDirectOrSkip(config, platform, deps);
      lines.push(`${platform}: ${line}`);
      code = Math.max(code, 1);
      continue;
    }
    const { request, superseded } = sent.result;
    lines.push(superseded ? `${platform}: superseded (request ${request} replaced ${superseded})` : `${platform}: queued (request ${request})`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  process.exitCode = code;
  return { lines };
}

// No daemon answered: nothing is running that we could wait for, so restart the unit —
// detached, through the same executor, because this is exactly the first upgrade and the
// unit we restart may be the one this command is running on.
async function restartDirectOrSkip(config, platform, deps = {}, reason = "daemon not running") {
  const systemctl = deps.systemctl ?? createSystemctl();
  const unit = restartUnitFor(config, platform);
  const active = await systemctl("is-active", unit).catch(() => "");
  if (active !== "active") return `${reason}; unit not active, skipped`;
  const spawned = spawnDetachedRestart({
    platform,
    unit,
    request: 0,
    spawn: deps.spawn,
    log: deps.log ?? (() => {}),
  });
  return spawned ? `${reason}; restarted directly (detached)` : `${reason}; could not start the restart unit`;
}

export async function handleRestartCommand(rest, config, log, deps = {}) {
  const first = String(rest[0] ?? "");
  const bare = first.startsWith("-");
  const { flags, rest: positional } = parseFlags(bare ? rest : rest.slice(1));
  const verb = bare || !first ? "restart" : first;
  if (verb === "help" || verb === "-h" || flags.help) {
    const text = restartHelp(verb === "help" ? String(positional[0] ?? "") : "");
    if (!text) {
      process.stderr.write("refused: unknown-verb\n");
      process.exitCode = 3;
      return;
    }
    process.stdout.write(text);
    process.exitCode = 0;
    return;
  }
  if (flags.execute) {
    const platform = typeof flags.platform === "string" ? flags.platform : "";
    const unit = typeof flags.unit === "string" && flags.unit ? flags.unit : "";
    const request = Number(flags.request ?? 0) || 0;
    if (!unit) {
      process.stderr.write("refused: no-unit\n");
      process.exitCode = 3;
      return;
    }
    const systemctl = deps.systemctl ?? createSystemctl();
    const result = await executeRestart({
      unit,
      request,
      systemctl,
      healthMs: config.options?.relay?.restart?.healthMs ?? 60_000,
      sleep: deps.sleep,
    });
    if (result.code === 0) {
      process.stdout.write(`restart ok (request ${request}, pid ${result.before} -> ${result.pid})\n`);
      process.exitCode = 0;
      return;
    }
    const { createPrompts } = await import("./runtime/prompts.mjs");
    const prompts = deps.prompts ?? createPrompts({ dir: config.promptsDir, userDir: config.userPromptsDir, log });
    if (platform) {
      await emitNotice(config, platform, prompts.restartFailed({ request, unit }), "", log, null, "restart", "system").catch((error) => log("warn", "restart-failed-notice", String(error?.message ?? error)));
    }
    process.stderr.write(`restart failed (request ${request}): ${unit} is not active or MainPID did not change\n`);
    process.exitCode = 1;
    return;
  }
  if (verb === "status") {
    const paths = deps.PLATFORMS ?? PLATFORMS;
    const lines = [];
    for (const platform of paths) {
      const slot = readRestartSlot(config, platform);
      if (!slot) {
        lines.push(`${platform}: nothing pending`);
        continue;
      }
      const waited = slot.requestedAt ? Math.max(0, Math.round((Date.now() - Date.parse(slot.requestedAt)) / 60_000)) : 0;
      const deadline = slot.deadlineAt ? `deadline ${localStamp(Date.parse(slot.deadlineAt))}` : "no deadline";
      if (slot.status === "pending") lines.push(`${platform}: request ${slot.seq} pending, ${waited} min waited, ${deadline}`);
      else if (slot.status === "stopping") lines.push(`${platform}: request ${slot.seq} stopping, ${Math.round((Number(slot.waitedMs) || 0) / 60_000)} min waited`);
      else if (slot.status === "done") lines.push(`${platform}: request ${slot.seq} done, ${Math.round((Number(slot.waitedMs) || 0) / 60_000)} min waited, ${Number(slot.finishedJobs) || 0} round(s) finished`);
      else lines.push(`${platform}: request ${slot.seq} ${slot.status}`);
    }
    process.stdout.write(`${lines.join("\n")}\n`);
    return;
  }
  if (verb === "cancel") {
    const dispatch = deps.sendCommand ?? sendCommand;
    const paths = deps.PLATFORMS ?? PLATFORMS;
    const lines = [];
    let code = 0;
    for (const platform of paths) {
      let sent = null;
      try {
        sent = await dispatch(config, platform, { op: "restart-cancel", by: process.env.AGENT_RELAY_KEY ?? "" });
      } catch (error) {
        sent = { delivered: false };
      }
      if (sent?.result?.refused === "unknown-command") {
        lines.push(`${platform}: old daemon; nothing to cancel`);
        code = Math.max(code, 1);
      } else if (sent?.result?.refused === "nothing-pending") {
        lines.push(`${platform}: nothing pending`);
      } else if (sent?.result?.refused) {
        lines.push(`${platform}: refused: ${sent.result.refused}`);
        code = Math.max(code, 3);
      } else if (sent?.delivered) {
        lines.push(`${platform}: cancelled (request ${sent.result.request ?? "-"})`);
      } else {
        lines.push(`${platform}: daemon not running; nothing to cancel`);
        code = Math.max(code, 1);
      }
    }
    process.stdout.write(`${lines.join("\n")}\n`);
    process.exitCode = code;
    return;
  }
  if (verb !== "restart") {
    process.stderr.write("refused: unknown-verb\n");
    process.exitCode = 3;
    return;
  }
  await requestRestartAll(config, flags, deps);
}

export async function handleJobCommand(rest, config, log, deps = {}) {
  const dispatch = deps.sendCommand ?? sendCommand;
  const { verb, flags, positional } = jobArgs(rest);
  if (!verb || verb === "help" || verb === "--help" || verb === "-h") {
    const text = jobHelp(verb ? String(positional[0] ?? "") : "");
    if (!text) {
      process.stderr.write("refused: unknown-verb\n");
      process.exitCode = 3;
      return;
    }
    process.stdout.write(text);
    process.exitCode = verb ? 0 : 2;
    return;
  }
  if (!JOB_ACTIONS.has(verb)) {
    process.stderr.write("refused: unknown-verb\n");
    process.exitCode = 3;
    return;
  }
  const platform = flags.platform;
  if (!isPlatform(platform)) usage();
  if (verb === "list") {
    const lines = listJobs(config.stateFile(platform), typeof flags.key === "string" ? flags.key : null);
    process.stdout.write(`${lines.join("\n")}${lines.length ? "\n" : ""}`);
    return;
  }
  if (verb === "redeliver") {
    const target = typeof flags.key === "string" ? flags.key : positional[0] ?? "";
    if (!target) usage();
    const job = findRedeliverable(config.stateFile(platform), target);
    if (!job) {
      process.stderr.write("refused: nothing-to-redeliver\n");
      process.exitCode = 3;
      return;
    }
    const sent = await dispatch(config, platform, { op: "redeliver", job: job.id, key: job.key });
    reportSent(sent, "redelivered");
    return;
  }
  const id = positional[0] ?? (typeof flags.job === "string" ? flags.job : "");
  if (!id) usage();
  if (verb === "cancel") {
    const sent = await dispatch(config, platform, { op: "cancel-job", job: id });
    reportSent(sent, "cancelled");
    return;
  }
  const text = positional.slice(1).join(" ").trim();
  const sent = await dispatch(config, platform, { op: "restart-job", job: id, text });
  reportSent(sent, "restarted");
}

export async function handleScheduleCommand(rest, config, log, deps = {}) {
  const dispatch = deps.sendCommand ?? sendCommand;
  const first = rest[0];
  if (first === "--help" || first === "-h") {
    process.stdout.write(scheduleHelp());
    process.exitCode = 0;
    return;
  }
  const verb = first && !first.startsWith("--") ? first : "create";
  const args = verb === "create" ? rest : rest.slice(1);
  const { flags, rest: positional } = parseFlags(args);
  if (verb === "help" || verb === "--help" || verb === "-h") {
    process.stdout.write(scheduleHelp());
    process.exitCode = 0;
    return;
  }
  const platform = flags.platform;
  if (verb === "list") {
    if (!isPlatform(platform)) usage();
    const lines = listJobs(config.stateFile(platform), null).filter((line) => line.startsWith("scheduled\t"));
    process.stdout.write(`${lines.join("\n")}${lines.length ? "\n" : ""}`);
    return;
  }
  if (verb === "cancel") {
    const name = jobCancelName(flags, positional);
    if (!isPlatform(platform) || !name) usage();
    const sent = await dispatch(config, platform, { op: "cancel-schedule", name });
    reportSent(sent, "cancelled");
    return;
  }
  if (verb !== "create") {
    process.stderr.write("refused: unknown-verb\n");
    process.exitCode = 3;
    return;
  }
  const key = typeof flags.key === "string" ? flags.key : "";
  const name = jobCancelName(flags, []);
  if (!isPlatform(platform) || !key || !name) usage();
  if (process.stdin.isTTY) {
    process.stderr.write("refused: stdin-is-tty\n");
    process.exitCode = 3;
    return;
  }
  const dueAt = dueFrom(flags);
  if ((flags.at !== undefined || flags.in !== undefined) && !dueAt) usage();
  const stdin = await readStdinText();
  const prompt = stdin.text.trim();
  const refused =
    (stdin.overflow ? "too-long" : null) ??
    precheckSchedule(config.stateFile(platform), { key, name, prompt, taken: existsSync(promptPath(config, name)) });
  if (refused) {
    process.stderr.write(`refused: ${refused}\n`);
    process.exitCode = 3;
    return;
  }
  const sent = await dispatch(config, platform, {
    op: "schedule",
    key,
    name,
    prompt,
    dueAt,
    join: flags.join === true || flags.join === "true",
    graceMs: durationMs(flags.grace, DEFAULT_GRACE_MS),
  });
  if (!reportSent(sent, `scheduled\t${promptPath(config, name)}`)) return;
}

async function serve(platform, config, log) {
  ensurePrivateDir(config.configDir);
  ensurePrivateDir(config.logDir);
  const lock = acquireInstanceLock({ dir: config.configDir, platform });
  if (!lock) {
    log("error", "serve-lock", `another instance already serves ${platform} (${config.configDir})`);
    process.exit(1);
  }
  const release = () => lock.release();
  process.on("exit", release);
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(signal, () => {
      release();
      process.exit(0);
    });
  }
  const adapter = await loadPlatform(platform, config, log);
  const core = createCore({ adapter, config });
  core.pruneLogs();
  setInterval(() => core.pruneLogs(), 86_400_000).unref();
  const tick = () =>
    core.drainCommands()
      .then(() => core.checkRestart())
      .then(() => core.startDueJobs())
      .then(() => core.startDueDeliveries())
      .then(() => core.startDueLoops())
      .catch((error) => log("error", "command", String(error?.stack ?? error)));
  let booted = false;
  const boot = async () => {
    if (booted) return;
    booted = true;
    setInterval(tick, 15_000).unref();
    try {
      await core.recover();
    } catch (error) {
      log("error", "recover", String(error?.stack ?? error));
    }
    tick();
  };
  await adapter.start({
    onMessage: (inbound) => core.handle(inbound),
    onReady: () => {
      core.onReady().catch((error) => log("error", "boot-notice", String(error?.stack ?? error)));
      boot().catch((error) => log("error", "boot", String(error?.stack ?? error)));
    },
    core,
  });
}

export async function handleLoopCommand(rest, config, log, deps = {}) {
  const [verb, ...args] = rest;
  if (!verb || verb === "help" || verb === "--help" || verb === "-h") {
    const text = loopHelp(verb ? String(args[0] ?? "") : "");
    if (!text) {
      process.stderr.write("refused: unknown-verb\n");
      process.exitCode = 3;
      return;
    }
    process.stdout.write(text);
    process.exitCode = verb ? 0 : 2;
    return;
  }
  if (!LOOP_ACTIONS.has(verb)) {
    process.stderr.write("refused: unknown-verb\n");
    process.exitCode = 3;
    return;
  }
  const { flags, rest: positional } = parseFlags(args);
  const id = positional[0] ?? "";
  const refuse = (reason) => {
    process.stderr.write(`refused: ${reason}\n`);
    process.exitCode = 3;
  };
  const dispatch = deps.sendCommand ?? sendCommand;
  const send = async (command, platform) => {
    const sent = await dispatch(config, platform, command);
    reportSent(sent, "delivered");
  };
  if (verb === "list") {
    const platform = typeof flags.platform === "string" ? flags.platform : "";
    const platforms = isPlatform(platform) ? [platform] : PLATFORMS;
    const rows = listLoopRows(config, platforms, { all: Boolean(flags.all) });
    const lines = formatLoopRows(rows);
    process.stdout.write(`${lines.join("\n")}${lines.length ? "\n" : ""}`);
    return;
  }
  if (verb === "log") {
    const limit = Number(flags.limit ?? 20);
    const rounds = listRounds(config.loopHistoryDir, id, { limit: Number.isFinite(limit) ? limit : 20 });
    const lines = rounds.map(
      (round) => `${round.runId}\t${localStamp(Date.parse(round.at))}\t${round.trigger}\t${round.outcome}\t${round.error ?? ""}`.trimEnd(),
    );
    process.stdout.write(`${lines.join("\n")}${lines.length ? "\n" : ""}`);
    return;
  }
  if (verb === "show-run") {
    const round = findRound(config.loopHistoryDir, id);
    if (!round) {
      refuse("not-found");
      return;
    }
    process.stdout.write(`${round.runId}\t${round.trigger}\t${round.outcome}\t${round.messageId ?? "-"}\n${round.output ?? ""}\n`);
    return;
  }
  if (verb === "doctor") {
    const platform = typeof flags.platform === "string" ? flags.platform : "";
    const platforms = isPlatform(platform) ? [platform] : PLATFORMS;
    const rows = doctorLoopRows(config, platforms);
    const lines = rows.map((row) => `${row.id}\t${row.level}\t${row.problems.join(",") || "-"}`);
    process.stdout.write(`${lines.join("\n")}${lines.length ? "\n" : ""}`);
    process.exitCode = rows.some((row) => row.level === "fail") ? 3 : 0;
    return;
  }
  if (verb === "create" || verb === "update") {
    if (flags.thread !== undefined || flags["no-thread"] !== undefined) {
      refuse("thread-flag-removed");
      return;
    }
  }
  if (verb === "create") {
    const platform = loopPlatform(flags, deps.env ?? process.env);
    if (!isPlatform(platform)) {
      refuse("bad-platform");
      return;
    }
    const loops = readLoops(config.stateFile(platform));
    const source = loopPromptFlags(flags);
    if (source.error) {
      refuse(source.error);
      return;
    }
    const slug = typeof flags.slug === "string" ? flags.slug.trim() : "";
    const allowInline = Boolean(flags["allow-inline"]);
    if (flags.every !== undefined || flags.at !== undefined) {
      refuse("cron-required");
      return;
    }
    const cron = typeof flags.cron === "string" ? flags.cron : null;
    const id = loopIdForSlug(slug, platform);
    const title = typeof flags.title === "string" ? flags.title.trim() : null;
    const refused =
      validateSchedule({ cron }) ??
      (slug ? validateSlug(slug) : "slug-required") ??
      validateLoopTitle(title) ??
      validateLoopPromptSource({ id, prompt: source.prompt, promptFile: source.promptFile, configDir: config.configDir, allowInline });
    if (refused) {
      refuse(refused);
      return;
    }
    const active = Object.values(loops).filter((loop) => loop.state !== "deleted").length;
    if (active >= MAX_LOOPS) {
      refuse("too-many-loops");
      return;
    }
    await send(
      {
        op: "loop-create",
        id,
        prompt: source.prompt ?? "",
        promptFile: source.promptFile ?? null,
        promptInline: !source.promptFile && Boolean(source.prompt),
        cron,
        title,
        createdBy: process.env.AGENT_RELAY_KEY ?? null,
      },
      platform,
    );
    return;
  }
  if (!id) {
    refuse("missing-id");
    return;
  }
  const owner = platformOfLoopId(id);
  if (!isPlatform(owner)) {
    refuse("bad-loop-id");
    return;
  }
  const target = readLoops(config.stateFile(owner))[id];
  if (!target || target.state === "deleted") {
    refuse("not-found");
    return;
  }
  if (verb === "show") {
    process.stdout.write(
      [
        `id: ${target.id}`,
        `state: ${target.state}`,
        `schedule: cron ${target.cron ?? "-"}`,
        `due: ${Number.isFinite(loopDueAt(target)) ? localStamp(loopDueAt(target)) : "-"}`,
        `rounds: ${target.lastRound ?? 0}  last: ${target.lastOutcome ?? "-"}  streak: ${target.failStreak ?? 0}`,
        ...(Number.isFinite(Date.parse(target.lastSkipAt ?? "")) ? [`skipped: ${localStamp(Date.parse(target.lastSkipAt))}`] : []),
        ...(target.promptFile ? [`prompt-file: ${target.promptFile}`] : [`prompt:`, target.prompt]),
        "",
      ].join("\n"),
    );
    return;
  }
  if (verb === "run") {
    await send({ op: "loop-run", id }, owner);
    return;
  }
  if (verb === "pause" || verb === "resume" || verb === "delete") {
    const state = verb === "pause" ? "paused" : verb === "resume" ? "armed" : "deleted";
    await send({ op: "loop-state", id, state }, owner);
    return;
  }
  if (verb === "update") {
    const command = { op: "loop-update", id };
    if (flags.every !== undefined || flags.at !== undefined) {
      refuse("cron-required");
      return;
    }
    if (flags.cron !== undefined) {
      const cron = typeof flags.cron === "string" ? flags.cron : null;
      const refused = validateSchedule({ cron });
      if (refused) {
        refuse(refused);
        return;
      }
      command.cron = cron;
    }
    if (flags.prompt !== undefined || flags["prompt-file"] !== undefined) {
      const source = loopPromptFlags(flags);
      if (source.error) {
        refuse(source.error);
        return;
      }
      const refused = validateLoopPromptSource({
        id,
        prompt: source.prompt,
        promptFile: source.promptFile,
        configDir: config.configDir,
        allowInline: Boolean(flags["allow-inline"]),
      });
      if (refused) {
        refuse(refused);
        return;
      }
      command.prompt = source.prompt ?? "";
      command.promptFile = source.promptFile ?? null;
      command.promptInline = !source.promptFile && Boolean(source.prompt);
    }
    if (flags.title !== undefined) {
      const title = String(flags.title).trim();
      const refused = validateLoopTitle(title);
      if (refused) {
        refuse(refused);
        return;
      }
      command.title = title;
    }
    await send(command, owner);
    return;
  }
  usage();
}

export async function main(argv = process.argv.slice(2)) {
  const log = createLog();
  const config = createConfig();
  const [mode, ...rest] = argv;
  if (mode === "serve") {
    const [platform] = rest;
    if (!isPlatform(platform)) usage();
    await serve(platform, config, log);
    return;
  }
  if (mode === "notice") {
    const [verb, ...args] = rest;
    if (verb === "get") {
      const { flags, rest: positional } = parseFlags(args);
      const platform = flags.platform;
      const id = positional[0] ?? "";
      if (!isPlatform(platform) || !id) usage();
      const notice = readNotice(config.stateFile(platform), id);
      if (!notice) {
        process.stderr.write("refused: no-payload\n");
        process.exitCode = 3;
        return;
      }
      const body = String(notice.text ?? "").trim();
      const prompt = String(notice.prompt ?? "").trim();
      process.stdout.write([body, prompt].filter(Boolean).join("\n\n---\n\n") + "\n");
      return;
    }
    if (verb !== "emit") usage();
    const { flags } = parseFlags(args);
    const platform = flags.platform;
    const text = textFlag(flags, "text");
    const prompt = textFlag(flags, "prompt");
    const title = typeof flags.title === "string" ? flags.title : "";
    const group = typeof flags.to === "string" ? flags.to.trim() : "";
    if (!isPlatform(platform) || !text) usage();
    if (group && group !== "default" && !GROUP_PATTERN.test(group)) {
      process.stderr.write("refused: bad-group\n");
      process.exitCode = 3;
      return;
    }
    const replyMode = typeof flags["reply-mode"] === "string" ? flags["reply-mode"] : "";
    const replyKey = typeof flags["reply-key"] === "string" ? flags["reply-key"] : "";
    const reply = replyMode ? { mode: replyMode, key: replyKey || undefined } : null;
    const result = await emitNotice(config, platform, text, prompt, log, reply, title, group === "default" ? "" : group);
    process.stdout.write(`${result.delivered ? "delivered" : `sent ${result.messageId ? 1 : 0}`}\n`);
    return;
  }
  if (mode === "schedule") {
    await handleScheduleCommand(rest, config, log);
    return;
  }
  if (mode === "stall") {
    process.stderr.write("refused: unknown-command\n");
    process.stderr.write("用 `agent-relay job cancel <id>` 终止、`agent-relay job restart <id>` 重启\n");
    process.exitCode = 3;
    return;
  }
  if (mode === "job") {
    await handleJobCommand(rest, config, log);
    return;
  }
  if (mode === "restart") {
    await handleRestartCommand(rest, config, log);
    return;
  }
  if (mode === "loop") {
    await handleLoopCommand(rest, config, log);
    return;
  }
  if (mode === "platforms") {
    process.stdout.write(`${PLATFORMS.join("\n")}\n`);
    return;
  }
  usage();
}

if (import.meta.main) {
  main().catch((error) => {
    createLog()("error", "fatal", String(error?.stack ?? error));
    process.exit(1);
  });
}
