import { TIME_ZONE } from "../shared/time.mjs";

export const CRON_HORIZON_MS = 4 * 365 * 86_400_000;
export const CRON_FIELD_RANGES = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const WEEKDAY_NAMES = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  hour12: false,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
  weekday: "short",
});

function parseField(field, min, max) {
  if (!field) return null;
  const out = new Set();
  for (const item of field.split(",")) {
    const [range, stepRaw] = item.split("/");
    if (stepRaw !== undefined && !/^\d+$/.test(stepRaw)) return null;
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) return null;
    let from;
    let to;
    if (range === "*") {
      from = min;
      to = max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-");
      if (!/^\d+$/.test(a) || !/^\d+$/.test(b)) return null;
      from = Number(a);
      to = Number(b);
    } else {
      if (!/^\d+$/.test(range)) return null;
      from = Number(range);
      to = stepRaw === undefined ? from : max;
    }
    if (!Number.isInteger(from) || !Number.isInteger(to)) return null;
    if (from < min || from > max || to < min || to > max || from > to) return null;
    for (let value = from; value <= to; value += step) out.add(value);
  }
  return out.size ? out : null;
}

export function parseCron(expr) {
  const fields = String(expr ?? "").trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const sets = [];
  for (let i = 0; i < 5; i += 1) {
    const set = parseField(fields[i], CRON_FIELD_RANGES[i][0], CRON_FIELD_RANGES[i][1]);
    if (!set) return null;
    sets.push(set);
  }
  const [minutes, hours, days, months, weekdaysRaw] = sets;
  return {
    minutes,
    hours,
    days,
    months,
    weekdays: new Set([...weekdaysRaw].map((value) => (value === 7 ? 0 : value))),
    daysRestricted: fields[2] !== "*",
    weekdaysRestricted: fields[4] !== "*",
  };
}

export function localParts(ms) {
  const parts = {};
  for (const part of PARTS.formatToParts(new Date(ms))) parts[part.type] = part.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAY_NAMES[parts.weekday],
  };
}

function dayFieldMatches(parsed, parts) {
  const dayHit = parsed.days.has(parts.day);
  const weekdayHit = parsed.weekdays.has(parts.weekday);
  return parsed.daysRestricted && parsed.weekdaysRestricted ? dayHit || weekdayHit : dayHit && weekdayHit;
}

export function matchesCron(parsed, parts) {
  if (!parsed) return false;
  if (!parsed.months.has(parts.month)) return false;
  if (!dayFieldMatches(parsed, parts)) return false;
  if (!parsed.hours.has(parts.hour)) return false;
  return parsed.minutes.has(parts.minute);
}

function elapsedInHour(parts) {
  return parts.minute * MINUTE_MS + parts.second * 1000;
}

function elapsedInDay(parts) {
  return parts.hour * HOUR_MS + elapsedInHour(parts);
}

function jumpToNextHour(parts, ms) {
  return ms - elapsedInHour(parts) + HOUR_MS;
}

function jumpToNextDay(parts, ms) {
  return ms - elapsedInDay(parts) + DAY_MS;
}

function jumpToNextMonth(parts, ms) {
  const daysInMonth = new Date(Date.UTC(parts.year, parts.month, 0)).getUTCDate();
  return ms - elapsedInDay(parts) + (daysInMonth - parts.day + 1) * DAY_MS;
}

export function cronNext(parsed, fromMs) {
  if (!parsed || !Number.isFinite(fromMs)) return Number.POSITIVE_INFINITY;
  let at = Math.floor(fromMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const horizon = at + CRON_HORIZON_MS;
  while (at <= horizon) {
    const parts = localParts(at);
    if (!parsed.months.has(parts.month)) {
      at = jumpToNextMonth(parts, at);
      continue;
    }
    if (!dayFieldMatches(parsed, parts)) {
      at = jumpToNextDay(parts, at);
      continue;
    }
    if (!parsed.hours.has(parts.hour)) {
      at = jumpToNextHour(parts, at);
      continue;
    }
    if (!parsed.minutes.has(parts.minute)) {
      at += MINUTE_MS;
      continue;
    }
    return at;
  }
  return Number.POSITIVE_INFINITY;
}
