import { createHash } from "node:crypto";
import { chunkText } from "../shared/chunk.mjs";

export function hashOf(text) {
  return createHash("sha256").update(String(text)).digest("hex").slice(0, 16);
}

export function planParts({ answer, parts = [], chunkLimit, canEdit = false }) {
  if (answer == null) return [];
  return chunkText(String(answer), chunkLimit).map((text, i) => {
    const sent = parts.find((part) => part.i === i);
    if (!sent) return { i, text, action: "send" };
    if (sent.hash === hashOf(text)) return { i, action: "skip" };
    if (canEdit && sent.messageId) return { i, text, action: "edit", messageId: sent.messageId };
    return { i, action: "skip" };
  });
}
