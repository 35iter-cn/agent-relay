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

export function splitTables(text) {
  const lines = String(text ?? "").split("\n");
  const segments = [];
  let buffer = [];
  let fenced = false;
  const flush = () => {
    const body = buffer.join("\n").trim();
    if (body) segments.push({ type: "text", text: body });
    buffer = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (FENCE.test(line)) {
      fenced = !fenced;
      buffer.push(line);
      continue;
    }
    if (fenced || !looksLikeRow(line) || !isSeparator(lines[index + 1])) {
      buffer.push(line);
      continue;
    }
    flush();
    const rows = [splitRow(line)];
    index += 1;
    while (index + 1 < lines.length && looksLikeRow(lines[index + 1])) {
      index += 1;
      rows.push(splitRow(lines[index]));
    }
    segments.push({ type: "table", rows });
  }
  flush();
  return segments;
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

const BARE_URL = /(^|[^(\]`])https?:\/\/[^\s<>`"'[\]]+/g;
const URL_TAIL = /[.,;:!?\]]+$/;
const CODE_SPAN = /(`+[^`]*`+)/g;

function splitTail(url) {
  let end = url.length;
  while (end > 0 && URL_TAIL.test(url[end - 1])) end -= 1;
  let depth = 0;
  for (let index = 0; index < end; index += 1) {
    if (url[index] === "(") depth += 1;
    else if (url[index] === ")") depth -= 1;
  }
  while (end > 0 && depth < 0 && url[end - 1] === ")") {
    end -= 1;
    depth += 1;
  }
  return [url.slice(0, end), url.slice(end)];
}

function linkSegment(text) {
  return text.replace(BARE_URL, (match, lead) => {
    const [url, tail] = splitTail(match.slice(lead.length));
    if (!url) return match;
    return `${lead}[${url}](${url})${tail}`;
  });
}

function linkBareUrls(line) {
  return line
    .split(CODE_SPAN)
    .map((part, index) => (index % 2 === 1 ? part : linkSegment(part)))
    .join("");
}

export function normalizeSlackMarkdown(text) {
  const lines = String(text ?? "").split("\n");
  const out = [];
  let fenced = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (FENCE.test(line)) fenced = !fenced;
    const startsTable = !fenced && looksLikeRow(line) && isSeparator(lines[index + 1]);
    if (startsTable && out.length > 0 && out[out.length - 1].trim()) out.push("");
    out.push(fenced ? line : linkBareUrls(line));
  }
  return out.join("\n");
}
