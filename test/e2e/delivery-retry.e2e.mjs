#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { createCore } = await import("../../src/runtime/core.mjs");
const { isoAt } = await import("../../src/shared/time.mjs");

const KEY = "e2e-th-delivery";
const SESSION = "e2e-th-delivery";

const dir = mkdtempSync(join(tmpdir(), "relay-e2e-delivery-"));
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
for (const [name, body] of [
  ["stall-instructions.md", "STALL-INSTRUCTIONS"],
  ["stall-actions.md", "ACTIONS platform={{platform}} key=<key>"],
]) writeFileSync(join(promptsDir, name), `${body}\n`);

const clock = { now: Date.parse("2026-11-13T10:00:00.000Z") };
const repliesPath = join(dir, "replies.jsonl");
const failuresPath = join(dir, "failures.jsonl");
let mode = "transient";

const adapter = {
  name: "e2e",
  allowedUser: "u-1",
  chunkLimit: 4000,
  timeoutMs: 60_000,
  maxWorkers: 1,
  queueDepth: 1,
  worker: "pi",
  piBin: "bash",
  replyRules: "RULES",
  sessionFor: () => SESSION,
  reply: async (inbound, text) => {
    if (mode === "permanent") throw Object.assign(new Error("invalid_thread_ts"), { retryable: false, code: "invalid_thread_ts" });
    if (mode === "located") return null;
    if (mode === "outage") throw Object.assign(new Error("socket closed"), { code: "ECONNRESET" });
    if (mode === "transient" && !existsSync(failuresPath)) {
      appendFileSync(failuresPath, `${JSON.stringify({ at: isoAt(Date.now()) })}\n`);
      return null;
    }
    appendFileSync(repliesPath, `${JSON.stringify({ key: inbound.key, text })}\n`);
    return { messageId: `reply-${Date.now()}` };
  },
  locateReply: async () => (mode === "located" ? "m-located" : null),
  postNotice: async (text) => {
    appendFileSync(repliesPath, `${JSON.stringify({ key: "notice", text })}\n`);
    return { messageId: `notice-${Date.now()}` };
  },
  buildWorker: () => ({ bin: "bash", args: ["-c", "echo 答案正文"] }),
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

const core = createCore({
  adapter,
  config,
  deps: {
    deliveryRetryMs: 0,
    now: () => clock.now,
    log: (level, ...parts) => {
      if (level === "error") process.stderr.write(`[${level}] ${parts.join(" ")}\n`);
    },
    spawn: (bin, args, options) => spawn(bin, args, options),
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
const tick = (ms = 200) => new Promise((resolve) => setTimeout(resolve, ms));
const jobFor = (key) =>
  Object.values(readState().jobs ?? {})
    .filter((item) => item.key === key)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0] ?? null;

await core.handle({ key: KEY, session: SESSION, dedupeId: "m1", authorId: "u-1", text: "e2e delivery", chatId: "c1" });
await tick(600);

const transient = jobFor(KEY);
const transientReplies = readReplies().filter((item) => item.key === KEY);
const retriedEvents = readEvents().filter((event) => event.event === "delivery-retried");

check("E-1 a dropped reply is retried and lands exactly once", transientReplies.length === 1 && transient?.status === "done", `replies=${transientReplies.length} status=${transient?.status}`);
check("E-2 the retry is recorded as an event, not silently swallowed", retriedEvents.length === 1, JSON.stringify(retriedEvents));
check("E-3 the delivered part carries the platform message id", Boolean(transient?.parts?.[0]?.messageId), JSON.stringify(transient?.parts));

mode = "permanent";
clock.now += 1_000;
await core.handle({ key: KEY, session: SESSION, dedupeId: "m2", authorId: "u-1", text: "e2e delivery permanent", chatId: "c1" });
await tick(600);

const failedJob = jobFor(KEY);
check(
  "E-4 a permanent failure ends failed, keeps the answer and says why",
  failedJob?.status === "failed" && failedJob?.error === "reply-failed" && failedJob?.answer === "答案正文" && String(failedJob?.deliveryError).includes("invalid_thread_ts"),
  JSON.stringify({ status: failedJob?.status, error: failedJob?.error, deliveryError: failedJob?.deliveryError }),
);

mode = "ok";
writeFileSync(join(commandDir, `1-redeliver.json`), `${JSON.stringify({ op: "redeliver", job: failedJob?.id ?? null, key: KEY, at: isoAt(Date.now()) })}\n`);
await core.drainCommands();
await tick(400);

const resent = jobFor(KEY);
const resentReplies = readReplies().filter((item) => item.key === KEY);
check(
  "E-5 redeliver resends the kept answer and closes the job",
  resent?.status === "done" && resent?.answer === undefined && resentReplies.length === 2,
  JSON.stringify({ status: resent?.status, answer: resent?.answer, replies: resentReplies.length }),
);

mode = "located";
clock.now += 1_000;
await core.handle({ key: KEY, session: SESSION, dedupeId: "m3", authorId: "u-1", text: "e2e delivery located", chatId: "c1" });
await tick(600);

const located = jobFor(KEY);
const locatedReplies = readReplies().filter((item) => item.key === KEY);
const locatedEvents = readEvents().filter((event) => event.event === "delivery-located");
check(
  "E-6 a reply that landed under an error is adopted instead of duplicated",
  located?.status === "done" && located?.parts?.[0]?.messageId === "m-located" && locatedReplies.length === 2 && locatedEvents.length === 1,
  JSON.stringify({ status: located?.status, replies: locatedReplies.length, located: locatedEvents.length }),
);

mode = "outage";
clock.now += 1_000;
await core.handle({ key: KEY, session: SESSION, dedupeId: "m4", authorId: "u-1", text: "e2e delivery outage", chatId: "c1" });
await tick(600);

const queued = jobFor(KEY);
check(
  "E-7 a retryable outage leaves the job in the retry queue with a due time",
  queued?.status === "retrying" && Boolean(queued?.deliveryRetryAt) && queued?.answer === "答案正文",
  JSON.stringify({ status: queued?.status, at: queued?.deliveryRetryAt }),
);

mode = "ok";
clock.now += 30_000;
await core.startDueDeliveries();
await tick(400);

const recovered = jobFor(KEY);
const recoveredReplies = readReplies().filter((item) => item.key === KEY);
check(
  "E-8 the queued delivery lands once the platform is back, and the queue marker is cleared",
  recovered?.status === "done" && recovered?.deliveryRetryAt === undefined && recovered?.answer === undefined,
  JSON.stringify({ status: recovered?.status, retryAt: recovered?.deliveryRetryAt }),
);

mode = "outage";
clock.now += 1_000;
const toldBefore = readReplies().filter((item) => item.text.includes("没送出去")).length;
await core.handle({ key: KEY, session: SESSION, dedupeId: "m5", authorId: "u-1", text: "e2e delivery gives up", chatId: "c1" });
await tick(600);
clock.now += 5 * 60_000 + 1;
await core.startDueDeliveries();
await tick(200);

const gaveUp = jobFor(KEY);
const told = readReplies().filter((item) => item.text.includes("没送出去")).slice(toldBefore);
check(
  "E-9 past the five-minute window the job fails and the owner is told once, with the redeliver command",
  gaveUp?.status === "failed" && gaveUp?.error === "reply-failed" && told.length === 1 && told[0].text.includes("job redeliver"),
  JSON.stringify({ status: gaveUp?.status, error: gaveUp?.error, told: told.length }),
);

if (failures.length) {
  process.stderr.write(`\n${failures.length} failed:\n${failures.map((item) => `  ${item}`).join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`\nall e2e delivery checks passed in ${dir}\n`);
