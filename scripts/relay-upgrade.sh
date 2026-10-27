#!/usr/bin/env bash
set -euo pipefail

platform="${1:-}"
if [[ -z "$platform" ]]; then
  echo "usage: relay-upgrade.sh <feishu|slack|telegram>" >&2
  exit 2
fi

state="${AGENT_RELAY_CONFIG_DIR:-$HOME/.config/agent-relay}/relay-$platform.json"
wait_seconds="${RELAY_UPGRADE_WAIT:-0}"
heartbeat_seconds="${RELAY_UPGRADE_HEARTBEAT:-300}"
script_dir="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
relay_root="$(dirname "$script_dir")"

notify() {
  if [[ "${RELAY_UPGRADE_NOTIFY:-1}" == "0" ]]; then
    return 0
  fi
  local bun_bin
  bun_bin="$(command -v bun || true)"
  if [[ -z "$bun_bin" ]]; then
    echo "relay-upgrade: WARN bun not found, skipping notify" >&2
    return 0
  fi
  if ! "$bun_bin" "$relay_root/src/cli.mjs" notice emit --platform "$platform" --text "$1"; then
    echo "relay-upgrade: WARN notify failed" >&2
  fi
}

snapshot() {
  node -e '
    const fs = require("node:fs");
    const active = new Set(["queued", "running", "answered"]);
    let state = {};
    try {
      state = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    } catch {
      process.stdout.write("0");
      process.exit(0);
    }
    const ids = Object.entries(state.jobs ?? {})
      .filter(([, job]) => active.has(job.status))
      .map(([id]) => id);
    process.stdout.write(ids.length === 0 ? "0" : `${ids.length} ${ids.join(",")}`);
  ' "$state"
}

if [[ -z "${RELAY_UPGRADE_DETACHED:-}" ]] && grep -Eq "agent-relay@|relay@" /proc/self/cgroup 2>/dev/null; then
  unit="relay-upgrade-$platform"
  self="$script_dir/$(basename "$0")"
  if systemctl --user is-active --quiet "$unit"; then
    echo "relay-upgrade: $unit is already waiting (journalctl --user -u $unit)" >&2
    exit 4
  fi
  echo "relay-upgrade: running inside relay cgroup, moving to $unit so the restart cannot kill me"
  if systemd-run --user --collect --unit="$unit" \
    --description "relay upgrade $platform" \
    --setenv=HOME="$HOME" \
    --setenv=PATH="$PATH" \
    --setenv=RELAY_UPGRADE_DETACHED=1 \
    --setenv=RELAY_UPGRADE_WAIT="$wait_seconds" \
    --setenv=RELAY_UPGRADE_HEARTBEAT="$heartbeat_seconds" \
    --setenv=RELAY_UPGRADE_NOTIFY="${RELAY_UPGRADE_NOTIFY:-1}" \
    /bin/bash "$self" "$platform"; then
    echo "relay-upgrade: detached, follow with journalctl --user -u $unit"
    exit 0
  fi
  echo "relay-upgrade: WARN systemd-run failed, staying in the relay cgroup (the restart may kill me before the health check)" >&2
fi

if [[ "$wait_seconds" == "0" ]]; then
  echo "relay-upgrade: $platform waiting for 0 in-flight jobs (state=$state, no time limit)"
else
  echo "relay-upgrade: $platform waiting for 0 in-flight jobs (state=$state, give up after ${wait_seconds}s without restarting)"
fi

started=$SECONDS
last_line=""
last_beat=$started

while true; do
  read -r pending ids <<< "$(snapshot)"
  if [[ "$pending" == "0" ]]; then
    break
  fi
  line="relay-upgrade: $pending job(s) in flight ($ids), waiting"
  if [[ "$line" != "$last_line" ]] || (( SECONDS - last_beat >= heartbeat_seconds )); then
    echo "$line"
    last_line="$line"
    last_beat=$SECONDS
  fi
  if (( wait_seconds > 0 && SECONDS - started >= wait_seconds )); then
    echo "relay-upgrade: still $pending job(s) in flight after ${wait_seconds}s — NOT restarting, relay left untouched. Check again later or raise RELAY_UPGRADE_WAIT." >&2
    exit 3
  fi
  sleep 10
done

before_pid="$(systemctl --user show "agent-relay@$platform.service" -p MainPID --value || true)"
echo "relay-upgrade: 0 in-flight job(s), restarting $platform (old pid ${before_pid:-none})"
systemctl --user restart "agent-relay@$platform.service"
sleep 10

pid="$(systemctl --user show "agent-relay@$platform.service" -p MainPID --value || true)"
entered="$(systemctl --user show "agent-relay@$platform.service" -p ActiveEnterTimestamp --value || true)"

if systemctl --user is-active --quiet "agent-relay@$platform.service" && [[ -n "${pid:-}" && "$pid" != "0" && "$pid" != "${before_pid:-}" ]]; then
  echo "relay-upgrade: OK $platform active (pid $pid, entered ${entered:-?})"
  notify "🔄 agent-relay-$platform 已重启，健康检查通过（pid ${before_pid:-none} → $pid，$(date '+%Y-%m-%d %H:%M')）"
  exit 0
fi

echo "relay-upgrade: FAILED $platform — is-active or MainPID unchanged (before=${before_pid:-none} now=${pid:-none}, entered ${entered:-?})" >&2
journalctl --user -u "agent-relay@$platform.service" -n 30 --no-pager >&2
notify "🔴 agent-relay-$platform 重启后未通过健康检查（服务未 active 或 MainPID 未变，旧进程还在），需要人工看一下（journalctl --user -u agent-relay@$platform）"
exit 1
