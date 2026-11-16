#!/usr/bin/env bun

export const DELIVERY_MARKER = "<<<relay>>>";

export function deliverBody(text) {
  const source = String(text ?? "");
  const lines = source.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].trim() !== DELIVERY_MARKER) continue;
    const body = lines.slice(i + 1).join("\n").trim();
    if (!body) return { body: source.trim(), marked: false };
    return { body, marked: true };
  }
  return { body: source.trim(), marked: false };
}
