import { isoAt } from "../shared/time.mjs";
import { registry } from "./registry.mjs";

export const NOTICE_TTL_MS = 7 * 86_400_000;
export const MAX_NOTICES = 500;

export function actionsText(kind, notice, { cli = "agent-relay" } = {}) {
  const entries = Object.entries(kind.actions ?? {});
  if (!entries.length) return "";
  return entries
    .map(([name, spec]) => `- ${spec.help} → \`${cli} action ${notice.platform} ${notice.id} ${name}${spec.args ? ` ${spec.args}` : ""}\``)
    .join("\n");
}

export function noticePromptValues(notice, kind, { cli = "agent-relay" } = {}) {
  return {
    notice_id: notice.id,
    notice_kind: notice.kind,
    notice_actions: actionsText(kind, notice, { cli }) || "- 这条通知没有结构化动作，按正文回答即可。",
    notice_refs: JSON.stringify(notice.refs ?? {}, null, 2),
  };
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

export function createNoticeService({ state, save, adapter, now = () => Date.now(), kinds = registry, log = () => {} }) {
  state.notices = state.notices ?? {};
  state.meta = state.meta ?? {};

  function post(text) {
    const send = adapter.postNotice ?? adapter.notify;
    if (typeof send !== "function") throw new Error(`platform ${adapter.name} cannot post notices`);
    return send.call(adapter, text);
  }

  async function emit(kindId, payload = {}, { refs = {}, scope = null } = {}) {
    const kind = kinds.get(kindId);
    const text = kind.render(payload, { platform: adapter.name, scope });
    const sent = await post(text);
    const seq = Number(state.meta.noticeSeq ?? 0) + 1;
    state.meta.noticeSeq = seq;
    const notice = {
      id: `ntc-${seq}`,
      kind: kind.id,
      platform: adapter.name,
      messageId: sent?.messageId ? String(sent.messageId) : null,
      refs,
      payload,
      actions: Object.keys(kind.actions ?? {}),
      text,
      sentAt: isoAt(now()),
    };
    state.notices[notice.id] = notice;
    save();
    log("info", "notice", notice.id, notice.kind, notice.messageId ?? "-");
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

  return { emit, get, match, list, prune, kinds };
}
