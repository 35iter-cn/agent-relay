import { execFile, spawn as spawnProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.mjs");

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
export function spawnDetachedRestart({ platform, unit, request, spawn = spawnProcess, log = () => {}, cliPath, execPath, env } = {}) {
  try {
    const child = spawn("systemd-run", detachedArgs({ platform, unit, request, cliPath, execPath, env }), { detached: true, stdio: "ignore" });
    if (typeof child?.on === "function") child.on("error", (error) => log("warn", "restart-systemd-run", String(error?.message ?? error)));
    child?.unref?.();
    return true;
  } catch (error) {
    log("warn", "restart-systemd-run", String(error?.message ?? error));
    return false;
  }
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
