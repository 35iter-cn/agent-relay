#!/usr/bin/env bun
// The restart the daemon asks for runs as a separate process, so this suite keeps the
// OS boundary stubbed (a `systemctl` shim on PATH) and everything else real: the CLI
// binary, the state file, the exit codes and the lines a caller sees.
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const HERE = new URL(".", import.meta.url).pathname;
const CLI = join(HERE, "..", "..", "src", "cli.mjs");
const dir = mkdtempSync(join(tmpdir(), "relay-restart-e2e-"));
const configDir = join(dir, ".config/agent-relay");
const binDir = join(dir, "bin");
for (const path of [configDir, binDir]) mkdirSync(path, { recursive: true });

// A systemctl that pretends the unit restarts: it bumps a pid file on `restart` and
// answers `show ... MainPID --value` from it. `RELAY_E2E_STUCK=1` keeps the pid fixed,
// which is what a unit that never came back looks like.
const systemctlShim = `#!/usr/bin/env bash
set -euo pipefail
[ "\${1:-}" = "--user" ] && shift
unit="\${2:-}"
echo "$unit $*" >> "${dir}/systemctl.log"
case "$1" in
  is-active) echo active ;;
  restart)
    if [ "\${RELAY_E2E_STUCK:-0}" = "1" ]; then exit 0; fi
    current="$(cat "${dir}/pid" 2>/dev/null || echo 7000)"
    echo "$((current + 1))" > "${dir}/pid"
    ;;
  show) cat "${dir}/pid" 2>/dev/null || echo 7000 ;;
  *) echo "" ;;
esac
`;
writeFileSync(join(configDir, "config.json"), `${JSON.stringify({ relay: { restart: { healthMs: 1_500 } } })}\n`);
writeFileSync(join(binDir, "systemctl"), systemctlShim);
chmodSync(join(binDir, "systemctl"), 0o755);
writeFileSync(join(dir, "pid"), "7000");

const env = { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}`, AGENT_RELAY_CONFIG_DIR: configDir };

function run(args, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...env, ...extraEnv } });
    const out = [];
    const err = [];
    child.stdout.on("data", (chunk) => out.push(String(chunk)));
    child.stderr.on("data", (chunk) => err.push(String(chunk)));
    child.on("exit", (code) => resolve({ code, out: out.join(""), err: err.join("") }));
  });
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  if (ok) console.log(`PASS ${name}`);
  else console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

// E-1 a healthy unit: the executor reports the pid it replaced and the one it found
const healthy = await run(["restart", "--execute", "--platform", "e2e", "--unit", "agent-relay@e2e", "--request", "7"]);
check("E-1 the executor reports the restart with both pids", healthy.code === 0 && /restart ok \(request 7, pid 7000 -> 7001\)/.test(healthy.out), `code=${healthy.code} out=${healthy.out.trim()} err=${healthy.err.trim()}`);
const shimLog = existsSync(join(dir, "systemctl.log")) ? readFileSync(join(dir, "systemctl.log"), "utf8") : "";
check("E-2 the executor drove the configured unit", /restart agent-relay@e2e/.test(shimLog), shimLog.trim());

// E-3 a unit that never comes back with a new pid is a failure, never a silent success
const stuck = await run(["restart", "--execute", "--platform", "e2e", "--unit", "agent-relay@e2e", "--request", "8"], { RELAY_E2E_STUCK: "1" });
check("E-3 an unchanged MainPID exits 1", stuck.code === 1 && /restart failed \(request 8\)/.test(stuck.err), `code=${stuck.code} err=${stuck.err.trim()}`);

// E-4 status reads the slot the daemon wrote, one line per platform
writeFileSync(
  join(configDir, "relay-slack.json"),
  `${JSON.stringify({
    jobs: {},
    restart: { seq: 7, status: "pending", requestedAt: new Date(Date.now() - 3 * 60_000).toISOString(), deadlineAt: new Date(Date.now() + 57 * 60_000).toISOString() },
  })}\n`,
);
const status = await run(["restart", "status"]);
check("E-4 status prints the pending slot", status.code === 0 && /slack: request 7 pending, 3 min waited, deadline /.test(status.out), status.out.trim());
check("E-4b status names the one platform it fans out to", status.out.trim().split("\n").length === 1 && !/feishu/.test(status.out), status.out.trim());

// E-6 no daemon and no active unit: nothing is queued, nothing is restarted, and the
// caller is told per platform instead of getting one opaque error
const before = existsSync(join(dir, "systemctl.log")) ? readFileSync(join(dir, "systemctl.log"), "utf8") : "";
writeFileSync(join(binDir, "systemctl"), `#!/usr/bin/env bash\necho "$*" >> "${dir}/skip.log"\necho inactive\n`);
chmodSync(join(binDir, "systemctl"), 0o755);
const stranded = await run(["restart"]);
const after = existsSync(join(dir, "skip.log")) ? readFileSync(join(dir, "skip.log"), "utf8") : "";
check("E-6 a stopped relay is skipped per platform", stranded.code === 1 && /slack: daemon not running; unit not active, skipped/.test(stranded.out) && stranded.out.trim().split("\n").length === 1, `code=${stranded.code} out=${stranded.out.trim()}`);
check("E-7 nothing is restarted when no unit is active", !/ restart /.test(after) && before === before, after.trim());

const failed = results.filter((item) => !item.ok);
console.log(`\n${failed.length ? `${failed.length} failed:` : "all restart checks passed"}${failed.length ? `\n${failed.map((item) => `  ${item.name} — ${item.detail}`).join("\n")}` : ""}`);
if (failed.length) process.exit(1);
try {
  execFileSync("rm", ["-rf", dir]);
} catch {}
