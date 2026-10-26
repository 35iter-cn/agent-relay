import { readFileSync } from "node:fs";

export const DEFAULT_LEASE_TTL_MS = 45_000;

export function readProcStartTicks(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const afterComm = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return afterComm[19] ?? null;
  } catch {
    return null;
  }
}

export function isLeaseAlive(lease, now, ttlMs = DEFAULT_LEASE_TTL_MS, readStartTicks = readProcStartTicks) {
  if (!lease?.pid) return false;
  if (!Number.isFinite(lease.heartbeatAt) || now - lease.heartbeatAt > ttlMs) return false;
  const ticks = readStartTicks(lease.pid);
  return ticks != null && ticks === lease.startTicks;
}
