#!/usr/bin/env bun
// One-shot migration: three env files -> one config.json, old files kept under retired/.
// Idempotent: a config.json that already exists is left alone and nothing is moved.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { readEnvFile } from "../src/config.mjs";
import { writeJsonAtomic } from "../src/shared/json.mjs";
import { ensurePrivateDir } from "../src/shared/fs.mjs";

export const LEGACY_FILES = ["slack-app.env", "feishu.env", ".slack-xoxc.tmp"];
export const DEFAULT_GROUPS = ["system"];

function cookiesFrom(text) {
  const lines = String(text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) return null;
  return { xoxc: lines[0], xoxd: lines[1] };
}

export function buildConfig({ slackEnv = {}, feishuEnv = {}, cookies = null, groups = {} } = {}) {
  const config = {};
  if (slackEnv.SLACK_APP_TOKEN || slackEnv.SLACK_BOT_TOKEN || slackEnv.AGENT_RELAY_SLACK_CHANNEL) {
    const channels = { ...groups };
    if (slackEnv.AGENT_RELAY_SLACK_CHANNEL && !channels.system) channels.system = slackEnv.AGENT_RELAY_SLACK_CHANNEL;
    config.slack = {
      appToken: slackEnv.SLACK_APP_TOKEN ?? "",
      botToken: slackEnv.SLACK_BOT_TOKEN ?? "",
      allowedUser: slackEnv.SLACKD_ALLOWED_USER ?? slackEnv.AGENT_RELAY_ALLOWED_USER ?? "",
      botUser: slackEnv.SLACKD_BOT_USER ?? "",
      cookies: cookies ?? { xoxc: "", xoxd: "" },
      defaultGroup: "system",
      groups: channels,
    };
  }
  if (feishuEnv.FEISHU_APP_ID || feishuEnv.FEISHU_APP_SECRET || feishuEnv.FEISHU_CHAT_ID) {
    config.feishu = {
      appId: feishuEnv.FEISHU_APP_ID ?? "",
      appSecret: feishuEnv.FEISHU_APP_SECRET ?? "",
      chatId: feishuEnv.FEISHU_CHAT_ID ?? "",
      allowedUser: feishuEnv.AGENT_RELAY_ALLOWED_USER ?? "",
    };
  }
  return config;
}

export function planMigration({ configDir, groups = {}, force = false, exists = existsSync } = {}) {
  const target = join(configDir, "config.json");
  const present = LEGACY_FILES.filter((name) => exists(join(configDir, name)));
  if (exists(target) && !force) {
    return { write: false, reason: "config.json exists", target, present, retired: [] };
  }
  const slackEnv = readEnvFile(join(configDir, "slack-app.env"));
  const feishuEnv = readEnvFile(join(configDir, "feishu.env"));
  const cookieFile = join(configDir, ".slack-xoxc.tmp");
  const cookies = exists(cookieFile) ? cookiesFrom(readFileSync(cookieFile, "utf8")) : null;
  const config = buildConfig({ slackEnv, feishuEnv, cookies, groups });
  if (!Object.keys(config).length) {
    return { write: false, reason: "no legacy files to read", target, present, retired: [], config };
  }
  return { write: true, reason: "migrate", target, present, retired: present, config };
}

function stamp(now = new Date()) {
  return now.toISOString().replace(/[-:T]/g, "").slice(0, 12);
}

export function runMigration({ configDir, groups = {}, dryRun = false, force = false, now = new Date(), log = () => {} } = {}) {
  const plan = planMigration({ configDir, groups, force });
  if (!plan.write) {
    log(`${dryRun ? "[dry-run] " : ""}${plan.reason}: ${plan.target}`);
    return plan;
  }
  log(`${dryRun ? "[dry-run] " : ""}write ${plan.target} (0600)`);
  for (const [platform, section] of Object.entries(plan.config)) {
    log(`  ${platform}: ${Object.keys(section).join(", ")}`);
    if (section.groups) log(`  ${platform}.groups: ${Object.entries(section.groups).map(([name, id]) => `${name}=${id}`).join(" ")}`);
  }
  if (dryRun) return plan;
  ensurePrivateDir(configDir);
  writeJsonAtomic(plan.target, plan.config);
  chmodSync(plan.target, 0o600);
  const retiredDir = join(configDir, "retired", `config-${stamp(now)}`);
  if (plan.retired.length) {
    mkdirSync(retiredDir, { recursive: true, mode: 0o700 });
    for (const name of plan.retired) {
      renameSync(join(configDir, name), join(retiredDir, name));
      log(`  retired/${name}`);
    }
  }
  return plan;
}

function parseGroups(args) {
  const groups = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--group") continue;
    const pair = String(args[index + 1] ?? "");
    const [name, channel] = pair.split("=");
    if (name && channel) groups[name] = channel;
  }
  return groups;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const configDir = process.env.AGENT_RELAY_CONFIG_DIR ?? join(process.env.HOME, ".config/agent-relay");
  runMigration({
    configDir,
    groups: parseGroups(args),
    dryRun: args.includes("--dry-run"),
    force: args.includes("--force"),
    log: (line) => process.stdout.write(`${line}\n`),
  });
}
