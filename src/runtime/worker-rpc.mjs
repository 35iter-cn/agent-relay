import { spawn as spawnProcess } from "node:child_process";

export const HANDSHAKE_MS = 10_000;
export const STDERR_CAP = 8 * 1024;
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

export function createRpcWorker({ bin, session, cwd, env = {}, log = () => {}, deps = {}, handshakeMs = HANDSHAKE_MS }) {
  const spawn = deps.spawn ?? spawnProcess;
  const child = spawn(bin, ["--mode", "rpc", "--session-id", session], {
    cwd,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });
  const pending = new Map();
  const eventListeners = new Set();
  const exitListeners = new Set();
  let buffer = "";
  let stderr = "";
  let seq = 0;
  let exited = null;

  function write(record) {
    if (exited || !child.stdin?.writable) return false;
    child.stdin.write(`${JSON.stringify(record)}\n`);
    return true;
  }

  function emit(record) {
    for (const listener of eventListeners) {
      try {
        listener(record);
      } catch (error) {
        log("warn", "rpc-listener", String(error?.message ?? error));
      }
    }
  }

  function handleRecord(record) {
    if (record.type === "extension_ui_request") {
      if (DIALOG_METHODS.has(record.method)) write({ type: "extension_ui_response", id: record.id, cancelled: true });
      return;
    }
    if (record.type === "response") {
      const waiting = pending.get(record.id);
      if (!waiting) return;
      pending.delete(record.id);
      clearTimeout(waiting.timer);
      if (record.success === false) waiting.reject(new Error(String(record.error ?? "rpc-failed")));
      else waiting.resolve(record.data ?? null);
      return;
    }
    emit(record);
  }

  function handleLine(line) {
    const text = line.replace(/\r$/, "");
    if (!text) return;
    let record;
    try {
      record = JSON.parse(text);
    } catch (error) {
      log("warn", "rpc-frame", String(error?.message ?? error));
      return;
    }
    if (record && typeof record === "object") handleRecord(record);
  }

  child.stdout?.setEncoding?.("utf8");
  child.stdout?.on("data", (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      handleLine(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
    }
  });
  child.stderr?.setEncoding?.("utf8");
  child.stderr?.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-STDERR_CAP);
  });
  child.stdin?.on?.("error", (error) => log("warn", "rpc-stdin", String(error?.message ?? error)));
  child.on("error", (error) => log("warn", "rpc-spawn", String(error?.message ?? error)));
  child.on("exit", (code, signal) => {
    exited = { code, signal };
    for (const [, waiting] of pending) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error(`rpc-exit ${code ?? signal ?? ""}`.trim()));
    }
    pending.clear();
    for (const listener of [...exitListeners]) listener(exited);
  });

  function command(type, payload = {}, { timeoutMs = handshakeMs } = {}) {
    if (exited) return Promise.reject(new Error(`rpc-exit ${exited.code ?? exited.signal ?? ""}`.trim()));
    const id = `req-${(seq += 1)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`rpc-timeout ${type}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      if (!write({ id, type, ...payload })) {
        clearTimeout(timer);
        pending.delete(id);
        reject(new Error("rpc-stdin-closed"));
      }
    });
  }

  return {
    mode: "rpc",
    pid: child.pid ?? null,
    session,
    exited: () => exited,
    kill: (signal) => child.kill(signal),
    stderrTail: (limit = 1024) => stderr.slice(-limit),
    write,
    command,
    onEvent: (listener) => {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    onExit: (listener) => {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
    state: () => command("get_state"),
    prompt: async ({ text, images }) => {
      const data = await command("prompt", { message: text, ...(images?.length ? { images } : {}) });
      return data?.disposition ?? "started";
    },
    steer: async ({ text, images }) => {
      const data = await command("steer", { message: text, ...(images?.length ? { images } : {}) });
      return data?.disposition ?? "queued";
    },
    abort: () => command("abort"),
    close: async () => {
      if (exited) return;
      await Promise.race([command("abort").catch(() => {}), new Promise((resolve) => setTimeout(resolve, 2_000))]);
      try {
        child.stdin?.end();
      } catch {}
      try {
        child.kill("SIGTERM");
      } catch {}
      await new Promise((resolve) => {
        if (exited) return resolve();
        const timer = setTimeout(resolve, 5_000);
        exitListeners.add(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}
