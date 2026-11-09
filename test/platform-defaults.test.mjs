import test from "node:test";
import assert from "node:assert/strict";
import { createPlatform as slack } from "../src/platforms/slack.mjs";
import { createPlatform as discord } from "../src/platforms/discord.mjs";
import { createPlatform as feishu } from "../src/platforms/feishu.mjs";
import { createPlatform as telegram } from "../src/platforms/telegram.mjs";
import { createPlatform as mattermost } from "../src/platforms/mattermost.mjs";

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
  readEnv: () => ({}),
  envFile: (name) => `/tmp/tc/${name}`,
  stateFile: () => "/tmp/tc/state.json",
  commandDir: () => "/tmp/tc/cmd",
};

const factories = [
  ["slack", slack],
  ["discord", discord],
  ["feishu", feishu],
  ["telegram", telegram],
  ["mattermost", mattermost],
];

test("TC-RPC11 every platform defaults to the rpc worker with steer on", () => {
  delete process.env.AGENT_RELAY_WORKER_MODE;
  delete process.env.RELAY_WORKER_MODE;
  delete process.env.AGENT_RELAY_STEER;
  delete process.env.RELAY_STEER;
  for (const [name, create] of factories) {
    const adapter = create({ config, log: () => {} });
    assert.equal(adapter.workerMode, "rpc", `${name} workerMode`);
    assert.equal(adapter.steer, "on", `${name} steer`);
  }
});
