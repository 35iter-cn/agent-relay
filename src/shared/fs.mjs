import { chmodSync, mkdirSync } from "node:fs";

export function ensurePrivateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {}
  return dir;
}

export function chmodPrivate(file) {
  try {
    chmodSync(file, 0o600);
  } catch {}
  return file;
}
