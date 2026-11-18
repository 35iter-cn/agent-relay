export const SCHEMA_VERSION = 4;

export function emptyState() {
  return {
    cursor: null,
    seen: {},
    convs: {},
    alerts: {},
    jobs: {},
    inbox: [],
    notices: {},
    loops: {},
    meta: { schemaVersion: SCHEMA_VERSION, jobSeq: 0, noticeSeq: 0, loopRoundStamps: [] },
  };
}

export function upgradeState(state) {
  const next = state ?? emptyState();
  next.seen = next.seen ?? {};
  next.convs = next.convs ?? {};
  next.alerts = next.alerts ?? {};
  next.meta = next.meta ?? {};
  next.jobs = next.jobs ?? {};
  next.inbox = next.inbox ?? [];
  next.notices = next.notices ?? {};
  next.loops = next.loops ?? {};
  next.meta.loopRoundStamps = next.meta.loopRoundStamps ?? [];
  if (next.meta.schemaVersion !== SCHEMA_VERSION) {
    for (const [dedupeId, value] of Object.entries(next.seen)) {
      if (value !== "legacy" && !next.jobs[value]) next.seen[dedupeId] = "legacy";
    }
    for (const entry of Object.values(next.convs)) {
      if (entry && entry.activeJob === undefined) entry.activeJob = null;
      if (entry && entry.messageId === undefined) entry.messageId = null;
    }
    for (const loop of Object.values(next.loops)) {
      if (loop) delete loop.thread;
    }
    next.meta.schemaVersion = SCHEMA_VERSION;
  }
  return next;
}
