import { cronNext, parseCron } from "./cron.mjs";

export const LOOP_ROUNDS_PER_HOUR = 20;

function anchorOf(loop) {
  const run = Date.parse(loop?.lastRunAt ?? loop?.createdAt ?? "");
  if (!Number.isFinite(run)) return Number.NaN;
  const dropped = Date.parse(loop?.lastSkipAt ?? "");
  return Number.isFinite(dropped) && dropped > run ? dropped : run;
}

export function loopDueAt(loop) {
  const anchor = anchorOf(loop);
  if (!Number.isFinite(anchor)) return Number.POSITIVE_INFINITY;
  const parsed = parseCron(loop?.cron ?? "");
  return parsed ? cronNext(parsed, anchor) : Number.POSITIVE_INFINITY;
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
  if (nowMs < loopDueAt(loop)) return "not-due";
  if (openJob) return "busy";
  if (running >= maxWorkers) return "workers";
  if (roundsLastHour >= hourLimit) return "throttled";
  return null;
}
