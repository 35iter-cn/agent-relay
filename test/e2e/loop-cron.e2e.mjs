#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { createCore } = await import("../../src/runtime/core.mjs");
const { emptyState } = await import("../../src/state/schema.mjs");
const { writeJsonAtomic } = await import("../../src/shared/json.mjs");
const { handleLoopCommand } = await import("../../src/cli.mjs");
const { loopDueAt } = await import("../../src/loops/schedule.mjs");
const { listRounds } = await import("../../src/loops/history.mjs");

const dir = mkdtempSync(join(tmpdir(), "relay-loop-cron-e2e-"));
const configDir = join(dir, ".config/agent-relay");
const logDir = join(configDir, "logs");
const sessionsDir = join(dir, "sessions");
const promptsDir = join(dir, "prompts");
const sectionsDir = join(promptsDir, "sections");
for (const path of [configDir, logDir, sessionsDir, promptsDir, sectionsDir, join(configDir, "loops"), join(configDir, "uploads")]) {
  mkdirSync(path, { recursive: true });
}
for (const [name, body] of [
  ["00-header-loop.md", "LOOP={{loop_id}} ROUND={{loop_round}}"],
  ["12-loop-task.md", "{{loop_prompt}}"],
  ["20-reply.md", "REPLY"],
  ["21-surface.md", "SURFACE"],
]) {
  writeFileSync(join(sectionsDir, name), `${body}\n`);
}

const repliesPath = join(dir, "replies.jsonl");
const dispatched = [];

const config = {
  home: dir,
  cwd: dir,
  configDir,
  logDir,
  sessionsDir,
  promptsDir,
  userPromptsDir: join(configDir, "prompts"),
  uploadsDir: join(configDir, "uploads"),
  loopHistoryDir: join(configDir, "loops"),
  cli: "agent-relay",
  readEnv: () => ({}),
  envFile: (name) => join(configDir, name),
  stateFile: (platform) => join(configDir, `relay-${platform}.json`),
  commandDir: (platform) => join(configDir, `relay-${platform}.cmd`),
};

const adapter = {
  name: "slack",
  allowedUser: "u-1",
  chunkLimit: 4000,
  timeoutMs: 120_000,
  maxWorkers: 1,
  queueDepth: 1,
  worker: "pi",
  piBin: "bash",
  sessionFor: (key) => `fs-${key}`,
  reply: async (ctx, text) => appendFileSync(repliesPath, `${JSON.stringify({ key: ctx.key, text })}\n`),
  postNotice: async (text) => {
    appendFileSync(repliesPath, `${JSON.stringify({ key: "notice", text })}\n`);
    return { messageId: `notice-${Date.now()}` };
  },
  buildWorker: ({ prompt }) => {
    dispatched.push(prompt);
    return { bin: "bash", args: ["-c", "echo 这一轮做完了"] };
  },
};

writeJsonAtomic(config.stateFile(adapter.name), emptyState());
mkdirSync(config.commandDir(adapter.name), { recursive: true });

const core = createCore({ adapter, config, deps: { log: () => {}, spawn: (bin, args, options) => spawn(bin, args, options) } });

const failures = [];
const check = (name, ok, detail = "") => {
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
  process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name}${detail && !ok ? ` — ${detail}` : ""}\n`);
};
const readReplies = () =>
  existsSync(repliesPath)
    ? readFileSync(repliesPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const drainer = setInterval(() => core.drainCommands().catch(() => {}), 50);
try {
  await handleLoopCommand(["create", "--platform", "slack", "--cron", "* * * * *", "--prompt", "看 CI"], config, () => {}, {
    env: { AGENT_RELAY_PLATFORM: "slack" },
  });
} finally {
  clearInterval(drainer);
}
await core.drainCommands();

const created = core.state.loops["loop-slack-1"];
check("the CLI command file creates a cron loop in the daemon", created?.cron === "* * * * *", JSON.stringify(created?.cron));
check("the cron loop carries no interval and no one-shot moment", created?.every === null && created?.at === null);

core.state.loops["loop-slack-1"].lastRunAt = new Date(Date.now() - 5 * 60_000).toISOString();
core.save();
const firstTick = await core.startDueLoops();
await wait(1500);
check("a due cron loop starts exactly one round", firstTick === 1, `started=${firstTick}`);
check("the round runs in a fresh session", Object.values(core.state.jobs).some((job) => job.origin === "loop" && job.key === "loop-slack-1-r1"));
check("the round output is posted once", readReplies().length === 1, JSON.stringify(readReplies().map((item) => item.key)));
const afterRound = core.state.loops["loop-slack-1"];
check("the cron loop stays armed after its round", afterRound.state === "armed", afterRound.state);
check("the round is recorded as ok", afterRound.lastOutcome === "ok", afterRound.lastOutcome);
check("the history holds one round", listRounds(config.loopHistoryDir, "loop-slack-1").length === 1);

const nextDue = loopDueAt(afterRound);
check("the next round is the next cron minute", Number.isFinite(nextDue) && nextDue > Date.now() && nextDue % 60_000 === 0, `${nextDue}`);
const secondTick = await core.startDueLoops();
check("a tick before the next match starts nothing", secondTick === 0, `started=${secondTick}`);

const listCli = [];
const stdout = process.stdout.write;
process.stdout.write = (chunk) => (listCli.push(String(chunk)), true);
try {
  await handleLoopCommand(["show", "loop-slack-1"], config, () => {});
} finally {
  process.stdout.write = stdout;
}
check("loop show prints the cron schedule", /schedule: cron \* \* \* \* \*/.test(listCli.join("")), listCli.join(""));

if (failures.length) {
  process.stdout.write(`\n${failures.length} failed:\n${failures.map((item) => `- ${item}`).join("\n")}\n`);
  process.exit(1);
}
process.stdout.write("ok\n");
