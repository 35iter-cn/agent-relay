import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRegistry, registry } from "../src/notices/registry.mjs";
import { actionsText, createNoticeService, matchNotice, noticePromptValues, pruneNotices } from "../src/notices/service.mjs";
import { jobStallNotice } from "../src/notices/kinds/job-stall.mjs";
import { emptyState } from "../src/state/schema.mjs";
import { writeJsonAtomic } from "../src/shared/json.mjs";

const now = () => Date.parse("2026-10-26T12:00:00Z");
const iso = (ms) => new Date(ms).toISOString();

test("every shipped kind renders text and declares help for each action", () => {
  for (const kind of registry.all()) {
    assert.equal(typeof kind.render({ text: "x", session: "s", key: "k", local: "t", silenceMs: 0 }, { platform: "feishu" }), "string");
    for (const [name, spec] of Object.entries(kind.actions)) assert.equal(typeof spec.help, "string", `${kind.id}:${name}`);
  }
});

test("the registry refuses a kind without render and an unknown kind lookup", () => {
  assert.throws(() => createRegistry([{ id: "broken" }]), /needs render/);
  assert.throws(() => registry.get("nope"), /unknown notice kind/);
  assert.equal(registry.has("job-stall"), true);
});

test("job-stall renders the tool evidence and the reply hint", () => {
  const tool = jobStallNotice.render({
    key: "th-1",
    session: "fs-th-1",
    pid: 42,
    silenceMs: 11 * 60_000,
    local: "2026-10-26 20:00:00",
    reason: "tool",
    tool: { name: "bash", head: "bun test" },
  });
  assert.match(tool, /工具 bash 已运行 11 分钟没有返回/);
  assert.match(tool, /工具：bash · bun test/);
  assert.match(tool, /回复本消息/);
});

test("action help lines name the notice id and the platform", () => {
  const notice = { id: "ntc-7", platform: "feishu", refs: { key: "th-1" } };
  const text = actionsText(jobStallNotice, notice, { cli: "agent-relay" });
  assert.match(text, /agent-relay action feishu ntc-7 cancel/);
  assert.match(text, /agent-relay action feishu ntc-7 restart <补充要求>/);
});

test("prompt values expose the notice id, kind, actions and refs", () => {
  const notice = { id: "ntc-7", kind: "job-stall", platform: "feishu", refs: { key: "th-1", pid: 42 } };
  const values = noticePromptValues(notice, jobStallNotice);
  assert.equal(values.notice_id, "ntc-7");
  assert.equal(values.notice_kind, "job-stall");
  assert.match(values.notice_actions, /ntc-7 cancel/);
  assert.match(values.notice_refs, /th-1/);
});

test("a notice without actions says so instead of rendering an empty block", () => {
  const notice = { id: "ntc-9", platform: "feishu", refs: {} };
  assert.equal(actionsText(registry.get("boot"), notice), "");
  assert.match(noticePromptValues(notice, registry.get("boot")).notice_actions, /没有结构化动作/);
});

test("matchNotice resolves a reply id to the newest matching notice only", () => {
  const notices = {
    "ntc-1": { id: "ntc-1", platform: "feishu", messageId: "m-1", sentAt: iso(1) },
    "ntc-2": { id: "ntc-2", platform: "feishu", messageId: "m-1", sentAt: iso(2) },
    "ntc-3": { id: "ntc-3", platform: "slack", messageId: "m-1", sentAt: iso(3) },
    "ntc-4": { id: "ntc-4", platform: "feishu", messageId: null, sentAt: iso(4) },
  };
  assert.equal(matchNotice(notices, "feishu", ["m-1"]).id, "ntc-2");
  assert.equal(matchNotice(notices, "feishu", ["m-2"]), null);
  assert.equal(matchNotice(notices, "feishu", []), null);
  assert.equal(matchNotice(notices, "telegram", ["m-1"]), null);
});

test("pruneNotices drops expired and overflow entries", () => {
  const notices = {};
  for (let i = 1; i <= 5; i += 1) {
    notices[`ntc-${i}`] = { id: `ntc-${i}`, sentAt: iso(now() - (10 - i) * 1000) };
  }
  notices["ntc-old"] = { id: "ntc-old", sentAt: "2020-01-01T00:00:00Z" };
  const dropped = pruneNotices(notices, now(), 7 * 86_400_000, 3);
  assert.equal(dropped, 3);
  assert.deepEqual(Object.keys(notices).sort(), ["ntc-3", "ntc-4", "ntc-5"]);
});

test("emit posts through the platform, records the message id and survives a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-notices-"));
  const file = join(dir, "relay-fake.json");
  writeJsonAtomic(file, emptyState());
  const posted = [];
  const adapter = {
    name: "fake",
    postNotice: async (text) => {
      posted.push(text);
      return { messageId: "m-42" };
    },
  };
  const state = emptyState();
  const service = createNoticeService({ state, save: () => {}, adapter, now });
  const notice = await service.emit("job-stall", { key: "th-1", session: "fs-th-1", silenceMs: 600_000, local: "t" }, { refs: { key: "th-1" } });
  assert.equal(posted.length, 1);
  assert.equal(notice.id, "ntc-1");
  assert.equal(notice.messageId, "m-42");
  assert.deepEqual(notice.actions, ["cancel", "restart"]);
  assert.equal(state.notices["ntc-1"].refs.key, "th-1");
  assert.equal(service.match(["m-42"]).id, "ntc-1");

  writeJsonAtomic(file, state);
  const reloaded = JSON.parse(readFileSync(file, "utf8"));
  const restarted = createNoticeService({ state: reloaded, save: () => {}, adapter, now });
  assert.equal(restarted.match(["m-42"]).kind, "job-stall");
  assert.equal(restarted.list().length, 1);
});

test("emit fails loudly when the platform cannot post notices", async () => {
  const adapter = { name: "fake" };
  const service = createNoticeService({ state: emptyState(), save: () => {}, adapter, now });
  await assert.rejects(() => service.emit("boot", { text: "hi" }), /cannot post notices/);
});
