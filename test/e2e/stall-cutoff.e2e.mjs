#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";


const { createCore } = await import("../../src/runtime/core.mjs");
const { DEFAULTS } = await import("../../src/config.mjs");
const { e2eWorker } = await import("../fixtures/rpc-e2e.mjs");
const { localDay, localStamp, isoAt } = await import("../../src/shared/time.mjs");

const KEY = "e2e-th-1";
const SESSION = "e2e-th-1";
const JOB_START_SKEW_MS = 180_000;
const STALL_WAIT_MS = 10_000;

const dir = mkdtempSync(join(tmpdir(), "relay-e2e-"));
const configDir = join(dir, ".config/agent-relay");
const logDir = join(configDir, "logs");
const sessionsDir = join(dir, "sessions");
const promptsDir = join(dir, "prompts");
const userPromptsDir = join(configDir, "prompts");
for (const path of [configDir, logDir, sessionsDir, promptsDir, userPromptsDir, join(configDir, "uploads")]) mkdirSync(path, { recursive: true });

const sectionsDir = join(promptsDir, "sections");
mkdirSync(sectionsDir, { recursive: true });
for (const [name, body] of [
  ["10-common.md", "COMMON {{surface}}"],
  ["20-platform-fake.md", "REPLY"],
  ["20-platform-e2e.md", "REPLY"],
  ["20-platform-e2e-nt.md", "REPLY"],
  ["30-entry-conversation.md", "CONV user={{user_message}}"],
  ["31-entry-notice.md", "NOTICE id={{notice_id}}"],
]) writeFileSync(join(sectionsDir, name), `${body}\n`);
const messagesDir = join(promptsDir, "messages");
mkdirSync(messagesDir, { recursive: true });
for (const [name, body] of [
  ["stall-notice.md", "Task: {{task}}\nJob: {{job}}\nLast progress: {{last_progress}}"],
  ["restart.md", "RESTART"],
  ["interrupt.md", "INTERRUPTED"],
  ["empty-prompt.md", "EMPTY {{prompts_dir}}"],
  ["terminated-cancel.md", "TERMINATED-ON-REQUEST ({{job}}) {{elapsed_minutes}} min, {{from}} -> {{to}}"],
  ["terminated-stalled.md", "TERMINATED-AFTER-STALL ({{job}}) last progress {{last_progress}}; {{elapsed_minutes}} min, {{from}} -> {{to}}"],
  ["terminated-restart.md", "RESTARTED ({{job}}) {{elapsed_minutes}} min, {{from}} -> {{to}}"],
  ["terminated-loop.md", "TERMINATED-LOOP ({{job}}) {{elapsed_minutes}} min, {{from}} -> {{to}}"],
]) writeFileSync(join(messagesDir, name), `${body}\n`);

const repliesPath = join(dir, "replies.jsonl");
const progressSeen = [];
let workerPid = null;

const adapter = {
  name: "e2e",
  allowedUser: "u-1",
  chunkLimit: 4000,
  timeoutMs: 120_000,
  maxWorkers: 1,
  queueDepth: 1,
  worker: "pi",
  piBin: "bash",
  replyRules: "RULES",
  sessionFor: () => SESSION,
  reply: async (inbound, text) => (appendFileSync(repliesPath, `${JSON.stringify({ key: inbound.key, text })}\n`), { messageId: `reply-${Date.now()}` }),
  postNotice: async (text) => {
    appendFileSync(repliesPath, `${JSON.stringify({ key: "notice", text })}\n`);
    return { messageId: `notice-${Date.now()}` };
  },
  onProgress: async () => ({ mode: "reaction", messageId: "m-1", name: "eyes" }),
  onProgressDone: async (ctx) => {
    progressSeen.push(ctx.progress);
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
  configFile: join(configDir, "config.json"),
  configProblem: null,
  options: { relay: { ...DEFAULTS.relay, stall: { silenceMs: 2_000, toolMs: 2_000, checkMs: 500 } } },
  platform: () => null,
  readEnv: () => ({}),
  envFile: (name) => join(configDir, name),
  stateFile: (platform) => join(configDir, `relay-${platform}.json`),
  commandDir: (platform) => join(configDir, `relay-${platform}.cmd`),
};

const statePath = config.stateFile(adapter.name);
const commandDir = config.commandDir(adapter.name);
const jobId = () => Object.values(readState().jobs).filter((job) => job.key === KEY).at(-1)?.id;
mkdirSync(commandDir, { recursive: true });

let skew = 0;
const core = createCore({
  adapter,
  config,
  deps: {
    workerFactory: e2eWorker(),
    now: () => Date.now() + skew,
    log: (level, ...parts) => {
      if (level === "error" || level === "warn") process.stderr.write(`[${level}] ${parts.join(" ")}\n`);
    },
    stallGraceMs: 1_000,
    spawn: (bin, args, options) => {
      const child = spawn(bin, args, options);
      workerPid = child.pid ?? null;
      return child;
    },
  },
});

const sessionFile = join(sessionsDir, `2026-01-01T00-00-00_${SESSION}.jsonl`);
const message = (payload) => `${JSON.stringify({ type: "message", ...payload })}\n`;
writeFileSync(sessionFile, message({ id: "seed", timestamp: isoAt(Date.now()), message: { role: "assistant", content: [{ type: "text", text: "seed" }] } }));

const failures = [];
const check = (name, ok, detail = "") => {
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
  process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name}${detail && !ok ? ` — ${detail}` : ""}\n`);
};

const readState = () => JSON.parse(readFileSync(statePath, "utf8"));
const readEvents = () =>
  readdirSync(join(logDir, adapter.name))
    .map((name) => join(logDir, adapter.name, name))
    .flatMap((file) => readFileSync(file, "utf8").trim().split("\n").filter(Boolean))
    .map((line) => JSON.parse(line));
const readReplies = () =>
  existsSync(repliesPath)
    ? readFileSync(repliesPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];

const alive = (pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
};

skew = -JOB_START_SKEW_MS;
await core.handle({ key: KEY, session: SESSION, dedupeId: "m1", authorId: "u-1", text: "e2e stall", chatId: "c1" });
skew = 0;

const toolAt = Date.now();
writeFileSync(
  sessionFile,
  message({
    id: "a1",
    timestamp: isoAt(toolAt),
    message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "sleep 600" } }] },
  }),
);

const notified = async () => {
  const deadline = Date.now() + STALL_WAIT_MS;
  while (Date.now() < deadline) {
    const job = Object.values(readState().jobs ?? {}).find((item) => item.key === KEY);
    if (job?.stallNotifiedAt) return job;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
};

const stalled = await notified();
if (!stalled) {
  process.stdout.write("FAIL E-1 stall notice never arrived\n");
  process.exit(1);
}

await new Promise((resolve) => setTimeout(resolve, 2_000));
writeFileSync(join(commandDir, `1-cancel.json`), `${JSON.stringify({ op: "cancel-job", job: jobId(), at: isoAt(Date.now()) })}\n`);
await core.drainCommands();
await new Promise((resolve) => setTimeout(resolve, 500));

const state = readState();
const job = Object.values(state.jobs ?? {}).find((item) => item.key === KEY);
const replies = readReplies();
const replyText = replies.filter((item) => item.key === KEY).map((item) => item.text).join("\n");
const events = readEvents();
const usageRows = events.filter((event) => event.event === "usage");
const doneEvent = events.find((event) => event.event === "done" && event.job === job?.id);

check(
  "E-1 the reply stamps the last progress, not the notice",
  replyText.includes("TERMINATED-AFTER-STALL") &&
    replyText.includes(`last progress ${localStamp(toolAt)}`) &&
    !replyText.includes(localStamp(Date.parse(stalled.stallNotifiedAt))) &&
    !/billed|计入/.test(replyText),
  replyText.trim(),
);
check("E-1b the receipt reports the stop basis as progress", job?.cutoffBasis === "progress", `cutoffBasis=${job?.cutoffBasis}`);
check("E-2 the job carries the cutoff equal to the last progress", job?.cutoffAt === isoAt(toolAt), `cutoffAt=${job?.cutoffAt} expected=${isoAt(toolAt)}`);
check("E-3 no usage row is written for a cancelled run", usageRows.length === 0, JSON.stringify(usageRows));
check(
  "E-4 the done event keeps the real lifetime, longer than the billed cutoff",
  Number.isFinite(doneEvent?.elapsedMs) && doneEvent.elapsedMs > toolAt - job.startedAt,
  `elapsedMs=${doneEvent?.elapsedMs} billed=${toolAt - (job?.startedAt ?? 0)}`,
);
check("E-5 the worker process is gone", Boolean(workerPid) && !alive(workerPid), `pid=${workerPid}`);
check("E-6 progress is cleared after the reaction is done", job?.progress === null && progressSeen.length > 0 && Boolean(progressSeen[0]), `progress=${JSON.stringify(job?.progress)} seen=${JSON.stringify(progressSeen)}`);

check("E-7 relay wrote no agent-hours ledger", !existsSync(join(dir, ".config/agent-hours")));

if (failures.length) {
  process.stderr.write(`\n${failures.length} failed:\n${failures.map((item) => `  ${item}`).join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`\nall e2e checks passed in ${dir}\n`);
process.exit(0);
