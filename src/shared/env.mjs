const PREFIXES = ["AGENT_RELAY_", "RELAY_"];

export function readRelayEnv(name, env = process.env) {
  for (const prefix of PREFIXES) {
    const value = env[`${prefix}${name}`];
    if (value !== undefined) return value;
  }
  return undefined;
}

export function relayEnv(name, fallback, env = process.env) {
  const value = readRelayEnv(name, env);
  if (value === undefined) return fallback;
  if (typeof fallback === "number") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return value;
}
