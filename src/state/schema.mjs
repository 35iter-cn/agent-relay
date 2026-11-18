export const SCHEMA_VERSION = 5;

const KIND_BY_ORIGIN = {
  user: "conversation",
  self: "scheduled",
  external: "scheduled",
  system: "loop",
  loop: "loop",
};

function migrateJobs(jobs) {
  for (const job of Object.values(jobs ?? {})) {
    if (!job) continue;
    if (!job.kind) job.kind = KIND_BY_ORIGIN[job.origin ?? "user"] ?? "conversation";
    delete job.origin;
  }
}

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

function latestBoundNotices(notices) {
  const latest = new Map();
  for (const notice of Object.values(notices ?? {})) {
    if (!notice || notice.reply?.mode !== "conversation") continue;
    const key = notice.reply.key;
    if (!key || !notice.messageId) continue;
    const held = latest.get(key);
    if (!held || String(notice.sentAt ?? "") >= String(held.sentAt ?? "")) latest.set(key, notice);
  }
  return latest;
}

function bindLegacyConversations(state) {
  const latest = latestBoundNotices(state.notices);
  for (const [key, entry] of Object.entries(state.convs ?? {})) {
    if (!entry || entry.messageId) continue;
    const notice = latest.get(key);
    if (notice?.messageId) entry.messageId = String(notice.messageId);
  }
  for (const job of Object.values(state.jobs ?? {})) {
    const inbound = job?.inbound;
    if (!inbound || inbound.boundKey) continue;
    const replyTo = inbound.replyTo;
    if (!replyTo || !state.convs?.[replyTo]) continue;
    inbound.boundKey = String(replyTo);
    inbound.replyTo = null;
  }
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
    bindLegacyConversations(next);
    migrateJobs(next.jobs);
    next.meta.schemaVersion = SCHEMA_VERSION;
  }
  return next;
}
