#!/usr/bin/env bun
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../src/shared/json.mjs";
import { upgradeState } from "../src/state/schema.mjs";

const HOME = process.env.HOME;
const SOURCE = process.env.AGENT_RELAY_LEGACY_DIR ?? join(HOME, ".config/taskradar");
const TARGET = process.env.AGENT_RELAY_CONFIG_DIR ?? join(HOME, ".config/agent-relay");
const ENV_FILES = ["feishu.env", "slack-app.env", "telegram.env", "webhook.url", ".slack-xoxc.tmp"];
const PLATFORMS = ["feishu", "slack", "telegram"];

export const INFLIGHT = new Set(["running", "queued", "answered"]);

export function dropInflight(state) {
  let dropped = 0;
  for (const [id, job] of Object.entries(state.jobs ?? {})) {
    if (!INFLIGHT.has(job?.status)) continue;
    delete state.jobs[id];
    dropped += 1;
  }
  state.inbox = (state.inbox ?? []).filter((id) => state.jobs[id]);
  for (const [dedupeId, value] of Object.entries(state.seen ?? {})) {
    if (value !== "legacy" && !state.jobs[value]) state.seen[dedupeId] = "legacy";
  }
  for (const entry of Object.values(state.convs ?? {})) {
    if (entry?.activeJob && !state.jobs[entry.activeJob]) entry.activeJob = null;
  }
  return dropped;
}

function main(argv) {
  const dryRun = argv.includes("--dry-run");
  const force = argv.includes("--force");
  const dropInflightJobs = argv.includes("--drop-inflight");
  mkdirSync(TARGET, { recursive: true, mode: 0o700 });
  chmodSync(TARGET, 0o700);
  const done = [];

  for (const name of ENV_FILES) {
    const from = join(SOURCE, name);
    const to = join(TARGET, name);
    if (!existsSync(from)) continue;
    if (existsSync(to) && !force) {
      done.push(`skip ${name} (exists)`);
      continue;
    }
    if (!dryRun) {
      copyFileSync(from, to);
      chmodSync(to, 0o600);
    }
    done.push(`copy ${name} (0600)`);
  }

  for (const platform of PLATFORMS) {
    const from = join(SOURCE, `relay-${platform}.json`);
    const to = join(TARGET, `relay-${platform}.json`);
    if (!existsSync(from)) continue;
    if (existsSync(to) && !force) {
      done.push(`skip relay-${platform}.json (exists)`);
      continue;
    }
    const state = upgradeState(JSON.parse(readFileSync(from, "utf8")));
    const dropped = dropInflightJobs ? dropInflight(state) : 0;
    if (!dryRun) writeJsonAtomic(to, state);
    done.push(`upgrade relay-${platform}.json (schema v${state.meta.schemaVersion}, jobs=${Object.keys(state.jobs).length}${dropped ? `, dropped ${dropped} in-flight` : ""})`);
  }

  const promptsSource = join(SOURCE, "prompts");
  if (existsSync(promptsSource)) {
    const promptsTarget = join(TARGET, "prompts");
    if (!dryRun) mkdirSync(promptsTarget, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(promptsSource)) {
      if (!name.endsWith(".md")) continue;
      const to = join(promptsTarget, name);
      if (existsSync(to) && !force) {
        done.push(`skip prompts/${name} (exists)`);
        continue;
      }
      if (!dryRun) {
        copyFileSync(join(promptsSource, name), to);
        chmodSync(to, 0o600);
      }
      done.push(`copy prompts/${name}`);
    }
  }

  const uploads = join(SOURCE, "uploads");
  if (existsSync(uploads) && statSync(uploads).isDirectory()) {
    if (!dryRun && !existsSync(join(TARGET, "uploads"))) {
      mkdirSync(join(TARGET, "uploads"), { recursive: true });
    }
    done.push("uploads/ left in place; copy manually if you need old attachments");
  }

  process.stdout.write(`${dryRun ? "[dry-run] " : ""}${SOURCE} -> ${TARGET}\n${done.map((line) => `- ${line}`).join("\n") || "- nothing to migrate"}\n`);
}

main(process.argv.slice(2));
