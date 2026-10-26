#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createConfig } from "./config.mjs";
import { ensurePrivateDir } from "./shared/fs.mjs";
import { readJson } from "./shared/json.mjs";
import { createLog } from "./shared/log.mjs";
import { createCore } from "./runtime/core.mjs";
import { createUsage } from "./runtime/usage.mjs";
import { createJev } from "./judgment/jev.mjs";
import { definePlatform, isPlatform, PLATFORMS } from "./platforms/contract.mjs";

export const ACTION_NAMES = new Set(["cancel", "restart"]);
const COMMAND_WAIT_MS = 20_000;
const COMMAND_POLL_MS = 500;

export function usage(stream = process.stderr) {
  stream.write(
    [
      "usage:",
      "  agent-relay serve <feishu|slack|telegram>",
      "  agent-relay notice emit --platform <p> (--text <text> | --text-file <path>) [--prompt <text> | --prompt-file <path>]",
      "  agent-relay notify <platform> <text>",
      "  agent-relay stall <platform> <cancel|restart> <key> [text]",
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

export async function sendCommand(config, platform, command, { waitMs = COMMAND_WAIT_MS, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const dir = config.commandDir(platform);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${Date.now()}-${process.pid}.json`);
  writeFileSync(file, `${JSON.stringify({ ...command, at: new Date().toISOString() })}\n`, { encoding: "utf8", mode: 0o600 });
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline && existsSync(file)) await sleep(COMMAND_POLL_MS);
  return { delivered: !existsSync(file), file };
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

async function serve(platform, config, log) {
  ensurePrivateDir(config.configDir);
  ensurePrivateDir(config.logDir);
  const adapter = await loadPlatform(platform, config, log);
  const jev = createJev({ env: { ...process.env, ...config.readEnv(config.envFile("jev.env")) }, log });
  const usagePrompt = readJson(config.usagePromptFile, null);
  if (!usagePrompt) log("warn", "usage-prompt", `missing ${config.usagePromptFile} — usage magic stays unconfigured`);
  const usageRecorder = createUsage({ dir: join(config.logDir, platform), judge: jev, prompt: usagePrompt, log });
  const core = createCore({ adapter, config, deps: { jev, usage: usageRecorder } });
  core.pruneLogs();
  setInterval(() => core.pruneLogs(), 86_400_000).unref();
  core.drainCommands().catch((error) => log("error", "command", String(error?.stack ?? error)));
  setInterval(() => core.drainCommands().catch((error) => log("error", "command", String(error?.stack ?? error))), 15_000).unref();
  await adapter.start({
    onMessage: (inbound) => core.handle(inbound),
    onReady: () => {
      core.onReady().catch((error) => log("error", "boot-notice", String(error?.stack ?? error)));
      core.recover().catch((error) => log("error", "recover", String(error?.stack ?? error)));
    },
    core,
  });
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
