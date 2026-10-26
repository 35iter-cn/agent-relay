import { isFinished } from "../jobs/model.mjs";

export const JOB_RETENTION_MS = 30 * 86_400_000;
export const MAX_JOBS = 2000;

function heldJobIds(state) {
  const held = new Set(state.inbox ?? []);
  for (const entry of Object.values(state.convs ?? {})) {
    if (entry?.activeJob) held.add(entry.activeJob);
  }
  return held;
}

function ageOf(job) {
  const at = Date.parse(job?.updatedAt ?? "");
  return Number.isFinite(at) ? at : 0;
}

export function pruneState(state, nowMs = Date.now(), { jobRetentionMs = JOB_RETENTION_MS, maxJobs = MAX_JOBS } = {}) {
  const held = heldJobIds(state);
  const jobs = state.jobs ?? {};
  const removable = new Set();

  for (const [id, job] of Object.entries(jobs)) {
    if (!job || held.has(id) || !isFinished(job)) continue;
    if (nowMs - ageOf(job) > jobRetentionMs) removable.add(id);
  }

  const survivors = Object.keys(jobs).filter((id) => !removable.has(id));
  if (survivors.length > maxJobs) {
    const overflow = survivors
      .filter((id) => !held.has(id) && isFinished(jobs[id]))
      .sort((a, b) => ageOf(jobs[a]) - ageOf(jobs[b]))
      .slice(0, survivors.length - maxJobs);
    for (const id of overflow) removable.add(id);
  }

  for (const id of removable) delete jobs[id];

  for (const [dedupeId, value] of Object.entries(state.seen ?? {})) {
    if (value !== "legacy" && !jobs[value]) state.seen[dedupeId] = "legacy";
  }

  for (const entry of Object.values(state.convs ?? {})) {
    if (entry?.activeJob && !jobs[entry.activeJob]) entry.activeJob = null;
  }

  return removable.size;
}
