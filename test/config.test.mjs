import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createConfig, sessionsDirFor } from "../src/config.mjs";

const config = createConfig({ env: { HOME: "/home/tester" } });

test("the built-in prompts directory is the one that ships with the sources", () => {
  assert.equal(existsSync(join(config.promptsDir, "thread.md")), true);
  assert.equal(existsSync(join(config.promptsDir, "notice.md")), true);
  assert.equal(existsSync(join(config.promptsDir, "stall-actions.md")), true);
});

test("config paths default under ~/.config/agent-relay and stay overridable", () => {
  assert.equal(config.configDir, "/home/tester/.config/agent-relay");
  assert.equal(config.stateFile("feishu"), "/home/tester/.config/agent-relay/relay-feishu.json");
  assert.equal(config.commandDir("slack"), "/home/tester/.config/agent-relay/relay-slack.cmd");
  assert.equal(config.usagePromptFile, "/home/tester/.config/agent-relay/usage-prompt.json");
  const custom = createConfig({ env: { HOME: "/home/tester", AGENT_RELAY_CONFIG_DIR: "/srv/relay" } });
  assert.equal(custom.stateFile("feishu"), "/srv/relay/relay-feishu.json");
});

test("sessions live under the agent's session root for the working directory", () => {
  assert.equal(sessionsDirFor("/home/tester/code", "/home/tester"), "/home/tester/.pi/agent/sessions/--home-tester-code--");
});
