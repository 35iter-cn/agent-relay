import { readFileSync } from "node:fs";

export const BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";

export function readBootId(path = BOOT_ID_PATH) {
  try {
    return readFileSync(path, "utf8").trim() || null;
  } catch {
    return null;
  }
}

export function shouldAnnounceBoot(previousId, currentId) {
  if (!currentId) return false;
  return previousId !== currentId;
}

export function bootNoticeText(date, format, { restartLine = "" } = {}) {
  const head = `relay is up; the agent is ready for work\nonline since: ${format(date)}`;
  return restartLine ? `${head}\n${restartLine}` : head;
}
