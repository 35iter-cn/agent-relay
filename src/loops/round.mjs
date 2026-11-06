export const ROUND_INDEX_TTL_MS = 30 * 86_400_000;
export const MAX_OUTPUT_BYTES = 32 * 1024;

export function roundKeyFor(loopId, round) {
  return `${loopId}-r${round}`;
}

export function roundTitle(loop, round) {
  return `${loop.id} 第 ${round} 轮`;
}

export function truncateOutput(text, limit = MAX_OUTPUT_BYTES) {
  const value = String(text ?? "");
  if (Buffer.byteLength(value) <= limit) return value;
  let length = value.length;
  while (length > 0 && Buffer.byteLength(value.slice(0, length)) > limit) {
    length = Math.floor(length * 0.9);
  }
  return value.slice(0, length);
}

export function matchRound(loopRuns, replyIds = []) {
  const ids = (replyIds ?? []).filter(Boolean).map(String);
  if (!ids.length) return null;
  for (const id of ids) {
    const hit = loopRuns?.[id];
    if (hit) return hit;
  }
  return null;
}

export function pruneRounds(loopRuns, nowMs, ttlMs = ROUND_INDEX_TTL_MS) {
  let dropped = 0;
  for (const [messageId, record] of Object.entries(loopRuns ?? {})) {
    const at = Date.parse(record?.at ?? "");
    if (!Number.isFinite(at) || nowMs - at > ttlMs) {
      delete loopRuns[messageId];
      dropped += 1;
    }
  }
  return dropped;
}
