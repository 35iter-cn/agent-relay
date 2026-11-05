#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { createCore } = await import("../../src/runtime/core.mjs");
const { isoAt } = await import("../../src/shared/time.mjs");
const { writeJsonAtomic } = await import("../../src/shared/json.mjs");
const { emptyState } = await import("../../src/state/schema.mjs");

const KEY = "th-e2e";
const SESSION = "fs-th-e2e";

const dir = mkdtempSync(join(tmpdir(), "relay-schedule-e2e-"));
const configDir = join(dir, ".config/agent-relay");
const logDir = join(configDir, "logs");
const sessionsDir = join(dir, "sessions");
const promptsDir = join(dir, "prompts");
const userPromptsDir = join(configDir, "prompts");
for (const path of [configDir, logDir, sessionsDir, promptsDir, userPromptsDir, join(configDir, "uploads")]) mkdirSync(path, { recursive: true });
const sectionsDir = join(promptsDir, "sections");
mkdirSync(sectionsDir, { recursive: true });
for (const [name, body] of [
  ["00-header-conversation.md", "conversation={{conversation}}"],
  ["45-self-wake.md", "SELF-WAKE"],
]) writeFileSync(join(sectionsDir, name), `${body}\n`);
writeFileSync(join(promptsDir, "self-job.md"), "PROVENANCE {{provenance}}\nDUE {{due_at}}\nAT {{delivered_at}}\nLATE {{late_note}}\nCHAIN {{chain}}\nBRIEF {{brief}}\n");

const repliesPath = join(dir, "replies.jsonl");
const dispatched = [];

const adapter = {
  name: "e2e",
  allowedUser: "u-1",
  chunkLimit: 4000,
  timeoutMs: 120_000,
  maxWorkers: 1,
  queueDepth: 1,
  worker: "pi",
  piBin: "bash",
  sessionFor: () => SESSION,
  reply: async (inbound, text) => appendFileSync(repliesPath, `${JSON.stringify({ key: inbound.key, text })}\n`),
  postNotice: async (text) => {
    appendFileSync(repliesPath, `${JSON.stringify({ key: "notice", text })}\n`);
    return { messageId: `notice-${Date.now()}` };
  },
  selfContext: (key) => ({ chatId: "c1", threadId: null, replyTo: key }),
  buildWorker: ({ prompt }) => {
    dispatched.push(prompt);
    return { bin: "bash", args: ["-c", prompt.includes("SLOW") ? "sleep 30" : "echo 这一轮做完了"] };
  },
};

const config = {
  home: dir,
  cwd: dir,
  configDir,
  logDir,
  sessionsDir,
  promptsDir,
  userPromptsDir,
  uploadsDir: join(configDir, "uploads"),
  cli: "agent-relay",
  readEnv: () => ({}),
  envFile: (name) => join(configDir, name),
  stateFile: (platform) => join(configDir, `relay-${platform}.json`),
  commandDir: (platform) => join(configDir, `relay-${platform}.cmd`),
};
const statePath = config.stateFile(adapter.name);
const commandDir = config.commandDir(adapter.name);
writeJsonAtomic(statePath, emptyState());
mkdirSync(commandDir, { recursive: true });

let skew = 0;
const makeCore = () =>
  createCore({
    adapter,
    config,
    deps: {
      now: () => Date.now() + skew,
      log: () => {},
      stallGraceMs: 500,
      spawn: (bin, args, options) => spawn(bin, args, options),
    },
  });

const failures = [];
const check = (name, ok, detail = "") => {
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
  process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name}${detail && !ok ? ` — ${detail}` : ""}\n`);
};
const readState = () => JSON.parse(readFileSync(statePath, "utf8"));
const readReplies = () =>
  existsSync(repliesPath)
    ? readFileSync(repliesPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
const readEvents = () =>
  readdirSync(join(logDir, adapter.name))
    .map((name) => join(logDir, adapter.name, name))
    .flatMap((file) => readFileSync(file, "utf8").trim().split("\n").filter(Boolean))
    .map((line) => JSON.parse(line));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const core1 = makeCore();
core1.state.convs[KEY] = { session: SESSION, rootText: "", lastMsgTs: null, activeJob: null };
core1.save();

const command = (payload) => {
  const file = join(commandDir, `${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...payload })}\n`);
};
const drain = async (core) => {
  await core.drainCommands();
  await wait(150);
};

command({ op: "schedule", key: KEY, dedupe: "d-late", brief: "读进度", dueAt: new Date(Date.now() + 30_000).toISOString(), graceMs: 6 * 3_600_000 });
await drain(core1);
const scheduled = Object.values(readState().jobs).find((job) => job.inbound?.dedupeId === "d-late");
check("schedule lands as scheduled without spawning", scheduled?.status === "scheduled" && dispatched.length === 0, scheduled?.status);

skew = 31_000;
const core2 = makeCore();
await core2.recover();
const afterRecover = Object.values(readState().jobs).find((job) => job.inbound?.dedupeId === "d-late");
check("recover leaves a scheduled job alone instead of interrupting it", afterRecover?.status === "scheduled", afterRecover?.status);

core2.startDueJobs();
await wait(400);
const delivered = Object.values(readState().jobs).find((job) => job.inbound?.dedupeId === "d-late");
check("a missed due time still starts the turn once", dispatched.length === 1, `dispatched=${dispatched.length}`);
check("the late delay is recorded", (delivered?.lateMs ?? 0) >= 1000 && (delivered?.lateMs ?? 0) < 60_000, `${delivered?.lateMs}`);
check("the wake prompt carries the brief and provenance", /PROVENANCE/.test(dispatched[0] ?? "") && /读进度/.test(dispatched[0] ?? ""));
check("the turn replies once", readReplies().filter((item) => item.key === KEY).length === 1);
check("the event log records job-due", readEvents().some((event) => event.event === "job-due"));
skew = 31_000;
core2.startDueJobs();
await wait(300);
check("a second sweep starts nothing new", dispatched.length === 1, `dispatched=${dispatched.length}`);

command({ op: "schedule", key: KEY, dedupe: "d-slow", brief: "SLOW 这一轮会跑很久", dueAt: null });
await drain(core2);
await wait(400);
const running = Object.values(readState().jobs).find((job) => job.inbound?.dedupeId === "d-slow");
check("an immediate schedule starts a turn", running?.status === "running", running?.status);

const noticesBefore = readReplies().filter((item) => item.key === "notice").length;
const core3 = makeCore();
await core3.recover();
await wait(600);
const interrupted = Object.values(readState().jobs).find((job) => job.inbound?.dedupeId === "d-slow");
check("a restart drops the scheduled turn instead of interrupting it visibly", interrupted?.status === "cancelled", interrupted?.status);
check("no interrupt notice is posted for a scheduled turn", readReplies().filter((item) => item.key === "notice").length === noticesBefore);

if (failures.length) {
  process.stderr.write(`\n${failures.length} failure(s):\n${failures.map((item) => ` - ${item}`).join("\n")}\n`);
  process.exit(1);
}
process.stdout.write("ok\n");
