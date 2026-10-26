import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ensurePrivateDir } from "../shared/fs.mjs";

export function lockFileFor(dir, platform) {
  return join(dir, `serve-${platform}.pid`);
}

export function isProcessAlive(pid, probe = (target) => process.kill(target, 0)) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    probe(pid);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function acquireInstanceLock({ dir, platform, pid = process.pid, alive = isProcessAlive, read = readFileSync, remove = unlinkSync, open = openSync, write = writeFileSync, close = closeSync } = {}) {
  ensurePrivateDir(dir);
  const file = lockFileFor(dir, platform);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = open(file, "wx", 0o600);
      write(fd, `${pid}\n`);
      close(fd);
      return { file, pid, release: () => { try { remove(file); } catch {} } };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const holder = Number(String(read(file, "utf8")).trim());
      if (holder === pid) return { file, pid, release: () => { try { remove(file); } catch {} } };
      if (alive(holder)) return null;
      try { remove(file); } catch {}
    }
  }
  return null;
}
