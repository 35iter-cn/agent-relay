import fs from "node:fs";
import { join } from "node:path";
import { normalizeSessionId } from "./ledger.mjs";

export function heartbeatFile(sessionId, root) {
  return join(root, "heartbeat", `${normalizeSessionId(sessionId)}.json`);
}

export function readBeat(sessionId, { root, fsImpl = fs } = {}) {
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(heartbeatFile(sessionId, root), "utf8"));
    if (!parsed || typeof parsed.at !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}
