export const FINISHED_STATUSES = new Set(["done", "failed", "cancelled", "interrupted"]);

export function isFinished(job) {
  return FINISHED_STATUSES.has(job?.status);
}

function highestJobSeq(state) {
  const existing = Object.keys(state.jobs ?? {})
    .map((id) => Number(String(id).replace(/^job-/, "")))
    .filter((value) => Number.isFinite(value));
  return Math.max(Number(state.meta?.jobSeq ?? 0), 0, ...existing);
}

export function createJob(state, inbound, nowIso = () => new Date().toISOString()) {
  state.meta = state.meta ?? {};
  const seq = highestJobSeq(state) + 1;
  state.meta.jobSeq = seq;
  const at = nowIso();
  return {
    id: `job-${seq}`,
    key: inbound.key,
    session: inbound.session,
    noticeId: inbound.noticeId ?? null,
    status: "queued",
    inbound: {
      text: inbound.text,
      rootText: inbound.rootText ?? inbound.text,
      chatId: inbound.chatId ?? null,
      authorId: inbound.authorId ?? null,
      dedupeId: inbound.dedupeId,
      messageId: inbound.messageId ?? null,
      threadId: inbound.threadId ?? null,
      replyTo: inbound.replyTo ?? null,
      channelPost: inbound.channelPost ?? null,
      attachments: Array.isArray(inbound.attachments) ? inbound.attachments : [],
    },
    answer: null,
    parts: [],
    progress: null,
    lease: null,
    noticeSent: false,
    retriedBy: null,
    attempts: 1,
    createdAt: at,
    updatedAt: at,
    error: null,
  };
}

export function ctxOf(job) {
  return {
    jobId: job.id,
    key: job.key,
    chatId: job.inbound.chatId,
    messageId: job.inbound.messageId,
    threadId: job.inbound.threadId,
    channelPost: job.inbound.channelPost,
    replyTo: job.inbound.replyTo ?? job.parts.at(-1)?.messageId ?? null,
    progress: job.progress,
    text: job.inbound.text,
    rootText: job.inbound.rootText,
  };
}
