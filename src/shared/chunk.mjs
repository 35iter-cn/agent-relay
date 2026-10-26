#!/usr/bin/env bun

export function chunkText(text, limit) {
  if (!Number.isInteger(limit) || limit <= 0) throw new Error(`invalid chunk limit: ${limit}`);
  const source = String(text ?? "");
  if (!source) return [""];
  const chunks = [];
  let buffer = "";
  for (const line of source.split("\n")) {
    const piece = buffer ? `${buffer}\n${line}` : line;
    if (buffer && length(piece) > limit) {
      chunks.push(buffer);
      buffer = line;
    } else {
      buffer = piece;
    }
    while (length(buffer) > limit) {
      const [head, rest] = splitAt(buffer, limit);
      chunks.push(head);
      buffer = rest;
    }
  }
  if (buffer) chunks.push(buffer);
  return chunks.length ? chunks : [""];
}

function length(value) {
  return [...value].length;
}

function splitAt(value, limit) {
  const chars = [...value];
  return [chars.slice(0, limit).join(""), chars.slice(limit).join("")];
}
