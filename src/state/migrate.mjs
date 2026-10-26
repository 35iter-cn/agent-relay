#!/usr/bin/env bun
import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../shared/json.mjs";
import { emptyState } from "./schema.mjs";

const LEGACY = {
  feishu: { file: "feishud.json", migrate: migrateFeishu },
  slack: { file: "slackd.json", migrate: migrateSlack },
  telegram: { file: "tgd.json", migrate: migrateTelegram },
};

export function emptyRelayState() {
  return emptyState();
}

function seenMap(dedup) {
  if (Array.isArray(dedup)) return Object.fromEntries(dedup.filter(Boolean).map((ts) => [String(ts), true]));
  return dedup ?? {};
}

function migrateSlack(legacy) {
  return {
    cursor: null,
    seen: seenMap(legacy.dedup),
    convs: legacy.threads ?? {},
    alerts: legacy.alerts ?? {},
    meta: {},
  };
}

function migrateFeishu(legacy) {
  return {
    cursor: null,
    seen: legacy.seen ?? {},
    convs: legacy.convs ?? {},
    alerts: {},
    meta: {},
  };
}

function migrateTelegram(legacy) {
  return {
    cursor: legacy.offset ?? null,
    seen: {},
    convs: legacy.convs ?? {},
    alerts: legacy.alerts ?? {},
    meta: {
      alias: legacy.alias ?? {},
      channelPosts: legacy.channelPosts ?? {},
      lastConv: legacy.lastConv ?? null,
    },
  };
}

export function migrate({ platform, stateDir, dryRun = false }) {
  const entry = LEGACY[platform];
  if (!entry) throw new Error(`unknown platform: ${platform}`);
  const source = join(stateDir, entry.file);
  const target = join(stateDir, `relay-${platform}.json`);

  if (existsSync(target)) {
    return { target, source, migrated: false, reason: "target-exists" };
  }
  if (!existsSync(source)) {
    const payload = emptyRelayState();
    if (!dryRun) writeJsonAtomic(target, payload);
    return { target, source, migrated: false, reason: "no-legacy", payload };
  }

  let legacy;
  try {
    legacy = JSON.parse(readFileSync(source, "utf8"));
  } catch (error) {
    throw new Error(`legacy state unreadable: ${source}: ${error.message}`);
  }

  const payload = entry.migrate(legacy);
  if (dryRun) return { target, source, migrated: false, reason: "dry-run", payload };
  writeJsonAtomic(target, payload);
  renameSync(source, `${source}.migrated`);
  return { target, source, migrated: true, payload };
}

if (import.meta.main) {
  const platform = process.argv[2];
  const stateDir = process.env.TASKRADAR_CONFIG ?? join(process.env.HOME, ".config/taskradar");
  if (!platform) {
    process.stderr.write("usage: migrate-state.mjs <feishu|slack|telegram> [--dry-run]\n");
    process.exit(2);
  }
  const result = migrate({ platform, stateDir, dryRun: process.argv.includes("--dry-run") });
  process.stdout.write(`${JSON.stringify({ platform, ...result, payload: undefined })}\n`);
}
