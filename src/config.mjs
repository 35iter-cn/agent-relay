import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { log as defaultLog } from "./shared/log.mjs";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

export const CONFIG_FILE = "config.json";

// The only overridable values. Everything else a platform needs (tokens, chats,
// groups) is required in config.json; everything else the runtime needs is a
// constant in the module that owns it.
export const DEFAULTS = {
  relay: {
    worker: { bin: "pi" },
    turn: { roundMaxMs: 90 * 60_000 },
    queue: { maxWorkers: 5, depth: 3 },
    stall: { silenceMs: 10 * 60_000, toolMs: 10 * 60_000, checkMs: 60_000 },
    budget: { keyWindowMs: 6 * 3_600_000, keyWindowMaxMs: 3 * 3_600_000, graceMs: 10 * 60_000 },
    loop: { noticeMs: 45 * 60_000, renoticeMs: 2 * 3_600_000, noticeMax: 3, parkMs: 6 * 3_600_000 },
  },
};

// Keys removed because the behaviour behind them is now the only behaviour.
export const REMOVED_KEYS = {
  "relay.worker.mode": "RPC 是唯一模式",
  "relay.worker.steer": "steer 一律开启",
  "relay.turn.timeoutMs": "单轮没有墙钟熔断，边界是预算与 park",
  "relay.stall.actionMs": "卡住通知不会自动终止任务",
};

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function flatten(value, prefix = "", out = {}) {
  for (const [key, child] of Object.entries(value ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(child)) flatten(child, path, out);
    else out[path] = child;
  }
  return out;
}

function unflatten(flat) {
  const out = {};
  for (const [path, value] of Object.entries(flat)) {
    const parts = path.split(".");
    let cursor = out;
    for (const part of parts.slice(0, -1)) cursor = cursor[part] = cursor[part] ?? {};
    cursor[parts.at(-1)] = value;
  }
  return out;
}

export function resolveOptions(section = {}) {
  const problems = [];
  if (section !== undefined && !isPlainObject(section)) {
    return { options: DEFAULTS, problems: ["relay: expected an object"] };
  }
  const defaults = flatten(DEFAULTS.relay);
  const given = flatten(section ?? {});
  for (const [path, value] of Object.entries(given)) {
    if (REMOVED_KEYS[`relay.${path}`]) {
      problems.push(`relay.${path}: 已移除（${REMOVED_KEYS[`relay.${path}`]}），不能再配置`);
      continue;
    }
    if (!(path in defaults)) {
      problems.push(`relay.${path}: 未定义的键`);
      continue;
    }
    const expected = defaults[path];
    if (typeof expected === "number") {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        problems.push(`relay.${path}: expected a non-negative number, got ${JSON.stringify(value)}`);
      }
      continue;
    }
    if (typeof value !== typeof expected || String(value).trim() === "") {
      problems.push(`relay.${path}: expected a non-empty string, got ${JSON.stringify(value)}`);
    }
  }
  if (problems.length) return { options: DEFAULTS, problems };
  return { options: { relay: unflatten({ ...defaults, ...given }) }, problems: [] };
}

export function readConfigFile(file) {
  if (!existsSync(file)) return { file, missing: true };
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return { file, problem: `bad-config: ${String(error?.message ?? error)}` };
  }
  if (!isPlainObject(raw)) return { file, problem: "bad-config: not-an-object" };
  return { file, config: raw };
}

export function readEnvFile(file) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) out[match[1]] = match[2].trim();
  }
  return out;
}

export function sessionsDirFor(cwd, home) {
  const slug = join(cwd).replace(/^\//, "").replace(/[/\\:]/g, "-");
  return join(home, ".pi/agent/sessions", `--${slug}--`);
}

export function createConfig({ env = process.env } = {}) {
  const home = env.HOME;
  const configDir = env.AGENT_RELAY_CONFIG_DIR ?? join(home, ".config/agent-relay");
  const cwd = env.AGENT_RELAY_WORKDIR ?? join(home, "code");
  const file = join(configDir, CONFIG_FILE);
  const loaded = readConfigFile(file);
  const resolved = resolveOptions(loaded.config?.relay);
  const problem = loaded.missing
    ? `missing-config: ${file}`
    : loaded.problem ?? (resolved.problems.length ? `bad-config: ${resolved.problems.join("; ")}` : null);
  return {
    home,
    cwd,
    configDir,
    configFile: file,
    config: loaded.config ?? null,
    configProblem: problem,
    options: resolved.options,
    workerBin: resolved.options.relay.worker.bin,
    logDir: join(configDir, "logs"),
    sessionsDir: env.AGENT_RELAY_SESSIONS_DIR ?? sessionsDirFor(cwd, home),
    promptsDir: join(SRC_DIR, "prompts"),
    userPromptsDir: join(configDir, "prompts"),
    uploadsDir: join(configDir, "uploads"),
    loopHistoryDir: join(configDir, "loops"),
    cli: "agent-relay",
    readEnv: (path) => readEnvFile(path),
    envFile: (name) => join(configDir, name),
    stateFile: (platform) => join(configDir, `relay-${platform}.json`),
    commandDir: (platform) => join(configDir, `relay-${platform}.cmd`),
    platform: (name) => (loaded.config?.[name] && typeof loaded.config[name] === "object" ? loaded.config[name] : null),
    log: defaultLog,
  };
}
