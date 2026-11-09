import { spawn as spawnProcess } from "node:child_process";

export function runPrintWorker({ config, command, env, timeoutMs = null, onSpawn, onTimeout, onClose, deps = {} }) {
  const spawn = deps.spawn ?? spawnProcess;
  const child = spawn(command.bin, command.args, {
    cwd: config.cwd,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });
  let stdout = "";
  let stderr = "";
  let killed = false;
  const handle = {
    mode: "print",
    pid: child.pid ?? null,
    kill: (signal) => child.kill(signal),
    stderrTail: (limit = 8 * 1024) => stderr.slice(-limit),
  };
  onSpawn?.(handle);
  const timer =
    timeoutMs === null
      ? null
      : setTimeout(() => {
          killed = true;
          onTimeout?.(handle);
        }, timeoutMs);
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.on("error", (error) => (stderr += `${error}\n`));
  child.on("close", (code) => {
    if (timer) clearTimeout(timer);
    onClose?.({ code, killed, stdout, stderr, handle });
  });
  return handle;
}
