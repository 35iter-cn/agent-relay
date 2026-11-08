export function renderHelp({ title, summary = [], verbs, sections = [], verb = "" }) {
  const wanted = String(verb ?? "");
  const entry = wanted ? verbs.find((item) => item.verb === wanted) : null;
  if (wanted && !entry) return null;
  if (entry) {
    const lines = [title, "", `usage: ${entry.usage}`];
    if (entry.detail?.length) lines.push("", ...entry.detail);
    if (entry.example) lines.push("", "example:", `  ${entry.example}`);
    return `${lines.join("\n")}\n`;
  }
  const lines = [title, ""];
  if (summary.length) lines.push(...summary, "");
  lines.push("usage:");
  for (const item of verbs) lines.push(`  ${item.usage}`);
  for (const section of sections) {
    lines.push("", `${section.heading}:`);
    for (const line of section.lines) lines.push(`  ${line}`);
  }
  return `${lines.join("\n")}\n`;
}
