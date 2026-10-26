import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { localDay } from "./time.mjs";

export function createLog({ write = (line) => process.stderr.write(line), now = () => Date.now() } = {}) {
  return function log(level, ...parts) {
    const line = JSON.stringify({
      ts: new Date(now()).toISOString(),
      level,
      msg: parts.map((part) => (typeof part === "string" ? part : JSON.stringify(part))).join(" "),
    });
    try {
      write(`${line}\n`);
    } catch {}
  };
}

export const log = createLog();

export function appendDailyJsonl(dir, record, { now = () => Date.now() } = {}) {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(`${dir}/${localDay(now())}.jsonl`, `${JSON.stringify({ ts: new Date(now()).toISOString(), ...record })}\n`, { mode: 0o600 });
  } catch {}
}

export { dirname };
