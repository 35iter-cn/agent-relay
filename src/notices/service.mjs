import { isoAt } from "../shared/time.mjs";

export const MAX_PROMPT_BYTES = 8 * 1024;
export const REPLY_MODES = new Set(["prompt", "conversation"]);

export function truncatePrompt(prompt, limit = MAX_PROMPT_BYTES) {
  const text = String(prompt ?? "");
  if (Buffer.byteLength(text) <= limit) return { prompt: text, truncated: false };
  let length = text.length;
  while (length > 0 && Buffer.byteLength(text.slice(0, length)) > limit) {
    length = Math.floor(length * 0.9);
  }
  return { prompt: text.slice(0, length), truncated: true };
}

export function normalizeReply(reply) {
  const mode = String(reply?.mode ?? "");
  if (!REPLY_MODES.has(mode)) return null;
  if (mode !== "conversation") return { mode };
  const key = String(reply?.key ?? "").trim();
  return key ? { mode, key } : null;
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

export function createNoticeService({ state, save, adapter, now = () => Date.now(), log = () => {} }) {
  state.notices = state.notices ?? {};
  state.meta = state.meta ?? {};

  function post(text) {
    const send = adapter.postNotice ?? adapter.notify;
    if (typeof send !== "function") throw new Error(`platform ${adapter.name} cannot post notices`);
    return send.call(adapter, text);
  }

  async function emit({ text = "", prompt = "", reply = null } = {}) {
    const binding = normalizeReply(reply);
    const bound = binding?.mode === "conversation";
    const body = String(text ?? "").trim();
    if (!body) throw new Error("notice needs text");
    const kept = bound ? { prompt: "", truncated: false } : truncatePrompt(prompt);
    if (kept.truncated) log("warn", "notice-prompt", `truncated to ${MAX_PROMPT_BYTES} bytes`);
    const sent = await post(body);
    const seq = Number(state.meta.noticeSeq ?? 0) + 1;
    state.meta.noticeSeq = seq;
    const notice = {
      id: `ntc-${seq}`,
      platform: adapter.name,
      messageId: sent?.messageId ? String(sent.messageId) : null,
      sentAt: isoAt(now()),
    };
    if (bound) notice.reply = binding;
    else {
      notice.text = body;
      notice.prompt = kept.prompt;
    }
    state.notices[notice.id] = notice;
    save();
    log("info", "notice", notice.id, notice.messageId ?? "-", bound ? `bound:${binding.key}` : `${body.length} chars`);
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

  return { emit, get, match, list };
}
