export function renderHelp({ title, verbs, sections = [], verb = "" }) {
  const wanted = String(verb ?? "");
  const entry = wanted ? verbs.find((item) => item.verb === wanted) : null;
  if (wanted && !entry) return null;
  const lines = [];
  if (entry) {
    lines.push(title, "", `usage: ${entry.usage}`);
    if (entry.detail?.length) lines.push("", ...entry.detail);
    if (entry.example) lines.push("", "example:", `  ${entry.example}`);
    return `${lines.join("\n")}\n`;
  }
  lines.push(title, "", "usage:");
  for (const item of verbs) lines.push(`  ${item.usage}`);
  for (const section of sections) {
    lines.push("", `${section.heading}:`);
    for (const line of section.lines) lines.push(`  ${line}`);
  }
  return `${lines.join("\n")}\n`;
}
