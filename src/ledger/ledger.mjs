import fs from "node:fs";
import { join } from "node:path";

export const USER_TEXT_LIMIT = 600;
export const OUTPUT_LIMIT = 400;
export const MAX_LINE_BYTES = 3800;

export function truncate(value, limit) {
  const text = typeof value === "string" ? value : "";
  return text.length > limit ? text.slice(0, limit) : text;
}

export function normalizeSessionId(value) {
  const safe = String(value ?? "").replace(/[^A-Za-z0-9_.-]/g, "_");
  return safe || "unknown";
}

export function ledgerFilePath(dir, sessionId) {
  return join(dir, `${normalizeSessionId(sessionId)}.jsonl`);
}

export function serializeRecord(record) {
  let candidate = { ...record };
  let line = `${JSON.stringify(candidate)}\n`;
  if (Buffer.byteLength(line) <= MAX_LINE_BYTES) return line;
  candidate.output = "";
  line = `${JSON.stringify(candidate)}\n`;
  if (Buffer.byteLength(line) <= MAX_LINE_BYTES) return line;
  candidate.userText = truncate(candidate.userText, 200);
  line = `${JSON.stringify(candidate)}\n`;
  if (Buffer.byteLength(line) <= MAX_LINE_BYTES) return line;
  candidate.userText = "";
  return `${JSON.stringify(candidate)}\n`;
}

export function appendLedger(record, { dir, fsImpl = fs } = {}) {
  const file = ledgerFilePath(dir, record.sessionId);
  fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fsImpl.writeFileSync(file, serializeRecord(record), { encoding: "utf8", mode: 0o600, flag: "a" });
  return file;
}
