#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createConfig } from "./config.mjs";
import { ensurePrivateDir } from "./shared/fs.mjs";
import { createLog } from "./shared/log.mjs";
import { createCore } from "./runtime/core.mjs";
import { acquireInstanceLock } from "./runtime/instance-lock.mjs";
import { definePlatform, isPlatform, PLATFORMS } from "./platforms/contract.mjs";
import { durationMs } from "./shared/duration.mjs";
import { readJson } from "./shared/json.mjs";
import { localStamp } from "./shared/time.mjs";
import { MAX_LOOPS, MIN_EVERY_MS, nextLoopId, platformOfLoopId, validatePrompt, validateSchedule } from "./loops/model.mjs";
import { loopDueAt } from "./loops/schedule.mjs";
import { findRound, listRounds } from "./loops/history.mjs";

export const ACTION_NAMES = new Set(["cancel", "restart"]);
const COMMAND_WAIT_MS = 20_000;
const COMMAND_POLL_MS = 500;

export function usage(stream = process.stderr) {
  stream.write(
    [
      "usage:",
      "  agent-relay serve <discord|feishu|mattermost|slack|telegram>",
      "  agent-relay notice emit --platform <p> (--text <text> | --text-file <path>) [--prompt <text> | --prompt-file <path>]",
      "  agent-relay notify <platform> <text>",
      "  agent-relay stall <platform> <cancel|restart> <key> [text]",
      "  agent-relay job start --platform <p> --key <k> --dedupe <id> (--brief <text> | --brief-file <path>) [--in 30m | --at <iso>] [--grace 6h]",
      "  agent-relay job cancel --platform <p> <dedupe>",
      "  agent-relay job list --platform <p> [--key <k>]",
      "  agent-relay loop create --platform <p> (--every 30m | --at <iso>) (--prompt <t> | --prompt-file <f>) [--no-thread]",
      "  agent-relay loop list [--platform <p>] [--all]",
      "  agent-relay loop show <id> | run <id> | pause <id> | resume <id> | delete <id>",
      "  agent-relay loop update <id> [--every <d> | --at <iso> | --prompt <t> | --prompt-file <f> | --thread | --no-thread]",
      "  agent-relay loop log <id> [--limit 20]",
      "  agent-relay loop show-run <runId>",
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

export function textFlag(flags, name) {
  const file = flags[`${name}-file`];
  if (typeof file === "string") return readFileSync(file, "utf8").trim();
  return typeof flags[name] === "string" ? flags[name].trim() : "";
}

export async function emitNotice(config, platform, text, prompt = "", log = createLog()) {
  const sent = await sendCommand(config, platform, { op: "emit", text, prompt }).catch((error) => {
    log("warn", "notice-command", String(error?.message ?? error));
    return { delivered: false };
  });
  if (sent.delivered) return { delivered: true };
  const adapter = await loadPlatform(platform, config, log);
  const posted = await (adapter.postNotice ?? adapter.notify).call(adapter, text);
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
        schedule: loop.at ? `at ${loop.at}` : `every ${loop.every}`,
        due,
        overMs: loop.state === "armed" && Number.isFinite(due) ? Math.max(0, nowMs - due) : 0,
        lastOutcome: loop.lastOutcome ?? "-",
        prompt: String(loop.prompt ?? ""),
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
  tick();
  setInterval(tick, 15_000).unref();
  await adapter.start({
    onMessage: (inbound) => core.handle(inbound),
    onReady: () => {
      core.onReady().catch((error) => log("error", "boot-notice", String(error?.stack ?? error)));
      core.recover().catch((error) => log("error", "recover", String(error?.stack ?? error)));
    },
    core,
  });
}

export async function handleLoopCommand(rest, config, log, deps = {}) {
  const [verb, ...args] = rest;
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
  if (verb === "create") {
    const platform = loopPlatform(flags, deps.env ?? process.env);
    if (!isPlatform(platform)) {
      refuse("bad-platform");
      return;
    }
    const loops = readLoops(config.stateFile(platform));
    const prompt = textFlag(flags, "prompt");
    const every = typeof flags.every === "string" ? flags.every : null;
    const at = typeof flags.at === "string" ? flags.at : null;
    const refused = validateSchedule({ every, at }) ?? validatePrompt(prompt);
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
        id: nextLoopId(loops, platform),
        prompt,
        every,
        loopAt: at,
        thread: !flags["no-thread"],
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
        `schedule: ${target.at ? `at ${target.at}` : `every ${target.every}`}`,
        `due: ${Number.isFinite(loopDueAt(target)) ? localStamp(loopDueAt(target)) : "-"}`,
        `thread: ${target.thread !== false}`,
        `rounds: ${target.lastRound ?? 0}  last: ${target.lastOutcome ?? "-"}  streak: ${target.failStreak ?? 0}`,
        `prompt:`,
        target.prompt,
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
      const every = typeof flags.every === "string" ? flags.every : null;
      const at = typeof flags.at === "string" ? flags.at : null;
      const refused = validateSchedule({ every, at });
      if (refused) {
        refuse(refused);
        return;
      }
      command.every = every;
      command.loopAt = at;
    }
    if (flags.prompt !== undefined || flags["prompt-file"] !== undefined) {
      const prompt = textFlag(flags, "prompt");
      const refused = validatePrompt(prompt);
      if (refused) {
        refuse(refused);
        return;
      }
      command.prompt = prompt;
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
    if (!isPlatform(platform) || !text) usage();
    const result = await emitNotice(config, platform, text, prompt, log);
    process.stdout.write(`${result.delivered ? "delivered" : `sent ${result.messageId ? 1 : 0}`}\n`);
    return;
  }
  if (mode === "notify") {
    const [platform, ...words] = rest;
    if (!isPlatform(platform)) usage();
    const text = words.join(" ").trim();
    if (!text) usage();
    await emitNotice(config, platform, text, "", log);
    return;
  }
  if (mode === "stall") {
    const [platform, action, key, ...words] = rest;
    if (!isPlatform(platform) || !ACTION_NAMES.has(action) || !key) usage();
    const result = await sendCommand(config, platform, { op: "action", action, key, text: words.join(" ").trim() });
    process.stdout.write(`${result.delivered ? "delivered" : "pending"}\n`);
    return;
  }
  if (mode === "job") {
    const { verb, flags, positional } = jobArgs(rest);
    if (!["start", "cancel", "list"].includes(verb)) usage();
    const platform = flags.platform;
    if (!isPlatform(platform)) usage();
    if (verb === "list") {
      const lines = listJobs(config.stateFile(platform), typeof flags.key === "string" ? flags.key : null);
      process.stdout.write(`${lines.join("\n")}${lines.length ? "\n" : ""}`);
      return;
    }
    if (verb === "cancel") {
      const dedupe = jobCancelDedupe(flags, positional);
      if (!dedupe) usage();
      const sent = await sendCommand(config, platform, { op: "cancel", dedupe });
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
    const sent = await sendCommand(config, platform, {
      op: "schedule",
      key,
      dedupe,
      brief,
      dueAt,
      graceMs: durationMs(flags.grace, DEFAULT_GRACE_MS),
    });
    process.stdout.write(`${sent.delivered ? (dueAt ? "scheduled" : "started") : "pending"}\n`);
    process.exitCode = sent.delivered ? 0 : 1;
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
