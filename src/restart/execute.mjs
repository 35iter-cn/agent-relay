import { execFile, spawn as spawnProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.mjs");

// systemd-run registers the job and exits; anything longer is a bus that is not
// answering, and the caller is better off knowing that than waiting.
export const DEFAULT_SPAWN_MS = 15_000;

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

export function detachedArgs({ platform, unit, request, cliPath = CLI_PATH, execPath = process.execPath, env = process.env }) {
  return [
    "--user",
    "--collect",
    // Hand the job to systemd and return: without --no-block systemd-run waits for the
    // unit to finish, which for a restart is the health check — the caller would be
    // blocked for a minute to learn what the queue already told it in a millisecond.
    "--no-block",
    `--unit=relay-restart-${platform}`,
    "--description",
    `relay restart ${platform}`,
    "--setenv",
    `HOME=${env.HOME ?? ""}`,
    "--setenv",
    `PATH=${env.PATH ?? ""}`,
    execPath,
    cliPath,
    "restart",
    "--execute",
    "--platform",
    platform,
    "--unit",
    unit,
    "--request",
    String(request),
  ];
}

// systemd keeps the unit alive past the daemon it is restarting; a plain spawn would
// die with it and take the health check — and the caller's receipt — with it.
//
// The promise settles on systemd-run's own exit, not on the spawn call: a caller that
// reports success at spawn time is reporting that a process was created, and when the
// caller is a transient unit that exits immediately its cgroup is torn down before the
// bus request lands — the unit never exists and nobody notices. systemd-run exiting 0
// means systemd owns the job, which is the fact worth telling anyone; the restart
// itself is the unit's business from there.
export async function spawnDetachedRestart({ platform, unit, request, spawn = spawnProcess, log = () => {}, cliPath, execPath, env, exitMs = DEFAULT_SPAWN_MS } = {}) {
  let child;
  try {
    child = spawn("systemd-run", detachedArgs({ platform, unit, request, cliPath, execPath, env }), { detached: true, stdio: "ignore" });
  } catch (error) {
    log("warn", "restart-systemd-run", String(error?.message ?? error));
    return false;
  }
  const why = await new Promise((resolve) => {
    let settled = false;
    const finish = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(reason);
    };
    const timer = setTimeout(() => {
      finish(`systemd-run did not exit within ${exitMs}ms`);
      try {
        child?.kill?.("SIGKILL");
      } catch {
        // Already gone; nothing left to stop.
      }
    }, exitMs);
    if (typeof child?.on !== "function") {
      finish("");
      return;
    }
    child.on("error", (error) => finish(String(error?.message ?? error)));
    child.on("close", (code, signal) => finish(code === 0 ? "" : `systemd-run exited with ${code ?? signal}`));
  });
  child?.unref?.();
  if (why) {
    log("warn", "restart-systemd-run", why);
    return false;
  }
  return true;
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
