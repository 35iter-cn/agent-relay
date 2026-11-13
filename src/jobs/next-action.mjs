import { planParts } from "./delivery.mjs";
import { isLeaseAlive, readProcStartTicks } from "./lease.mjs";

export function nextAction(job, { canEdit = false, chunkLimit, media = null, readStartTicks = readProcStartTicks, probeAlive } = {}) {
  switch (job.status) {
    case "scheduled":
      return { type: "none" };
    case "queued":
      return { type: "rerun" };
    case "running":
      return isLeaseAlive(job.lease, { readStartTicks, probeAlive })
        ? { type: "reap-then-interrupt", pid: job.lease.pid }
        : { type: "interrupt" };
    case "answered":
      return { type: "resend", parts: planParts({ answer: media ? media.text : job.answer, parts: job.parts, chunkLimit, canEdit, media }) };
    case "retrying":
      return { type: "retry-delivery" };
    default:
      return { type: "finish" };
  }
}
