const UNITS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseDurationMs(value) {
  if (value === undefined || value === null || value === "") return null;
  const match = /^(\d+(?:\.\d+)?)([smhd])$/.exec(String(value).trim());
  if (!match) return null;
  return Math.round(Number(match[1]) * UNITS[match[2]]);
}

export function durationMs(value, fallback) {
  const ms = parseDurationMs(value);
  return ms === null ? fallback : ms;
}
