// The relay talks wall-clock time in one zone: `relay.timeZone` when config.json
// names one, the machine's zone otherwise. Nothing else in the sources carries a
// zone constant.

const DEFAULT_TIME_ZONE = "Asia/Shanghai";

let zone = "";
const formatters = new Map();

const systemZone = () => new Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_TIME_ZONE;

export function configureTimeZone(value) {
  zone = String(value ?? "").trim();
  formatters.clear();
}

export function timeZone() {
  return zone || systemZone();
}

// One cached formatter per (locale, options); the zone is whatever is configured now.
export function zoneFormatter(locale, intl = {}) {
  const key = `${locale}|${JSON.stringify(intl)}`;
  const hit = formatters.get(key);
  if (hit) return hit;
  const made = new Intl.DateTimeFormat(locale, { ...intl, timeZone: timeZone() });
  formatters.set(key, made);
  return made;
}

const DAY_INTS = { year: "numeric", month: "2-digit", day: "2-digit" };
const STAMP_INTS = { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" };

export function localDay(ms) {
  return zoneFormatter("en-CA", DAY_INTS).format(new Date(ms));
}

export function localStamp(ms) {
  return zoneFormatter("sv-SE", STAMP_INTS).format(new Date(ms));
}

export function isoAt(ms) {
  return new Date(ms).toISOString();
}
