import { EventEmitter } from "node:events";
import { test, expect } from "bun:test";
import { createRpcWorker } from "../src/runtime/worker-rpc.mjs";

function fakeRpc({ pid = 4242 } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.written = [];
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    writable: true,
    write: (chunk) => child.written.push(chunk),
    end: () => {
      child.stdin.writable = false;
    },
    on: () => {},
  };
  child.kill = () => {};
  child.emitRecord = (record) => child.stdout.emit("data", `${JSON.stringify(record)}\n`);
  child.emitRaw = (text) => child.stdout.emit("data", text);
  child.command = (index = 0) => JSON.parse(String(child.written[index]).trim());
  return child;
}

function harness(options = {}) {
  const child = fakeRpc(options);
  const worker = createRpcWorker({
    bin: "pi",
    session: "slack-key-1",
    cwd: "/tmp",
    env: {},
    deps: { spawn: () => child },
  });
  return { child, worker };
}

test("TC-RPC1 the handshake sends a get_state command and resolves with its data", async () => {
  const { child, worker } = harness();
  const waiting = worker.state();
  await Bun.sleep(1);
  expect(child.command().type).toBe("get_state");
  expect(child.command().id).toBeString();
  child.emitRecord({ id: child.command().id, type: "response", command: "get_state", success: true, data: { sessionId: "slack-key-1", messageCount: 3 } });
  expect(await waiting).toEqual({ sessionId: "slack-key-1", messageCount: 3 });
});

test("TC-RPC2 records split on LF only, across chunk boundaries and with CRLF", async () => {
  const { child, worker } = harness();
  const events = [];
  worker.onEvent((record) => events.push(record));
  const waiting = worker.state();
  await Bun.sleep(1);
  const id = child.command().id;
  child.emitRaw(`{"id":"${id}","type":"response","command":"get_state","success":true,`);
  child.emitRaw(`"data":{"sessionId":"s"}}\r\n{"type":"turn_start"}\n{"type":"turn_`);
  child.emitRaw(`end"}\n`);
  expect(await waiting).toEqual({ sessionId: "s" });
  expect(events.map((event) => event.type)).toEqual(["turn_start", "turn_end"]);
});

test("TC-RPC3 dialog requests are answered with cancelled, notifications are left alone", async () => {
  const { child, worker } = harness();
  child.emitRecord({ type: "extension_ui_request", id: "ui-1", method: "confirm", title: "t" });
  child.emitRecord({ type: "extension_ui_request", id: "ui-2", method: "notify", message: "hi" });
  child.emitRecord({ type: "extension_ui_request", id: "ui-3", method: "editor", title: "t" });
  const answered = child.written.map((chunk) => JSON.parse(String(chunk).trim()));
  expect(answered).toEqual([
    { type: "extension_ui_response", id: "ui-1", cancelled: true },
    { type: "extension_ui_response", id: "ui-3", cancelled: true },
  ]);
  expect(worker.pid).toBe(4242);
});

test("TC-RPC4 prompt and steer carry the text, add images only when present, and report the disposition", async () => {
  const { child, worker } = harness();
  const prompting = worker.prompt({ text: "hello" });
  await Bun.sleep(1);
  const promptRecord = child.command(0);
  expect(promptRecord).toMatchObject({ type: "prompt", message: "hello" });
  expect("images" in promptRecord).toBe(false);
  child.emitRecord({ id: promptRecord.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } });
  expect(await prompting).toBe("started");

  const steering = worker.steer({ text: "wait", images: [{ type: "image", data: "AAA", mimeType: "image/png" }] });
  await Bun.sleep(1);
  const steerRecord = child.command(1);
  expect(steerRecord).toMatchObject({ type: "steer", message: "wait", images: [{ type: "image", data: "AAA", mimeType: "image/png" }] });
  child.emitRecord({ id: steerRecord.id, type: "response", command: "steer", success: true, data: { disposition: "queued" } });
  expect(await steering).toBe("queued");
});

test("TC-RPC5 an exit rejects pending commands and notifies the exit listener with the stderr tail", async () => {
  const { child, worker } = harness();
  const exits = [];
  worker.onExit((exit) => exits.push(exit));
  const waiting = worker.state();
  await Bun.sleep(1);
  child.stderr.emit("data", "boom\n");
  child.emit("exit", 1, null);
  await expect(waiting).rejects.toThrow("rpc-exit 1");
  expect(exits).toEqual([{ code: 1, signal: null }]);
  expect(worker.stderrTail()).toContain("boom");
  await expect(worker.state()).rejects.toThrow("rpc-exit 1");
});
