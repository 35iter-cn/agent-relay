// A fake RPC worker for tests: it speaks the same surface as createRpcWorker but
// is backed by a test child process, so a test can keep controlling timing by
// emitting stdout and close on the child.
import { EventEmitter } from "node:events";

export function workerFromChild(child, { session = null } = {}) {
  const eventListeners = new Set();
  const exitListeners = new Set();
  let buffer = "";
  let stderr = "";
  let exited = false;
  let prompted = false;
  let closedCode = null;
  let flushed = false;
  let signalled = false;
  const worker = {
    mode: "rpc",
    pid: child?.pid ?? 4242,
    prompts: [],
    steers: [],
    commands: [],
    exited: () => exited,
    onEvent(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    onExit(listener) {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
    async state() {
      return { sessionId: session };
    },
    async command(record) {
      worker.commands.push(record);
      return {};
    },
    async prompt(text) {
      worker.prompts.push(typeof text === "string" ? text : String(text?.text ?? ""));
      prompted = true;
      setImmediate(flush);
      return "started";
    },
    async steer(text) {
      worker.steers.push(text);
      return "queued";
    },
    kill(signal) {
      signalled = true;
      child?.kill?.(signal);
    },
    stderrTail: (limit = 8 * 1024) => stderr.slice(-limit),
  };
  const emit = (record) => {
    for (const listener of [...eventListeners]) listener(record);
  };
  child?.stdout?.on?.("data", (chunk) => {
    buffer += String(chunk);
  });
  child?.stderr?.on?.("data", (chunk) => {
    stderr += String(chunk);
  });
  function flush() {
    if (flushed || !prompted || closedCode === null) return;
    flushed = true;
    const text = buffer.trim();
    // "final" is neither stop nor length, so nothing is streamed as a segment:
    // the answer is delivered once, exactly like a one-shot worker.
    const stopReason = closedCode === 0 ? "final" : "error";
    if (text) emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason } });
    // A killed worker exits without settling: the runtime treats that as an
    // interrupted run, exactly like a real child dying under SIGTERM.
    if (!signalled && (text || closedCode === 0)) emit({ type: "agent_settled", aborted: false });
    for (const listener of [...exitListeners]) listener({ code: closedCode, signal: signalled ? "SIGTERM" : null });
  }
  child?.on?.("close", (code) => {
    exited = true;
    closedCode = code ?? 0;
    setImmediate(flush);
  });
  return worker;
}

// Use as `deps.workerFactory`: the test keeps supplying `spawn`/`buildChild`.
export function stubWorkerFactory(spawn) {
  return (options = {}) => {
    const child = spawn(options.bin, options.args ?? [], {});
    return workerFromChild(child, options);
  };
}

export function silentChild() {
  const child = new EventEmitter();
  child.pid = 424242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  return child;
}
