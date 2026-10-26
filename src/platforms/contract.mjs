export const PLATFORMS = ["feishu", "slack", "telegram"];

const REQUIRED = { name: "string", start: "function", reply: "function", sessionFor: "function" };
const OPTIONAL = ["postNotice", "notify", "edit", "onProgress", "onProgressDone", "buildWorker"];

export function definePlatform(platform) {
  const missing = [];
  for (const [field, type] of Object.entries(REQUIRED)) {
    if (typeof platform?.[field] !== type) missing.push(`${field}:${type}`);
  }
  for (const field of OPTIONAL) {
    if (platform?.[field] !== undefined && typeof platform[field] !== "function") missing.push(`${field}:function`);
  }
  if (missing.length) throw new Error(`platform contract violated: ${missing.join(", ")}`);
  if (!PLATFORMS.includes(platform.name)) throw new Error(`unknown platform: ${platform.name}`);
  return platform;
}

export function isPlatform(name) {
  return PLATFORMS.includes(name);
}
