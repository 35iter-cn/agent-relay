import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrate, emptyRelayState } from "../src/state/migrate.mjs";

function seed(files) {
  const dir = mkdtempSync(join(tmpdir(), "relay-migrate-"));
  for (const [name, value] of Object.entries(files)) writeFileSync(join(dir, name), typeof value === "string" ? value : JSON.stringify(value));
  return dir;
}

test("TC-13 slack legacy dedup array becomes a seen map", () => {
  const dir = seed({ "slackd.json": { dedup: ["1792558469.808939", "1792560605.074029"], threads: {} } });
  migrate({ platform: "slack", stateDir: dir });
  const state = JSON.parse(readFileSync(join(dir, "relay-slack.json"), "utf8"));
  assert.deepEqual(Object.keys(state.seen), ["1792558469.808939", "1792560605.074029"]);
  assert.equal(state.seen["1792558469.808939"], true);
});

test("TC-13 slack legacy state maps dedup and threads", () => {
  const dir = seed({ "slackd.json": { dedup: { e1: "t" }, threads: { "111.222": { session: "sl-111.222" } }, alerts: { stale: 1 } } });
  const result = migrate({ platform: "slack", stateDir: dir });
  assert.equal(result.migrated, true);
  const state = JSON.parse(readFileSync(join(dir, "relay-slack.json"), "utf8"));
  assert.deepEqual(state.seen, { e1: "t" });
  assert.deepEqual(state.convs, { "111.222": { session: "sl-111.222" } });
  assert.deepEqual(state.alerts, { stale: 1 });
  assert.equal(state.cursor, null);
  assert.equal(existsSync(join(dir, "slackd.json")), false);
  assert.equal(existsSync(join(dir, "slackd.json.migrated")), true);
});

test("TC-13 feishu legacy state keeps seen and convs", () => {
  const dir = seed({ "feishud.json": { convs: { "th-x": { session: "fs-th-x", rootText: "hi" } }, seen: { m1: "t" } } });
  const result = migrate({ platform: "feishu", stateDir: dir });
  assert.equal(result.migrated, true);
  const state = JSON.parse(readFileSync(join(dir, "relay-feishu.json"), "utf8"));
  assert.deepEqual(state.convs, { "th-x": { session: "fs-th-x", rootText: "hi" } });
  assert.deepEqual(state.seen, { m1: "t" });
});

test("TC-13 telegram legacy state carries offset, convs and mirror map", () => {
  const dir = seed({ "tgd.json": { offset: 845040408, alias: { a: 1 }, convs: { ch21: { session: "tg-ch21" } }, alerts: { poll: 2 }, lastConv: "ch21", channelPosts: { 21: 99 } } });
  const result = migrate({ platform: "telegram", stateDir: dir });
  assert.equal(result.migrated, true);
  const state = JSON.parse(readFileSync(join(dir, "relay-telegram.json"), "utf8"));
  assert.equal(state.cursor, 845040408);
  assert.deepEqual(state.convs, { ch21: { session: "tg-ch21" } });
  assert.deepEqual(state.meta.channelPosts, { 21: 99 });
  assert.equal(state.meta.lastConv, "ch21");
  assert.deepEqual(state.seen, {});
});

test("TC-13 migration is idempotent and never overwrites the target", () => {
  const dir = seed({ "tgd.json": { offset: 5, convs: {} } });
  migrate({ platform: "telegram", stateDir: dir });
  const first = readFileSync(join(dir, "relay-telegram.json"), "utf8");
  const second = migrate({ platform: "telegram", stateDir: dir });
  assert.equal(second.migrated, false);
  assert.equal(second.reason, "target-exists");
  assert.equal(readFileSync(join(dir, "relay-telegram.json"), "utf8"), first);
});

test("TC-13 corrupt legacy state throws and leaves the file untouched", () => {
  const dir = seed({ "feishud.json": "{not json" });
  assert.throws(() => migrate({ platform: "feishu", stateDir: dir }), /legacy state unreadable/);
  assert.equal(readFileSync(join(dir, "feishud.json"), "utf8"), "{not json");
  assert.equal(existsSync(join(dir, "relay-feishu.json")), false);
});

test("TC-13 a missing legacy file seeds an empty relay state", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-migrate-"));
  const result = migrate({ platform: "slack", stateDir: dir });
  assert.equal(result.reason, "no-legacy");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "relay-slack.json"), "utf8")), emptyRelayState());
});

test("TC-13 dry run inspects without writing", () => {
  const dir = seed({ "tgd.json": { offset: 7, convs: { ch1: {} } } });
  const result = migrate({ platform: "telegram", stateDir: dir, dryRun: true });
  assert.equal(result.reason, "dry-run");
  assert.equal(result.payload.cursor, 7);
  assert.equal(existsSync(join(dir, "relay-telegram.json")), false);
});

test("unknown platform is rejected", () => {
  assert.throws(() => migrate({ platform: "matrix", stateDir: tmpdir() }), /unknown platform/);
});
