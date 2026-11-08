import { parseDurationMs } from "../shared/duration.mjs";
import { PLATFORMS } from "../platforms/contract.mjs";
import { cronNext, parseCron } from "./cron.mjs";
import { validatePromptFile } from "./prompt.mjs";

export const LOOP_STATES = new Set(["armed", "paused", "done", "deleted"]);
export const MIN_EVERY_MS = 10 * 60_000;
export const MAX_LOOPS = 20;
export const MAX_PROMPT_BYTES = 4 * 1024;
export const MAX_TITLE_BYTES = 80;

const ID_PATTERN = /^loop-([a-z]+)-(\d+)$/;
const SLUG_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const SLUG_ID_PATTERN = new RegExp(`^([a-z][a-z0-9-]{0,31})-(${[...PLATFORMS].sort((a, b) => b.length - a.length).join("|")})$`);

export function platformOfLoopId(id) {
  const value = String(id ?? "");
  const legacy = ID_PATTERN.exec(value);
  if (legacy) return legacy[1];
  const slug = SLUG_ID_PATTERN.exec(value);
  return slug ? slug[2] : null;
}

export function isLoopId(id) {
  const value = String(id ?? "");
  return ID_PATTERN.test(value) || SLUG_ID_PATTERN.test(value);
}

export function validateSlug(slug) {
  const value = String(slug ?? "").trim();
  if (!SLUG_PATTERN.test(value) || value.endsWith("-") || value === "loop") return "bad-slug";
  return null;
}

export function loopIdForSlug(slug, platform) {
  const value = String(slug ?? "").trim();
  if (!value || validateSlug(value)) return "";
  return `${value}-${platform}`;
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

export function validateLoopPrompt({ prompt, promptFile } = {}) {
  const file = String(promptFile ?? "").trim();
  if (file) return validatePromptFile(file);
  return validatePrompt(prompt);
}

export function validateLoopChange(change = {}) {
  const refused = validateSchedule(change.schedule ?? {}) ?? validateLoopPrompt(change);
  return refused ?? null;
}

export function createLoop({ id, prompt, promptFile = null, every = null, at = null, cron = null, thread = true, createdBy = null, nowIso }) {
  const file = String(promptFile ?? "").trim();
  return {
    id,
    prompt: file ? "" : String(prompt ?? "").trim(),
    promptFile: file || null,
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
