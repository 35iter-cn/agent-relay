import test from "node:test";
import assert from "node:assert/strict";
import { emptyState } from "../src/state/schema.mjs";
import { createJob } from "../src/jobs/model.mjs";
import { dropInflight } from "../scripts/migrate-config.mjs";

function stateWith() {
  const state = emptyState();
  const add = (key, status) => {
    const job = createJob(state, { key, session: `fs-${key}`, dedupeId: `d-${key}`, text: "x" });
    job.status = status;
    state.jobs[job.id] = job;
    state.seen[job.inbound.dedupeId] = job.id;
    return job;
  };
  const running = add("th-1", "running");
  const queued = add("th-2", "queued");
  const answered = add("th-3", "answered");
  const done = add("th-4", "done");
  add("th-5", "interrupted");
  state.inbox.push(queued.id);
  state.convs["th-1"] = { session: "fs-th-1", activeJob: running.id };
  return { state, running, queued, answered, done };
}

test("dropInflight removes running, queued and answered jobs and cleans pointers", () => {
  const { state, running, queued, answered, done } = stateWith();
  assert.equal(dropInflight(state), 3);
  assert.equal(state.jobs[running.id], undefined);
  assert.equal(state.jobs[queued.id], undefined);
  assert.equal(state.jobs[answered.id], undefined);
  assert.ok(state.jobs[done.id]);
  assert.equal(state.inbox.length, 0);
  assert.equal(state.seen["d-th-1"], "legacy");
  assert.equal(state.convs["th-1"].activeJob, null);
});

test("dropInflight keeps terminal statuses untouched", () => {
  const { state } = stateWith();
  dropInflight(state);
  const statuses = Object.values(state.jobs).map((job) => job.status).sort();
  assert.deepEqual(statuses, ["done", "interrupted"]);
});

import { join } from "node:path";
import { mkdtempSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildConfig, planMigration, runMigration } from "../scripts/migrate-json-config.mjs";

function legacyDir({ slack = true, config = false } = {}) {
  const dir = join(mkdtempSync(join(tmpdir(), "relay-migrate-")), "agent-relay");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (slack) {
    writeFileSync(join(dir, "slack-app.env"), [
      "SLACK_APP_TOKEN=xapp-1",
      "SLACK_BOT_TOKEN=xoxb-1",
      "AGENT_RELAY_ALLOWED_USER=U-1",
      "AGENT_RELAY_SLACK_CHANNEL=C-main",
      "SLACKD_BOT_USER=U-bot",
    ].join("\n"));
    writeFileSync(join(dir, ".slack-xoxc.tmp"), "xoxc-1\nxoxd-1\n");
    writeFileSync(join(dir, "feishu.env"), [
      "FEISHU_APP_ID=cli-1",
      "FEISHU_APP_SECRET=secret-1",
      "FEISHU_CHAT_ID=oc-1",
      "AGENT_RELAY_ALLOWED_USER=ou-1",
    ].join("\n"));
  }
  if (config) writeFileSync(join(dir, "config.json"), "{}");
  return dir;
}

test("TC-MC1 the three legacy files map into one config with three groups", () => {
  const config = buildConfig({
    slackEnv: { SLACK_APP_TOKEN: "xapp-1", SLACK_BOT_TOKEN: "xoxb-1", SLACKD_ALLOWED_USER: "U-1", AGENT_RELAY_SLACK_CHANNEL: "C-system-legacy", SLACKD_BOT_USER: "U-bot" },
    feishuEnv: { FEISHU_APP_ID: "cli-1", FEISHU_APP_SECRET: "s", FEISHU_CHAT_ID: "oc-1", AGENT_RELAY_ALLOWED_USER: "ou-1" },
    cookies: { xoxc: "xoxc-1", xoxd: "xoxd-1" },
    groups: { loop: "C-loop", hours: "C-hours", system: "C-system" },
  });
  assert.deepEqual(config.slack.groups, { loop: "C-loop", hours: "C-hours", system: "C-system" });
  assert.equal(config.slack.defaultGroup, "system");
  assert.equal(config.slack.allowedUser, "U-1");
  assert.equal(config.slack.botUser, "U-bot");
  assert.deepEqual(config.slack.cookies, { xoxc: "xoxc-1", xoxd: "xoxd-1" });
  assert.equal(config.feishu.chatId, "oc-1");
  assert.equal(config.feishu.allowedUser, "ou-1");
});

test("TC-MC3 the legacy conversation channel fills an empty system group", () => {
  const config = buildConfig({
    slackEnv: { SLACK_APP_TOKEN: "xapp-1", SLACK_BOT_TOKEN: "xoxb-1", AGENT_RELAY_SLACK_CHANNEL: "C-legacy" },
  });
  assert.deepEqual(config.slack.groups, { system: "C-legacy" });
});

test("TC-MC2 an existing config.json is left alone, so a second run changes nothing", () => {
  const dir = legacyDir({ config: true });
  const plan = planMigration({ configDir: dir });
  assert.equal(plan.write, false);
  assert.equal(plan.reason, "config.json exists");
  const fresh = legacyDir();
  const first = runMigration({ configDir: fresh, groups: { loop: "C-loop" } });
  assert.equal(first.write, true);
  const second = runMigration({ configDir: fresh, groups: { loop: "C-loop" } });
  assert.equal(second.write, false);
  assert.equal(statSync(join(fresh, "config.json")).mode & 0o777, 0o600);
});

test("TC-MC3 the migration writes 0600 and retires the files it read", () => {
  const dir = legacyDir();
  runMigration({ configDir: dir, groups: { loop: "C-loop" } });
  const file = join(dir, "config.json");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const retired = readdirSync(join(dir, "retired"));
  assert.equal(retired.length, 1);
  const moved = readdirSync(join(dir, "retired", retired[0])).sort();
  assert.deepEqual(moved, [".slack-xoxc.tmp", "feishu.env", "slack-app.env"]);
  assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".env")), []);
});

test("TC-MC4 a dry run writes nothing", () => {
  const dir = legacyDir();
  const plan = runMigration({ configDir: dir, dryRun: true, groups: { loop: "C-loop" } });
  assert.equal(plan.write, true);
  assert.equal(readdirSync(dir).includes("config.json"), false);
  assert.equal(readdirSync(dir).includes("slack-app.env"), true);
});
