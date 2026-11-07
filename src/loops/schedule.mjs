import { loopIntervalMs } from "./model.mjs";
import { cronNext, parseCron } from "./cron.mjs";

export const LOOP_ROUNDS_PER_HOUR = 20;
export const LOOP_TIMEOUT_MS = 15 * 60_000;

export function loopDueAt(loop) {
  const at = Date.parse(loop?.at ?? "");
  if (Number.isFinite(at)) return at;
  const anchor = Date.parse(loop?.lastRunAt ?? loop?.createdAt ?? "");
  if (!Number.isFinite(anchor)) return Number.POSITIVE_INFINITY;
  if (loop?.cron) {
    const parsed = parseCron(loop.cron);
    return parsed ? cronNext(parsed, anchor) : Number.POSITIVE_INFINITY;
  }
  const interval = loopIntervalMs(loop);
  if (interval === null) return Number.POSITIVE_INFINITY;
  return anchor + interval;
}

export function loopLateMs(loop, nowMs) {
  const due = loopDueAt(loop);
  return Number.isFinite(due) ? Math.max(0, nowMs - due) : 0;
}

export function roundsInLastHour(stamps, nowMs) {
  return (stamps ?? []).filter((iso) => {
    const at = Date.parse(iso);
    return Number.isFinite(at) && at <= nowMs && nowMs - at < 3_600_000;
  }).length;
}

export function roundSkipReason({ loop, nowMs, openJob, running = 0, maxWorkers = Number.POSITIVE_INFINITY, roundsLastHour = 0, hourLimit = LOOP_ROUNDS_PER_HOUR }) {
  if (!loop || loop.state !== "armed") return "state";
  if (loop.at && Date.parse(loop.at) > nowMs) return "not-due";
  if (nowMs < loopDueAt(loop)) return "not-due";
  if (openJob) return "busy";
  if (running >= maxWorkers) return "workers";
  if (roundsLastHour >= hourLimit) return "throttled";
  return null;
}
