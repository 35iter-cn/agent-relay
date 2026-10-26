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

export function bootNoticeText(date, format) {
  return `🟢 系统已启动，Agent 已准备好接收任务\n上线时间：${format(date)}`;
}
