import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS } from "../src/config.mjs";
import { createPlatform as slack } from "../src/platforms/slack.mjs";

const platform = "tc";
const config = {
  home: "/tmp/tc",
  cwd: "/tmp/tc",
  configDir: "/tmp/tc",
  logDir: "/tmp/tc/logs",
  sessionsDir: "/tmp/tc/sessions",
  promptsDir: "/tmp/tc/prompts",
  userPromptsDir: "/tmp/tc/user-prompts",
  uploadsDir: "/tmp/tc/uploads",
  cli: "agent-relay",
  configFile: "/tmp/tc/config.json",
  configProblem: null,
  options: DEFAULTS,
  platform: () => null,
  readEnv: () => ({}),
  envFile: (name) => `/tmp/tc/${name}`,
  stateFile: () => "/tmp/tc/state.json",
  commandDir: () => "/tmp/tc/cmd",
};

const factories = [
  ["slack", slack],
];

