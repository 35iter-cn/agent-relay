import { parseDurationMs } from "../shared/duration.mjs";
import { cronNext, parseCron } from "./cron.mjs";

export const LOOP_STATES = new Set(["armed", "paused", "done", "deleted"]);
export const MIN_EVERY_MS = 10 * 60_000;
export const MAX_LOOPS = 20;
export const MAX_PROMPT_BYTES = 4 * 1024;
export const MAX_TITLE_BYTES = 80;

const ID_PATTERN = /^loop-([a-z]+)-(\d+)$/;

export function platformOfLoopId(id) {
  const match = ID_PATTERN.exec(String(id ?? ""));
  return match ? match[1] : null;
}

export function isLoopId(id) {
  return ID_PATTERN.test(String(id ?? ""));
}

export function nextLoopId(loops, platform) {
  const prefix = `loop-${platform}-`;
  let max = 0;
  for (const id of Object.keys(loops ?? {})) {
    if (!id.startsWith(prefix)) continue;
    const seq = Number(id.slice(prefix.length));
    if (Number.isFinite(seq) && seq > max) max = seq;
  }
  return `${prefix}${max + 1}`;
}

export function activeLoopCount(loops) {
  return Object.values(loops ?? {}).filter((loop) => loop && loop.state !== "deleted").length;
}

export function validateSchedule({ every, at, cron } = {}) {
  const given = [every, at, cron].filter((value) => value !== undefined && value !== null && value !== "");
  if (given.length !== 1) return "schedule-required";
  if (cron) {
    const parsed = parseCron(cron);
    if (!parsed) return "bad-cron";
    return Number.isFinite(cronNext(parsed, Date.now())) ? null : "never-fires";
  }
  if (at) return Number.isFinite(Date.parse(at)) ? null : "bad-at";
  const ms = parseDurationMs(every);
  if (ms === null) return "bad-every";
  return ms < MIN_EVERY_MS ? "every-too-small" : null;
}

export function validatePrompt(prompt) {
  const body = String(prompt ?? "").trim();
  if (!body) return "empty-prompt";
  return Buffer.byteLength(body) > MAX_PROMPT_BYTES ? "prompt-too-long" : null;
}

export function validateLoopChange(change = {}) {
  const refused = validateSchedule(change.schedule ?? {}) ?? validatePrompt(change.prompt);
  return refused ?? null;
}

export function createLoop({ id, prompt, every = null, at = null, cron = null, thread = true, createdBy = null, nowIso }) {
  return {
    id,
    prompt: String(prompt).trim(),
    every: every ?? null,
    at: at ?? null,
    cron: cron ?? null,
    thread: thread !== false,
    state: "armed",
    createdAt: nowIso,
    createdBy,
    lastRunAt: null,
    lastRunId: null,
    lastRound: 0,
    lastMessageId: null,
    lastOutcome: null,
    failStreak: 0,
  };
}

export function loopIntervalMs(loop) {
  return parseDurationMs(loop?.every);
}
