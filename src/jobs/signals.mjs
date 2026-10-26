#!/usr/bin/env bun
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

export const TAIL_BYTES = 256 * 1024;
export const TAIL_MAX_BYTES = 2 * 1024 * 1024;
export const TOOL_GRACE_MS = 60_000;

const HEAD_CHARS = 120;
const FAILED = (reason) => ({ ok: false, reason });

export function assertHead(toolCall) {
  const args = toolCall?.arguments ?? {};
  const raw = typeof args.command === "string" ? args.command.split("\n").find((line) => line.trim()) ?? "" : typeof args.path === "string" ? args.path : JSON.stringify(args);
  const head = String(raw).trim();
  return head.length > HEAD_CHARS ? `${head.slice(0, HEAD_CHARS)}…` : head;
}

export function declaredTimeoutMs(open) {
  const declared = (open?.tools ?? []).map((tool) => tool.declaredMs).filter((ms) => Number.isFinite(ms) && ms > 0);
  return declared.length ? Math.max(...declared) : null;
}

function timeoutsOf(toolCall) {
  if (toolCall?.name !== "bash") return null;
  const seconds = Number(toolCall?.arguments?.timeout);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

function parseEntry(line) {
  try {
    const value = JSON.parse(line);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function readChunk(fd, start, length) {
  const buffer = Buffer.allocUnsafe(length);
  const read = readSync(fd, buffer, 0, length, start);
  return buffer.subarray(0, read);
}

function scanChunk(text, start) {
  const lines = text.split("\n");
  if (start > 0) lines.shift();
  const closed = new Set();
  let lastEntryAt = null;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const entry = parseEntry(lines[index]);
    if (!entry) continue;
    if (lastEntryAt === null && entry.type === "message") {
      const at = Date.parse(entry.timestamp ?? "");
      if (Number.isFinite(at)) lastEntryAt = at;
    }
    const message = entry.type === "message" ? entry.message : null;
    if (!message) continue;
    if (message.role === "toolResult") {
      if (message.toolCallId) closed.add(message.toolCallId);
      continue;
    }
    if (message.role !== "assistant") continue;
    const calls = Array.isArray(message.content) ? message.content.filter((block) => block && block.type === "toolCall") : [];
    const open = calls.filter((call) => !closed.has(call.id));
    const at = Date.parse(entry.timestamp ?? "");
    if (!open.length) return { found: true, lastEntryAt, open: null };
    return {
      found: true,
      lastEntryAt,
      open: {
        name: open[0].name ?? null,
        startedAt: Number.isFinite(at) ? at : null,
        callIds: open.map((call) => call.id).filter(Boolean),
        head: assertHead(open[0]),
        tools: open.map((call) => ({ id: call.id ?? null, name: call.name ?? null, declaredMs: timeoutsOf(call), head: assertHead(call) })),
      },
    };
  }
  return { found: false, lastEntryAt };
}

export function readSessionSignal(file, { tailBytes = TAIL_BYTES, maxBytes = TAIL_MAX_BYTES } = {}) {
  if (!file) return FAILED("no-file");
  let fd;
  try {
    fd = openSync(file, "r");
  } catch {
    return FAILED("unreadable");
  }
  try {
    const size = fstatSync(fd).size;
    if (!size) return FAILED("empty");
    const cap = Math.max(tailBytes, 1);
    for (let window = cap; window <= Math.max(cap, maxBytes); window *= 2) {
      const start = Math.max(0, size - window);
      const result = scanChunk(readChunk(fd, start, size - start).toString("utf8"), start);
      if (result.found) return { ok: true, lastEntryAt: result.lastEntryAt, open: result.open };
      if (start === 0) break;
    }
    return FAILED("no-assistant");
  } catch (error) {
    return FAILED(String(error?.message ?? error));
  } finally {
    closeSync(fd);
  }
}
