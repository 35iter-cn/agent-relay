import { readFileSync } from "node:fs";

export function readProcStartTicks(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const afterComm = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return afterComm[19] ?? null;
  } catch {
    return null;
  }
}

export function pidExists(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function isLeaseAlive(lease, { readStartTicks = readProcStartTicks, probeAlive = pidExists } = {}) {
  if (!lease?.pid) return false;
  const ticks = readStartTicks(lease.pid);
  if (ticks == null || lease.startTicks == null) return probeAlive(lease.pid);
  return ticks === lease.startTicks;
}
