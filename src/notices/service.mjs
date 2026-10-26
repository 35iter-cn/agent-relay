import { isoAt } from "../shared/time.mjs";

export const NOTICE_TTL_MS = 7 * 86_400_000;
export const MAX_NOTICES = 500;
export const MAX_PROMPT_BYTES = 8 * 1024;

export function truncatePrompt(prompt, limit = MAX_PROMPT_BYTES) {
  const text = String(prompt ?? "");
  if (Buffer.byteLength(text) <= limit) return { prompt: text, truncated: false };
  let length = text.length;
  while (length > 0 && Buffer.byteLength(text.slice(0, length)) > limit) {
    length = Math.floor(length * 0.9);
  }
  return { prompt: text.slice(0, length), truncated: true };
}

export function matchNotice(notices, platform, replyIds = []) {
  const ids = new Set((replyIds ?? []).filter(Boolean).map(String));
  if (!ids.size) return null;
  let best = null;
  for (const notice of Object.values(notices ?? {})) {
    if (notice.platform !== platform) continue;
    if (!notice.messageId || !ids.has(String(notice.messageId))) continue;
    if (!best || String(notice.sentAt) > String(best.sentAt)) best = notice;
  }
  return best;
}

export function pruneNotices(notices, nowMs = Date.now(), ttlMs = NOTICE_TTL_MS, max = MAX_NOTICES) {
  const entries = Object.values(notices ?? {});
  const stale = entries.filter((notice) => {
    const at = Date.parse(notice?.sentAt ?? "");
    return !Number.isFinite(at) || nowMs - at > ttlMs;
  });
  for (const notice of stale) delete notices[notice.id];
  const rest = Object.values(notices).sort((a, b) => String(b.sentAt).localeCompare(String(a.sentAt)));
  for (const notice of rest.slice(max)) delete notices[notice.id];
  return stale.length + Math.max(0, rest.length - max);
}

export function createNoticeService({ state, save, adapter, now = () => Date.now(), log = () => {} }) {
  state.notices = state.notices ?? {};
  state.meta = state.meta ?? {};

  function post(text) {
    const send = adapter.postNotice ?? adapter.notify;
    if (typeof send !== "function") throw new Error(`platform ${adapter.name} cannot post notices`);
    return send.call(adapter, text);
  }

  async function emit({ text, prompt = "" } = {}) {
    const body = String(text ?? "").trim();
    if (!body) throw new Error("notice needs text");
    const kept = truncatePrompt(prompt);
    if (kept.truncated) log("warn", "notice-prompt", `truncated to ${MAX_PROMPT_BYTES} bytes`);
    const sent = await post(body);
    const seq = Number(state.meta.noticeSeq ?? 0) + 1;
    state.meta.noticeSeq = seq;
    const notice = {
      id: `ntc-${seq}`,
      platform: adapter.name,
      text: body,
      prompt: kept.prompt,
      messageId: sent?.messageId ? String(sent.messageId) : null,
      sentAt: isoAt(now()),
    };
    state.notices[notice.id] = notice;
    save();
    log("info", "notice", notice.id, notice.messageId ?? "-", `${body.length} chars`);
    return notice;
  }

  function get(id) {
    return state.notices[id] ?? null;
  }

  function match(replyIds) {
    return matchNotice(state.notices, adapter.name, replyIds);
  }

  function list() {
    return Object.values(state.notices).sort((a, b) => String(a.sentAt).localeCompare(String(b.sentAt)));
  }

  function prune() {
    const dropped = pruneNotices(state.notices, now());
    if (dropped) save();
    return dropped;
  }

  return { emit, get, match, list, prune };
}
