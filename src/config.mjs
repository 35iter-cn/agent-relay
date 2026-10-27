import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { log as defaultLog } from "./shared/log.mjs";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

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
  return {
    home,
    cwd,
    configDir,
    logDir: join(configDir, "logs"),
    sessionsDir: env.AGENT_RELAY_SESSIONS_DIR ?? sessionsDirFor(cwd, home),
    promptsDir: join(SRC_DIR, "prompts"),
    userPromptsDir: join(configDir, "prompts"),
    usagePromptFile: join(configDir, "usage-prompt.json"),
    uploadsDir: join(configDir, "uploads"),
    cli: env.AGENT_RELAY_CLI ?? "agent-relay",
    readEnv: (file) => readEnvFile(file),
    envFile: (name) => join(configDir, name),
    stateFile: (platform) => join(configDir, `relay-${platform}.json`),
    commandDir: (platform) => join(configDir, `relay-${platform}.cmd`),
    log: defaultLog,
  };
}
