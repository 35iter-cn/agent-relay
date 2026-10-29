import { createHash } from "node:crypto";
import { chunkText } from "../shared/chunk.mjs";
import { mediaHash } from "./media.mjs";

export function hashOf(text) {
  return createHash("sha256").update(String(text)).digest("hex").slice(0, 16);
}

export function planParts({ answer, parts = [], chunkLimit, canEdit = false, media = null }) {
  if (answer == null) return [];
  const files = media?.files ?? [];
  const chunks = chunkText(String(answer), chunkLimit).filter((text) => !files.length || text.trim());
  const steps = chunks.map((text, i) => {
    const sent = parts.find((part) => part.i === i);
    if (!sent) return { i, text, action: "send" };
    if (sent.hash === hashOf(text)) return { i, action: "skip" };
    if (canEdit && sent.messageId) return { i, text, action: "edit", messageId: sent.messageId };
    return { i, action: "skip" };
  });
  if (!files.length) return steps;
  const i = chunks.length;
  const hash = mediaHash(files);
  const sent = parts.find((part) => part.kind === "media");
  steps.push({ i, kind: "media", files, hash, action: sent?.hash === hash ? "skip" : "send" });
  return steps;
}
