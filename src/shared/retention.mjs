import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export function pruneOldFiles(dir, retentionMs, nowMs = Date.now()) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const removed = [];
  for (const name of names) {
    const path = join(dir, name);
    try {
      if (nowMs - statSync(path).mtimeMs > retentionMs) {
        unlinkSync(path);
        removed.push(name);
      }
    } catch {}
  }
  return removed;
}

export function isRetained(nowMs, mtimeMs, retentionMs) {
  return nowMs - mtimeMs <= retentionMs;
}
