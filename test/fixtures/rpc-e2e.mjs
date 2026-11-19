// A real child process that speaks the RPC handshake, for the e2e suites.
import { createRpcWorker } from "../../src/runtime/worker-rpc.mjs";
import { fileURLToPath } from "node:url";

const FIXTURE = fileURLToPath(new URL("./rpc-hold.mjs", import.meta.url));

export function e2eWorker({ answer = "", exit = 0, delayMs = 0, holdOn = "", dispatched = null } = {}) {
  return (options) => {
    const worker = createRpcWorker({
      ...options,
      bin: process.execPath,
      args: [FIXTURE],
      env: {
        ...options.env,
        RPC_FIXTURE_SESSION: String(options.session ?? ""),
        RPC_FIXTURE_ANSWER: answer,
        RPC_FIXTURE_EXIT: String(exit),
        RPC_FIXTURE_DELAY_MS: String(delayMs),
        RPC_FIXTURE_HOLD_ON: holdOn,
      },
    });
    if (dispatched) {
      const send = worker.prompt.bind(worker);
      worker.prompt = (text) => {
        dispatched.push(typeof text === "string" ? text : String(text?.text ?? ""));
        return send(text);
      };
    }
    return worker;
  };
}
