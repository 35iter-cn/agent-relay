import { readdirSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export const MAX_ATTACHMENTS = 4;
export const MAX_BYTES = 20 * 1024 * 1024;
export const UPLOAD_TTL_MS = 7 * 86_400_000;

const EXT_BY_TYPE = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp" };
const CLOCK = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function uploadDirFor(configDir, chatId, date = new Date(), format = CLOCK) {
  const day = format.format(date).slice(0, 10).replaceAll("-", "");
  return join(configDir, "uploads", chatId, day);
}

export function pruneUploads(root, ttl = UPLOAD_TTL_MS, now = Date.now()) {
  const cutoff = now - ttl;
  const walk = (dir) => {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      try {
        if (statSync(full).mtimeMs < cutoff) unlinkSync(full);
      } catch {}
    }
    try {
      if (!readdirSync(dir).length) rmdirSync(dir);
    } catch {}
  };
  walk(root);
}

export function extFor(mime, name = null) {
  const mapped = EXT_BY_TYPE[String(mime ?? "").split(";")[0].trim()];
  if (mapped) return mapped;
  const suffix = String(name ?? "").includes(".") ? String(name).split(".").pop().toLowerCase() : "";
  return /^[a-z0-9]{1,8}$/.test(suffix) ? suffix : "bin";
}
