import { readFileSync, statSync } from "node:fs";

export const MAX_PROMPT_FILE_BYTES = 64 * 1024;

export function validatePromptFile(path) {
  const file = String(path ?? "").trim();
  if (!file) return "empty-prompt-file";
  let stat;
  try {
    stat = statSync(file);
  } catch {
    return "prompt-file-missing";
  }
  if (!stat.isFile()) return "prompt-file-not-file";
  if (stat.size > MAX_PROMPT_FILE_BYTES) return "prompt-file-too-large";
  try {
    if (!readFileSync(file, "utf8").trim()) return "empty-prompt";
  } catch {
    return "prompt-file-unreadable";
  }
  return null;
}

export function resolveLoopPrompt(loop) {
  const file = String(loop?.promptFile ?? "").trim();
  if (!file) {
    const text = String(loop?.prompt ?? "").trim();
    return text ? { text } : { error: "empty-prompt" };
  }
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return { error: "prompt-unreadable" };
  }
  const text = raw.trim();
  if (!text) return { error: "empty-prompt" };
  if (Buffer.byteLength(text) > MAX_PROMPT_FILE_BYTES) return { error: "prompt-too-long" };
  return { text };
}
