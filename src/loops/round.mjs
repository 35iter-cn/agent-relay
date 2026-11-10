export const MAX_OUTPUT_BYTES = 32 * 1024;

export function roundKeyFor(loopId, round) {
  return `${loopId}-r${round}`;
}

export function roundTitle(loop, round) {
  const name = String(loop?.title ?? "").trim() || loop.id;
  return `${name} · 第 ${round} 轮`;
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
