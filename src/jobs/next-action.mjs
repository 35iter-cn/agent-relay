import { planParts } from "./delivery.mjs";
import { isLeaseAlive, readProcStartTicks } from "./lease.mjs";

export function nextAction(job, { canEdit = false, chunkLimit, readStartTicks = readProcStartTicks, probeAlive } = {}) {
  switch (job.status) {
    case "queued":
      return { type: "rerun" };
    case "running":
      return isLeaseAlive(job.lease, { readStartTicks, probeAlive })
        ? { type: "reap-then-interrupt", pid: job.lease.pid }
        : { type: "interrupt" };
    case "answered":
      return { type: "resend", parts: planParts({ answer: job.answer, parts: job.parts, chunkLimit, canEdit }) };
    default:
      return { type: "finish" };
  }
}
