export function renderPrompt(template, values) {
  return Object.entries(values).reduce((acc, [key, value]) => acc.replaceAll(`{{${key}}}`, String(value ?? "")), template);
}
