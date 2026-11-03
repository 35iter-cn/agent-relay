const FENCE = /^\s*(```|~~~)/;

function splitRow(line) {
  return String(line)
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isSeparator(line) {
  if (!String(line ?? "").includes("|")) return false;
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function looksLikeRow(line) {
  const trimmed = String(line ?? "").trim();
  return trimmed.includes("|") && splitRow(trimmed).length >= 2;
}

export function tableBullet(cells) {
  const [head, ...rest] = cells;
  if (!head) return "";
  if (!rest.length) return `- ${head}`;
  const tail = rest.filter(Boolean).join(" · ");
  return tail ? `- **${head}**：${tail}` : `- **${head}**`;
}

export function flattenTables(text) {
  const lines = String(text ?? "").split("\n");
  const out = [];
  let fenced = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (FENCE.test(line)) {
      fenced = !fenced;
      out.push(line);
      continue;
    }
    if (fenced || !looksLikeRow(line) || !isSeparator(lines[index + 1])) {
      out.push(line);
      continue;
    }
    index += 1;
    while (index + 1 < lines.length && looksLikeRow(lines[index + 1])) {
      index += 1;
      const cells = splitRow(lines[index]);
      if (cells.some(Boolean)) out.push(tableBullet(cells));
    }
  }
  return out.join("\n");
}
