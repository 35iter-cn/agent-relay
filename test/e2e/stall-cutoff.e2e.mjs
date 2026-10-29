#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.AGENT_RELAY_STALL_CHECK_MS = "1000";
process.env.AGENT_RELAY_TOOL_STALL_MS = "2000";

const { createCore } = await import("../../src/runtime/core.mjs");
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

for (const [name, body] of [
  ["thread.md", "conversation={{conversation}} user={{user_message}}"],
  ["notice.md", "NOTICE id={{notice_id}} prompt={{notice_prompt}}"],
  ["stall-instructions.md", "STALL-INSTRUCTIONS"],
  ["stall-actions.md", "ACTIONS platform={{platform}} key=<key>"],
]) writeFileSync(join(promptsDir, name), `${body}\n`);

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
  reply: async (inbound, text) => appendFileSync(repliesPath, `${JSON.stringify({ key: inbound.key, text })}\n`),
  postNotice: async (text) => {
    appendFileSync(repliesPath, `${JSON.stringify({ key: "notice", text })}\n`);
    return { messageId: `notice-${Date.now()}` };
  },
  onProgress: async () => ({ mode: "reaction", messageId: "m-1", name: "eyes" }),
  onProgressDone: async (ctx) => {
    progressSeen.push(ctx.progress);
  },
  buildWorker: () => ({ bin: "bash", args: ["-c", "sleep 600"] }),
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
mkdirSync(commandDir, { recursive: true });

let skew = 0;
const core = createCore({
  adapter,
  config,
  deps: {
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
writeFileSync(join(commandDir, `1-cancel.json`), `${JSON.stringify({ action: "cancel", key: KEY, at: isoAt(Date.now()) })}\n`);
await core.drainCommands();
await new Promise((resolve) => setTimeout(resolve, 500));

const state = readState();
const job = Object.values(state.jobs ?? {}).find((item) => item.key === KEY);
const replies = readReplies();
const replyText = replies.filter((item) => item.key === KEY).map((item) => item.text).join("\n");
const events = readEvents();
const usageRows = events.filter((event) => event.event === "usage");
const doneEvent = events.find((event) => event.event === "done" && event.job === job?.id);

check("E-1 the reply stamps the last progress, not the notice", replyText.includes(`到 ${localStamp(toolAt)}`) && !replyText.includes(`到 ${localStamp(Date.parse(stalled.stallNotifiedAt))}`), replyText.trim());
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
