#!/usr/bin/env bun
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { assertHead, declaredTimeoutMs, readSessionSignal, TAIL_BYTES, TAIL_MAX_BYTES, TOOL_GRACE_MS } from "../src/jobs/signals.mjs";

const iso = (ms) => new Date(ms).toISOString();
const T0 = Date.parse("2026-10-26T13:00:00.000Z");

function assistant(at, calls, extra = {}) {
  return {
    type: "message",
    id: `a-${at}`,
    parentId: null,
    timestamp: iso(at),
    message: {
      role: "assistant",
      content: calls.map((call) => ({ type: "toolCall", id: call.id, name: call.name ?? "bash", arguments: call.arguments ?? { command: "ls" } })),
      provider: "fake",
      model: "fake",
      usage: { input: 1, output: 1 },
      stopReason: "toolUse",
      timestamp: at,
      ...extra,
    },
  };
}

function toolResult(at, callId, text = "done") {
  return {
    type: "message",
    id: `t-${callId}-${at}`,
    parentId: null,
    timestamp: iso(at),
    message: { role: "toolResult", toolCallId: callId, toolName: "bash", content: [{ type: "text", text }], isError: false, timestamp: at },
  };
}

function userEntry(at, text = "hi") {
  return { type: "message", id: `u-${at}`, parentId: null, timestamp: iso(at), message: { role: "user", content: text, timestamp: at } };
}

function withFile(entries, fn, { raw = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "relay-session-"));
  const file = join(dir, "2026-10-26T13-00-00-000Z_fs-th-abc.jsonl");
  writeFileSync(file, raw ?? `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  try {
    return fn(file, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("TC-S1 closed tool call reports no open tool", () => {
  withFile([userEntry(T0), assistant(T0 + 1000, [{ id: "c1" }]), toolResult(T0 + 2000, "c1")], (file) => {
    const signal = readSessionSignal(file);
    assert.equal(signal.ok, true);
    assert.equal(signal.open, null);
    assert.equal(signal.lastEntryAt, T0 + 2000);
  });
});

test("TC-S2 unclosed tool call exposes its start time and head", () => {
  withFile([userEntry(T0), assistant(T0 + 1000, [{ id: "c1", arguments: { command: "dotnet build\n--no-restore" } }])], (file) => {
    const signal = readSessionSignal(file);
    assert.equal(signal.ok, true);
    assert.equal(signal.open.startedAt, T0 + 1000);
    assert.equal(signal.open.name, "bash");
    assert.deepEqual(signal.open.callIds, ["c1"]);
    assert.equal(signal.open.head, "dotnet build");
  });
});

test("TC-S3 trailing partial line is ignored", () => {
  withFile([assistant(T0 + 1000, [{ id: "c1" }])], (file) => {
    const signal = readSessionSignal(file);
    assert.equal(signal.ok, true);
    assert.equal(signal.open.callIds[0], "c1");
  }, { raw: `${JSON.stringify(assistant(T0 + 1000, [{ id: "c1" }]))}\n{"type":"message","id":"x","timestamp":"2026-10-26T13:0` });
});

test("TC-S4 unparseable lines are skipped", () => {
  withFile([], (file) => {
    const signal = readSessionSignal(file);
    assert.equal(signal.ok, true);
    assert.equal(signal.open.startedAt, T0 + 1000);
    assert.equal(signal.lastEntryAt, T0 + 5000);
  }, {
    raw: [
      JSON.stringify(assistant(T0 + 1000, [{ id: "c1" }])),
      "not json at all",
      JSON.stringify({ type: "message", timestamp: "garbage", message: { role: "toolResult", toolCallId: "c9" } }),
      JSON.stringify(toolResult(T0 + 5000, "c2")),
      "",
    ].join("\n"),
  });
});

test("TC-S5 parallel calls keep the earliest unclosed and ignore closed ones", () => {
  const at = T0 + 1000;
  withFile([assistant(at, [{ id: "c1" }, { id: "c2" }, { id: "c3" }]), toolResult(at + 500, "c2")], (file) => {
    const signal = readSessionSignal(file);
    assert.equal(signal.open.startedAt, at);
    assert.deepEqual(signal.open.callIds, ["c1", "c3"]);
    assert.equal(signal.open.tools.length, 2);
  });
});

test("TC-S6 window expansion reaches past a 1.5MB tool result line", () => {
  const big = "x".repeat(1_500_000);
  withFile([assistant(T0 + 1000, [{ id: "c1" }]), toolResult(T0 + 2000, "c2", big)], (file) => {
    const signal = readSessionSignal(file, { tailBytes: 1024, maxBytes: 4 * 1024 * 1024 });
    assert.equal(signal.ok, true);
    assert.equal(signal.open.callIds[0], "c1");
  });
});

test("TC-S7 empty and missing files degrade to ok:false", () => {
  withFile([], (file, dir) => {
    assert.deepEqual(readSessionSignal(file), { ok: false, reason: "empty" });
    assert.deepEqual(readSessionSignal(join(dir, "nope.jsonl")), { ok: false, reason: "unreadable" });
    assert.deepEqual(readSessionSignal(null), { ok: false, reason: "no-file" });
  }, { raw: "" });
});

test("TC-S8 a 20MB session is judged from the tail only", () => {
  const filler = [];
  let at = T0;
  for (let index = 0; index < 200; index += 1) {
    filler.push(userEntry(at, `turn ${index} ${"y".repeat(100_000)}`));
    at += 1000;
  }
  filler.push(assistant(at, [{ id: "c-open" }]));
  withFile(filler, (file) => {
    const size = statSync(file).size;
    assert.ok(size > 20_000_000);
    const started = Date.now();
    const signal = readSessionSignal(file);
    const elapsed = Date.now() - started;
    assert.equal(signal.open.callIds[0], "c-open");
    assert.ok(elapsed < 500, `tail read took ${elapsed}ms`);
  });
});

test("TC-S9 extension entries do not advance the entry clock", () => {
  withFile([
    assistant(T0 + 1000, [{ id: "c1" }]),
    toolResult(T0 + 2000, "c1"),
    { type: "custom", id: "x1", parentId: null, timestamp: iso(T0 + 300_000), customType: "web-search-results", data: {} },
    { type: "custom_message", id: "x2", parentId: null, timestamp: iso(T0 + 400_000), customType: "minimal-bg", content: "bg", display: false },
  ], (file) => {
    const signal = readSessionSignal(file);
    assert.equal(signal.lastEntryAt, T0 + 2000);
  });
});

test("TC-S10 helper values", () => {
  assert.equal(assertHead({ arguments: { command: "  " } }), "");
  assert.equal(assertHead({ arguments: { command: "a".repeat(200) } }).length, 121);
  assert.equal(assertHead({ arguments: { path: "/tmp/x" } }), "/tmp/x");
  assert.equal(declaredTimeoutMs({ tools: [{ declaredMs: 600_000 }, { declaredMs: 900_000 }] }), 900_000);
  assert.equal(declaredTimeoutMs({ tools: [{ declaredMs: null }] }), null);
  assert.equal(declaredTimeoutMs(null), null);
  assert.equal(TAIL_BYTES, 256 * 1024);
  assert.equal(TAIL_MAX_BYTES, 2 * 1024 * 1024);
  assert.equal(TOOL_GRACE_MS, 60_000);
});

test("TC-S11 real pi entries stay parseable", () => {
  const file = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "pi-bash-turn.jsonl");
  const signal = readSessionSignal(file);
  assert.equal(signal.ok, true);
  assert.equal(signal.open, null);
  assert.equal(signal.lastEntryAt, 1793023042408);
});
