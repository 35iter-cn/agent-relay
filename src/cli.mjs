#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createConfig } from "./config.mjs";
import { ensurePrivateDir } from "./shared/fs.mjs";
import { createLog } from "./shared/log.mjs";
import { createCore } from "./runtime/core.mjs";
import { acquireInstanceLock } from "./runtime/instance-lock.mjs";
import { definePlatform, isPlatform, PLATFORMS } from "./platforms/contract.mjs";
import { durationMs } from "./shared/duration.mjs";
import { readJson } from "./shared/json.mjs";
import { localStamp } from "./shared/time.mjs";
import { MAX_LOOPS, MIN_EVERY_MS, canonicalPromptPath, isLoopId, loopIdForSlug, platformOfLoopId, validateLoopPromptSource, validateLoopTitle, validateSchedule, validateSlug } from "./loops/model.mjs";
import { loopDueAt } from "./loops/schedule.mjs";
import { validatePromptFile } from "./loops/prompt.mjs";
import { loopHelp } from "./loops/help.mjs";
import { jobHelp } from "./jobs/help.mjs";
import { stallHelp } from "./stall/help.mjs";
import { findRound, listRounds } from "./loops/history.mjs";
import { withTitle } from "./notices/title.mjs";

export const ACTION_NAMES = new Set(["cancel", "restart"]);
export const LOOP_ACTIONS = new Set(["create", "list", "show", "update", "pause", "resume", "delete", "run", "log", "show-run", "doctor"]);
export const JOB_ACTIONS = new Set(["start", "cancel", "list", "redeliver"]);
const COMMAND_WAIT_MS = 20_000;
const COMMAND_POLL_MS = 500;

export function usage(stream = process.stderr) {
  stream.write(
    [
      "usage:",
      `  agent-relay serve <${PLATFORMS.join("|")}>`,
      "  agent-relay notice emit --platform <p> (--text <text> | --text-file <path>) [--title <text>] [--prompt <text> | --prompt-file <path>] [--reply-mode conversation --reply-key <key>]",
      "  agent-relay stall <platform> <cancel|restart> <key> [text]",
      "  agent-relay job help | agent-relay job start|cancel|list|redeliver …",
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

export function jobCancelDedupe(flags, positional) {
  if (typeof flags.dedupe === "string") return flags.dedupe;
  return positional[0] ?? "";
}

export async function sendCommand(config, platform, command, { waitMs = COMMAND_WAIT_MS, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const dir = ensurePrivateDir(config.commandDir(platform));
  const file = join(dir, `${Date.now()}-${process.pid}.json`);
  writeFileSync(file, `${JSON.stringify({ ...command, at: new Date().toISOString() })}\n`, { encoding: "utf8", mode: 0o600 });
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline && existsSync(file)) await sleep(COMMAND_POLL_MS);
  return { delivered: !existsSync(file), file };
}

export const BRIEF_MAX_BYTES = 8 * 1024;
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

export function precheckJob(stateFile, { key, dedupe, brief } = {}) {
  if (!brief || !String(brief).trim()) return "empty";
  if (Buffer.byteLength(String(brief)) > BRIEF_MAX_BYTES) return "too-long";
  let state = null;
  try {
    state = JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    return "no-state";
  }
  if (!state?.convs?.[key]) return "unknown-key";
  if (state.seen?.[dedupe]) return "duplicate";
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
    .map((job) => `${job.status}\t${job.dueAt ?? "-"}\t${job.inbound?.dedupeId ?? "-"}\t${firstLine(job.inbound?.text)}`);
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

export async function emitNotice(config, platform, text, prompt = "", log = createLog(), reply = null, title = "") {
  const sent = await sendCommand(config, platform, { op: "emit", text, prompt, reply, title }).catch((error) => {
    log("warn", "notice-command", String(error?.message ?? error));
    return { delivered: false };
  });
  if (sent.delivered) return { delivered: true };
  const adapter = await loadPlatform(platform, config, log);
  const posted = await adapter.postNotice(withTitle(title, text));
  return { delivered: false, messageId: posted?.messageId ?? null };
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
        schedule: loop.at ? `at ${loop.at}` : loop.cron ? `cron ${loop.cron}` : `every ${loop.every}`,
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
  const allowedWarnings = new Set(["legacy-id", "inline-prompt-allowed"]);
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
      if (validateSchedule({ every: loop.every, at: loop.at, cron: loop.cron })) problems.push("bad-schedule");
      const level = !problems.length ? "ok" : problems.every((item) => allowedWarnings.has(item)) ? "warn" : "fail";
      rows.push({ platform, id, level, problems });
    }
  }
  return rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
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
    process.stdout.write(`${sent.delivered ? "redelivered" : "pending"}\n`);
    process.exitCode = sent.delivered ? 0 : 1;
    return;
  }
  if (verb === "cancel") {
    const dedupe = jobCancelDedupe(flags, positional);
    if (!dedupe) usage();
    const sent = await dispatch(config, platform, { op: "cancel", dedupe });
    process.stdout.write(`${sent.delivered ? "cancelled" : "pending"}\n`);
    process.exitCode = sent.delivered ? 0 : 1;
    return;
  }
  const key = typeof flags.key === "string" ? flags.key : "";
  const dedupe = typeof flags.dedupe === "string" ? flags.dedupe : "";
  const brief = textFlag(flags, "brief");
  if (!key || !dedupe || !brief) usage();
  const dueAt = dueFrom(flags);
  if ((flags.at !== undefined || flags.in !== undefined) && !dueAt) usage();
  const refused = precheckJob(config.stateFile(platform), { key, dedupe, brief });
  if (refused) {
    process.stderr.write(`refused: ${refused}\n`);
    process.exitCode = 3;
    return;
  }
  const sent = await dispatch(config, platform, {
    op: "schedule",
    key,
    dedupe,
    brief,
    dueAt,
    graceMs: durationMs(flags.grace, DEFAULT_GRACE_MS),
  });
  process.stdout.write(`${sent.delivered ? (dueAt ? "scheduled" : "started") : "pending"}\n`);
  process.exitCode = sent.delivered ? 0 : 1;
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
      .then(() => core.startDueJobs())
      .then(() => core.startDueLoops())
      .catch((error) => log("error", "command", String(error?.stack ?? error)));
  let booted = false;
  const boot = async () => {
    if (booted) return;
    booted = true;
    try {
      await core.recover();
    } catch (error) {
      log("error", "recover", String(error?.stack ?? error));
    }
    await tick();
    setInterval(tick, 15_000).unref();
  };
  await adapter.start({
    onMessage: (inbound) => core.handle(inbound),
    onReady: () => {
      core.onReady().catch((error) => log("error", "boot-notice", String(error?.stack ?? error)));
      boot().catch((error) => log("error", "recover", String(error?.stack ?? error)));
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
    process.stdout.write(`${sent.delivered ? "delivered" : "pending"}\n`);
    process.exitCode = sent.delivered ? 0 : 1;
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
    const every = typeof flags.every === "string" ? flags.every : null;
    const at = typeof flags.at === "string" ? flags.at : null;
    const cron = typeof flags.cron === "string" ? flags.cron : null;
    const id = loopIdForSlug(slug, platform);
    const title = typeof flags.title === "string" ? flags.title.trim() : null;
    const refused =
      validateSchedule({ every, at, cron }) ??
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
        every,
        loopAt: at,
        cron,
        thread: !flags["no-thread"],
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
        `schedule: ${target.at ? `at ${target.at}` : target.cron ? `cron ${target.cron}` : `every ${target.every}`}`,
        `due: ${Number.isFinite(loopDueAt(target)) ? localStamp(loopDueAt(target)) : "-"}`,
        `thread: ${target.thread !== false}`,
        `rounds: ${target.lastRound ?? 0}  last: ${target.lastOutcome ?? "-"}  streak: ${target.failStreak ?? 0}`,
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
    if (flags.every !== undefined || flags.at !== undefined || flags.cron !== undefined) {
      const every = typeof flags.every === "string" ? flags.every : null;
      const at = typeof flags.at === "string" ? flags.at : null;
      const cron = typeof flags.cron === "string" ? flags.cron : null;
      const refused = validateSchedule({ every, at, cron });
      if (refused) {
        refuse(refused);
        return;
      }
      command.every = every;
      command.loopAt = at;
      if (cron) command.cron = cron;
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
    if (flags.thread !== undefined || flags["no-thread"] !== undefined) command.thread = !flags["no-thread"];
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
    if (verb !== "emit") usage();
    const { flags } = parseFlags(args);
    const platform = flags.platform;
    const text = textFlag(flags, "text");
    const prompt = textFlag(flags, "prompt");
    const title = typeof flags.title === "string" ? flags.title : "";
    if (!isPlatform(platform) || !text) usage();
    const replyMode = typeof flags["reply-mode"] === "string" ? flags["reply-mode"] : "";
    const replyKey = typeof flags["reply-key"] === "string" ? flags["reply-key"] : "";
    const reply = replyMode ? { mode: replyMode, key: replyKey || undefined } : null;
    const result = await emitNotice(config, platform, text, prompt, log, reply, title);
    process.stdout.write(`${result.delivered ? "delivered" : `sent ${result.messageId ? 1 : 0}`}\n`);
    return;
  }
  if (mode === "stall") {
    if (rest[0] === "help") {
      process.stdout.write(stallHelp());
      return;
    }
    const [platform, action, key, ...words] = rest;
    if (!isPlatform(platform) || !ACTION_NAMES.has(action) || !key) usage();
    const result = await sendCommand(config, platform, { op: "action", action, key, text: words.join(" ").trim() });
    process.stdout.write(`${result.delivered ? "delivered" : "pending"}\n`);
    return;
  }
  if (mode === "job") {
    await handleJobCommand(rest, config, log);
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
