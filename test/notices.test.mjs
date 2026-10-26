import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createNoticeService, matchNotice, MAX_PROMPT_BYTES, pruneNotices, truncatePrompt } from "../src/notices/service.mjs";
import { emptyState } from "../src/state/schema.mjs";
import { writeJsonAtomic } from "../src/shared/json.mjs";

const now = () => Date.parse("2026-10-26T12:00:00Z");
const iso = (ms) => new Date(ms).toISOString();

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
  for (let i = 1; i <= 5; i += 1) notices[`ntc-${i}`] = { id: `ntc-${i}`, sentAt: iso(now() - (10 - i) * 1000) };
  notices["ntc-old"] = { id: "ntc-old", sentAt: "2020-01-01T00:00:00Z" };
  assert.equal(pruneNotices(notices, now(), 7 * 86_400_000, 3), 3);
  assert.deepEqual(Object.keys(notices).sort(), ["ntc-3", "ntc-4", "ntc-5"]);
});

test("a prompt over the limit is cut without splitting a multi-byte character", () => {
  const long = "卡".repeat(MAX_PROMPT_BYTES);
  const cut = truncatePrompt(long);
  assert.equal(cut.truncated, true);
  assert.ok(Buffer.byteLength(cut.prompt) <= MAX_PROMPT_BYTES);
  assert.ok(cut.prompt.length > 0);
  assert.equal(truncatePrompt("short").truncated, false);
});

test("emit posts the text, keeps the prompt and survives a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-notices-"));
  const file = join(dir, "relay-fake.json");
  const state = emptyState();
  writeJsonAtomic(file, state);
  const posted = [];
  const adapter = {
    name: "fake",
    postNotice: async (text) => {
      posted.push(text);
      return { messageId: "m-42" };
    },
  };
  const service = createNoticeService({ state, save: () => {}, adapter, now });
  const notice = await service.emit({ text: "⏸ 卡住了", prompt: "杀掉或继续" });
  assert.deepEqual(posted, ["⏸ 卡住了"]);
  assert.equal(notice.id, "ntc-1");
  assert.equal(notice.messageId, "m-42");
  assert.equal(notice.prompt, "杀掉或继续");
  assert.deepEqual(Object.keys(notice).sort(), ["id", "messageId", "platform", "prompt", "sentAt", "text"]);
  assert.equal(service.match(["m-42"]).id, "ntc-1");

  writeJsonAtomic(file, state);
  const reloaded = JSON.parse(readFileSync(file, "utf8"));
  const restarted = createNoticeService({ state: reloaded, save: () => {}, adapter, now });
  assert.equal(restarted.match(["m-42"]).text, "⏸ 卡住了");
  assert.equal(restarted.list().length, 1);
});

test("emit without text is rejected and an over-long prompt is truncated and logged", async () => {
  const logs = [];
  const adapter = { name: "fake", postNotice: async () => ({ messageId: "m-1" }) };
  const service = createNoticeService({ state: emptyState(), save: () => {}, adapter, now, log: (level, ...parts) => logs.push([level, ...parts].join(" ")) });
  await assert.rejects(() => service.emit({ text: "   " }), /needs text/);
  const notice = await service.emit({ text: "x", prompt: "y".repeat(MAX_PROMPT_BYTES + 100) });
  assert.ok(Buffer.byteLength(notice.prompt) <= MAX_PROMPT_BYTES);
  assert.ok(logs.some((line) => line.includes("truncated")));
});

test("emit fails loudly when the platform cannot post notices", async () => {
  const service = createNoticeService({ state: emptyState(), save: () => {}, adapter: { name: "fake" }, now });
  await assert.rejects(() => service.emit({ text: "hi" }), /cannot post notices/);
});
