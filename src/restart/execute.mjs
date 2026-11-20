import { execFile } from "node:child_process";

// The executor is the same CLI in a detached systemd unit, because the restart it
// performs kills the daemon that asked for it. It reads no daemon state: systemctl
// is the only thing that knows whether the new instance came up.
export function createSystemctl({ run = execFile } = {}) {
  return function systemctl(...args) {
    return new Promise((resolve, reject) => {
      run("systemctl", ["--user", ...args], { encoding: "utf8" }, (error, stdout) => {
        if (error) reject(error);
        else resolve(String(stdout ?? "").trim());
      });
    });
  };
}

// Returns 0 when the unit came back with a new MainPID, 1 when it did not.
export async function executeRestart({ unit, request, systemctl, healthMs = 60_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  let before = "";
  try {
    before = await systemctl("show", unit, "-p", "MainPID", "--value");
  } catch (error) {
    before = "";
  }
  await systemctl("restart", unit);
  const deadline = Date.now() + healthMs;
  while (Date.now() < deadline) {
    const [pid, active] = await Promise.all([
      systemctl("show", unit, "-p", "MainPID", "--value").catch(() => ""),
      systemctl("is-active", unit).catch(() => ""),
    ]);
    if (active === "active" && pid && pid !== before) return { code: 0, before, pid };
    await sleep(1_000);
  }
  return { code: 1, before, pid: "" };
}
