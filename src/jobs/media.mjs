import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { basename } from "node:path";
import { MAX_BYTES, mimeForExt } from "../platforms/shared/uploads.mjs";

export const MAX_MEDIA = 4;
const LINE = /^!\[[^\]]*\]\(([^)\s]+)\)$/;

export function extractMedia(answer, { limit = MAX_MEDIA, maxBytes = MAX_BYTES } = {}) {
  const source = String(answer ?? "");
  const files = [];
  const invalid = [];
  const kept = [];
  let stripped = 0;
  for (const line of source.split("\n")) {
    const ref = line.trim().match(LINE)?.[1];
    if (!ref) {
      kept.push(line);
      continue;
    }
    stripped += 1;
    const file = acceptImage(ref, maxBytes);
    if (file) files.push(file);
    else invalid.push(ref);
  }
  if (!stripped) return { text: source, files: [], invalid: [], dropped: 0 };
  const picked = files.slice(0, limit);
  const dropped = files.length - picked.length;
  const notes = [];
  if (dropped) notes.push(`（还有 ${dropped} 张图片未发送，单条回复最多 ${limit} 张）`);
  if (invalid.length) notes.push(`（${invalid.length} 张图片引用无法读取，未发送）`);
  const text = [...kept, ...notes].join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text, files: picked, invalid, dropped };
}

export function mediaHash(files) {
  const text = files.map((file) => `${file.path}:${file.size}:${file.mtimeMs}`).join("|");
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function acceptImage(ref, maxBytes) {
  if (!ref.startsWith("/")) return null;
  const mime = mimeForExt(ref.split(".").pop());
  if (!mime) return null;
  try {
    const stat = statSync(ref);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return { path: ref, name: basename(ref), mime, size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}
