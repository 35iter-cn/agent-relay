#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { createCore } = await import("../../src/runtime/core.mjs");
const { isoAt } = await import("../../src/shared/time.mjs");

const KEY = "e2e-nt-1";
const SESSION = "e2e-nt-1";
const WORKER_MS = 3_000;
const WAIT_MS = 20_000;

const dir = mkdtempSync(join(tmpdir(), "relay-e2e-nt-"));
const configDir = join(dir, ".config/agent-relay");
const logDir = join(configDir, "logs");
const sessionsDir = join(dir, "sessions");
const promptsDir = join(dir, "prompts");
const userPromptsDir = join(configDir, "prompts");
for (const path of [configDir, logDir, sessionsDir, promptsDir, userPromptsDir, join(configDir, "uploads")]) mkdirSync(path, { recursive: true });

const sectionsDir = join(promptsDir, "sections");
mkdirSync(sectionsDir, { recursive: true });
for (const [name, body] of [
  ["00-header-conversation.md", "conversation={{conversation}} user={{user_message}}"],
  ["01-header-notice.md", "NOTICE id={{notice_id}} prompt={{notice_prompt}}"],
]) writeFileSync(join(sectionsDir, name), `${body}\n`);

const repliesPath = join(dir, "replies.jsonl");

const adapter = {
  name: "e2e-nt",
  allowedUser: "u-1",
  chunkLimit: 4000,
  timeoutMs: 0,
  maxWorkers: 1,
  queueDepth: 1,
  worker: "pi",
  piBin: "bash",
  replyRules: "RULES",
  sessionFor: () => SESSION,
  reply: async (inbound, text) => (appendFileSync(repliesPath, `${JSON.stringify({ key: inbound.key, text })}\n`), { messageId: `reply-${Date.now()}` }),
  postNotice: async (text) => (appendFileSync(repliesPath, `${JSON.stringify({ key: "notice", text })}\n`), { messageId: `notice-${Date.now()}` }),
  buildWorker: () => ({ bin: "bash", args: ["-c", `sleep ${WORKER_MS / 1000}; echo worked-to-the-end`] }),
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
mkdirSync(config.commandDir(adapter.name), { recursive: true });

const core = createCore({
  adapter,
  config,
  deps: {
    log: (level, ...parts) => {
      if (level === "error" || level === "warn") process.stderr.write(`[${level}] ${parts.join(" ")}\n`);
    },
    stallGraceMs: 1_000,
    spawn,
  },
});

const sessionFile = join(sessionsDir, `2026-01-01T00-00-00_${SESSION}.jsonl`);
writeFileSync(
  sessionFile,
  `${JSON.stringify({ type: "message", id: "seed", timestamp: isoAt(Date.now()), message: { role: "assistant", content: [{ type: "text", text: "seed" }] } })}\n`
);

const failures = [];
const check = (name, ok, detail = "") => {
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
  process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name}${detail && !ok ? ` — ${detail}` : ""}\n`);
};

const readReplies = () =>
  readFileSync(repliesPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
const readEvents = () =>
  readdirSync(join(logDir, adapter.name))
    .map((name) => join(logDir, adapter.name, name))
    .flatMap((file) => readFileSync(file, "utf8").trim().split("\n").filter(Boolean))
    .map((line) => JSON.parse(line));

const startedAt = Date.now();
await core.handle({ key: KEY, session: SESSION, dedupeId: "m1", authorId: "u-1", text: "a turn that takes its time", chatId: "c1" });

while (Date.now() - startedAt < WAIT_MS) {
  let replies = [];
  try {
    replies = readReplies();
  } catch {}
  if (replies.length) break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}

const elapsed = Date.now() - startedAt;
const replies = readReplies();
const job = Object.values(JSON.parse(readFileSync(statePath, "utf8")).jobs ?? {})[0] ?? {};
const events = readEvents();
const answer = replies.map((reply) => reply.text).join("\n");

check("the turn was allowed to run past any built-in cap", elapsed >= WORKER_MS, `elapsed ${elapsed}ms`);
check("the worker's output came back intact", /worked-to-the-end/.test(answer), answer.slice(0, 200));
check("nothing was terminated for taking too long", !/已终止|超过 \d+ 分钟/.test(answer), answer.slice(0, 200));
check("the job ended delivered, not failed or cancelled", !/failed|cancelled|interrupted/.test(String(job.status)), String(job.status));
check("no timeout-stop event was written", !events.some((event) => event.event === "timeout-stop"));

if (failures.length) {
  process.stderr.write(`\n${failures.length} failure(s)\n`);
  process.exit(1);
}
process.stdout.write("\nno-timeout e2e ok\n");
