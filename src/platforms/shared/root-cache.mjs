export const CONVERSATION_RETENTION_MS = 30 * 86_400_000;

export function pruneConversations(convs, now = Date.now(), retentionMs = CONVERSATION_RETENTION_MS) {
  const kept = {};
  for (const [key, value] of Object.entries(convs ?? {})) {
    const seen = Date.parse(value?.lastMsgTs ?? "");
    if (Number.isFinite(seen) && now - seen > retentionMs) continue;
    kept[key] = value;
  }
  return kept;
}

export function createRootCache({ getState, save, log = () => {}, fetchRootText, sessionFor, maxFail = 3 }) {
  return {
    async textFor(identity, key) {
      const state = getState();
      if (!state) return null;
      const entry = state.convs[key] ?? { session: sessionFor(key), rootText: null, rootFail: 0 };
      state.convs[key] = entry;
      if (entry.rootText !== null && entry.rootText !== undefined) return entry.rootText || null;
      try {
        const text = await fetchRootText(identity, key);
        if (text === null) {
          entry.rootText = "";
          save();
          return null;
        }
        entry.rootText = text;
        entry.rootFail = 0;
        log("info", "root", key, `${text.length} chars`);
      } catch (error) {
        entry.rootFail = (entry.rootFail ?? 0) + 1;
        log("error", "root-fetch", key, String(error?.message ?? error));
        if (entry.rootFail >= maxFail) entry.rootText = "";
      }
      save();
      return entry.rootText || null;
    },

    prune(now = Date.now()) {
      const state = getState();
      const before = Object.keys(state.convs ?? {}).length;
      state.convs = pruneConversations(state.convs, now);
      const dropped = before - Object.keys(state.convs).length;
      if (dropped) {
        save();
        log("info", "convs-pruned", `dropped=${dropped}`);
      }
      return dropped;
    },
  };
}
