import { planParts } from "./delivery.mjs";
import { DEFAULT_LEASE_TTL_MS, isLeaseAlive, readProcStartTicks } from "./lease.mjs";

export function nextAction(job, { now, leaseTtlMs = DEFAULT_LEASE_TTL_MS, canEdit = false, chunkLimit, readStartTicks = readProcStartTicks } = {}) {
  switch (job.status) {
    case "queued":
      return { type: "rerun" };
    case "running":
      return isLeaseAlive(job.lease, now, leaseTtlMs, readStartTicks)
        ? { type: "reap-then-interrupt", pid: job.lease.pid }
        : { type: "interrupt" };
    case "answered":
      return { type: "resend", parts: planParts({ answer: job.answer, parts: job.parts, chunkLimit, canEdit }) };
    default:
      return { type: "finish" };
  }
}
