import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULTS, createConfig, resolveOptions, sessionsDirFor } from "../src/config.mjs";
import { timeZone } from "../src/shared/time.mjs";

function configDirWith(body) {
  const dir = join(mkdtempSync(join(tmpdir(), "relay-config-")), "agent-relay");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (body !== undefined) writeFileSync(join(dir, "config.json"), typeof body === "string" ? body : JSON.stringify(body), { mode: 0o600 });
  return dir;
}

const config = createConfig({ env: { HOME: "/home/tester" } });

test("the built-in prompts directory is the one that ships with the sources", () => {
  for (const file of ["sections/10-common.md", "sections/20-platform-slack.md", "sections/21-platform-feishu.md", "sections/30-entry-conversation.md", "sections/31-entry-notice.md", "sections/32-entry-loop.md"]) {
    assert.equal(existsSync(join(config.promptsDir, file)), true, file);
  }
  for (const file of ["messages/stall-notice.md", "messages/restart.md", "messages/interrupt.md", "messages/empty-prompt.md"]) {
    assert.equal(existsSync(join(config.promptsDir, file)), true, file);
  }
});

test("config paths default under ~/.config/agent-relay and stay overridable", () => {
  assert.equal(config.configDir, "/home/tester/.config/agent-relay");
  assert.equal(config.stateFile("feishu"), "/home/tester/.config/agent-relay/relay-feishu.json");
  assert.equal(config.commandDir("slack"), "/home/tester/.config/agent-relay/relay-slack.cmd");
  const custom = createConfig({ env: { HOME: "/home/tester", AGENT_RELAY_CONFIG_DIR: "/srv/relay" } });
  assert.equal(custom.stateFile("feishu"), "/srv/relay/relay-feishu.json");
});

test("TC-CFG9 the worker binary comes from config.json and the env override is gone", () => {
  assert.equal(config.workerBin, "pi");
  const dir = configDirWith({ relay: { worker: { bin: "/opt/pi/bin/pi" } } });
  const custom = createConfig({ env: { HOME: "/home/tester", AGENT_RELAY_CONFIG_DIR: dir } });
  assert.equal(custom.workerBin, "/opt/pi/bin/pi");
  assert.equal(custom.configProblem, null);
  const ignored = createConfig({ env: { HOME: "/home/tester", AGENT_RELAY_CONFIG_DIR: dir, AGENT_RELAY_WORKER_BIN: "/usr/bin/other" } });
  assert.equal(ignored.workerBin, "/opt/pi/bin/pi");
});

test("TC-CFG10 an empty relay section resolves to the shipped defaults", () => {
  const { options, problems } = resolveOptions({});
  assert.deepEqual(problems, []);
  assert.deepEqual(options, DEFAULTS);
  assert.deepEqual(DEFAULTS.relay, {
    timeZone: "",
    worker: { bin: "pi" },
    turn: { roundMaxMs: 5_400_000 },
    queue: { maxWorkers: 5, depth: 3 },
    stall: { silenceMs: 600_000, toolMs: 600_000, checkMs: 60_000 },
    budget: { keyWindowMs: 21_600_000, keyWindowMaxMs: 10_800_000, graceMs: 600_000 },
    loop: { noticeMs: 2_700_000, renoticeMs: 7_200_000, noticeMax: 3, parkMs: 21_600_000 },
    restart: { waitMs: 3_600_000, settleMs: 15_000, healthMs: 60_000, unit: "agent-relay@%p" },
  });
});

test("TC-CFG11 a configured key overrides only itself", () => {
  const { options, problems } = resolveOptions({ stall: { silenceMs: 1_000 }, queue: { depth: 1 } });
  assert.deepEqual(problems, []);
  assert.equal(options.relay.stall.silenceMs, 1_000);
  assert.equal(options.relay.stall.toolMs, DEFAULTS.relay.stall.toolMs);
  assert.equal(options.relay.queue.depth, 1);
  assert.equal(options.relay.queue.maxWorkers, 5);
});

test("TC-CFG12 bad values, unknown keys and removed keys are refused with their key", () => {
  const cases = [
    [{ stall: { silenceMs: "10m" } }, "relay.stall.silenceMs"],
    [{ stall: { silenceMs: -1 } }, "relay.stall.silenceMs"],
    [{ turn: { roundMax: 1 } }, "relay.turn.roundMax"],
    [{ worker: { mode: "print" } }, "relay.worker.mode"],
    [{ worker: { steer: true } }, "relay.worker.steer"],
    [{ turn: { timeoutMs: 1 } }, "relay.turn.timeoutMs"],
    [{ stall: { actionMs: 1 } }, "relay.stall.actionMs"],
  ];
  for (const [section, key] of cases) {
    const { problems } = resolveOptions(section);
    assert.equal(problems.length, 1, JSON.stringify(section));
    assert.match(problems[0], new RegExp(key.replaceAll(".", "\\.")), JSON.stringify(section));
  }
});

test("TC-CFG13 a missing or broken config.json is reported, not guessed at", () => {
  const empty = createConfig({ env: { HOME: "/home/tester", AGENT_RELAY_CONFIG_DIR: configDirWith() } });
  assert.match(empty.configProblem, /missing-config/);
  assert.equal(empty.config, null);
  const broken = createConfig({ env: { HOME: "/home/tester", AGENT_RELAY_CONFIG_DIR: configDirWith("{oops") } });
  assert.match(broken.configProblem, /bad-config/);
  assert.equal(broken.options.relay.queue.maxWorkers, 5);
});

test("TC-CFG14 platform sections are read whole, credentials included", () => {
  const dir = configDirWith({ slack: { botToken: "xoxb-1", groups: { main: "C1" }, defaultGroup: "main" } });
  const custom = createConfig({ env: { HOME: "/home/tester", AGENT_RELAY_CONFIG_DIR: dir } });
  assert.equal(custom.platform("slack").botToken, "xoxb-1");
  assert.equal(custom.platform("feishu"), null);
  assert.equal(custom.configFile, join(dir, "config.json"));
});

test("sessions live under the agent's session root for the working directory", () => {
  assert.equal(sessionsDirFor("/home/tester/code", "/home/tester"), "/home/tester/.pi/agent/sessions/--home-tester-code--");
});

test("TC-CFG11 relay.timeZone reaches the process, and an empty value means the machine zone", () => {
  const dir = configDirWith({ relay: { timeZone: "Europe/Berlin" } });
  createConfig({ env: { HOME: "/home/tester", AGENT_RELAY_CONFIG_DIR: dir } });
  assert.equal(timeZone(), "Europe/Berlin");
  const plain = configDirWith({});
  createConfig({ env: { HOME: "/home/tester", AGENT_RELAY_CONFIG_DIR: plain } });
  assert.equal(timeZone(), new Intl.DateTimeFormat().resolvedOptions().timeZone);
});

test("TC-CFG12 a zone name Intl does not know is refused like any other bad key", () => {
  const { options, problems } = resolveOptions({ timeZone: "Asia/Shanghia" });
  assert.equal(options, DEFAULTS);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /relay\.timeZone: expected "" or an IANA zone name/);
  const ok = resolveOptions({ timeZone: "Asia/Tokyo" });
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.options.relay.timeZone, "Asia/Tokyo");
  assert.deepEqual(resolveOptions({ timeZone: 9 }).problems.length, 1);
});
