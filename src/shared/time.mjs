export const TIME_ZONE = "Asia/Shanghai";

const DAY = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });

export function localDay(ms) {
  return DAY.format(new Date(ms));
}

export function localStamp(ms) {
  return new Date(ms).toLocaleString("sv-SE", { timeZone: TIME_ZONE });
}

export function isoAt(ms) {
  return new Date(ms).toISOString();
}
