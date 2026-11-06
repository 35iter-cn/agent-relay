import { appendFileSync, existsSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateDir } from "../shared/fs.mjs";

export const MAX_ROUNDS_KEPT = 50;
export const HISTORY_RETENTION_MS = 90 * 86_400_000;

export function loopHistoryFile(dir, loopId) {
  return join(dir, `${loopId}.jsonl`);
}

export function appendRound(dir, loopId, entry) {
  ensurePrivateDir(dir);
  appendFileSync(loopHistoryFile(dir, loopId), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

export function readRoundLines(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function listRounds(dir, loopId, { limit = 20 } = {}) {
  return readRoundLines(loopHistoryFile(dir, loopId)).slice(-limit).reverse();
}

export function findRound(dir, runId) {
  const id = String(runId ?? "");
  if (!id) return null;
  const loopId = id.replace(/-r\d+$/, "");
  return readRoundLines(loopHistoryFile(dir, loopId)).find((entry) => entry.runId === id) ?? null;
}

export function pruneHistory(dir, nowMs = Date.now(), { retentionMs = HISTORY_RETENTION_MS, maxRounds = MAX_ROUNDS_KEPT } = {}) {
  if (!existsSync(dir)) return 0;
  let touched = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const file = join(dir, name);
    const kept = readRoundLines(file)
      .filter((entry) => {
        const at = Date.parse(entry?.at ?? "");
        return Number.isFinite(at) && nowMs - at <= retentionMs;
      })
      .slice(-maxRounds);
    if (!kept.length) {
      try {
        unlinkSync(file);
        touched += 1;
      } catch {}
      continue;
    }
    const body = `${kept.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
    try {
      if (Buffer.byteLength(body) === statSync(file).size && readFileSync(file, "utf8") === body) continue;
      const tmp = `${file}.tmp-${process.pid}`;
      writeFileSync(tmp, body, { mode: 0o600 });
      renameSync(tmp, file);
      touched += 1;
    } catch {}
  }
  return touched;
}
