import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createNoticeService, matchNotice, MAX_PROMPT_BYTES, normalizeReply, truncatePrompt } from "../src/notices/service.mjs";
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

test("TC-NT3 a conversation binding keeps no text or prompt, a prompt notice keeps both", async () => {
  const state = emptyState();
  const posted = [];
  const service = createNoticeService({
    state,
    save: () => {},
    adapter: { name: "fake", postNotice: async (text) => (posted.push(text), { messageId: `m-${posted.length}` }) },
    now: () => now(),
  });
  const bound = await service.emit({ text: "本轮检查完成", reply: { mode: "conversation", key: "loop-fake-1-r3" } });
  assert.equal(posted[0], "本轮检查完成");
  assert.equal(bound.messageId, "m-1");
  assert.deepEqual(bound.reply, { mode: "conversation", key: "loop-fake-1-r3" });
  assert.equal(bound.text, undefined);
  assert.equal(bound.prompt, undefined);
  const plain = await service.emit({ text: "⏸ 卡住了", prompt: "看情况", reply: { mode: "prompt" } });
  assert.equal(plain.text, "⏸ 卡住了");
  assert.equal(plain.prompt, "看情况");
  assert.equal(plain.reply, undefined);
  assert.equal(service.match(["m-1"]).id, bound.id);
  assert.equal(service.match(["m-2"]).id, plain.id);
  await assert.rejects(() => service.emit({ text: "  " }), /notice needs text/);
});

test("TC-NT4 a reply binding needs a mode and a key", () => {
  assert.deepEqual(normalizeReply({ mode: "conversation", key: "k" }), { mode: "conversation", key: "k" });
  assert.equal(normalizeReply({ mode: "conversation" }), null);
  assert.equal(normalizeReply({ mode: "conversation", key: "  " }), null);
  assert.deepEqual(normalizeReply({ mode: "prompt" }), { mode: "prompt" });
  assert.equal(normalizeReply({ mode: "nope" }), null);
  assert.equal(normalizeReply(undefined), null);
});

test("TC-NT5 notices are never pruned on their own", () => {
  assert.equal(typeof createNoticeService({ state: emptyState(), save: () => {}, adapter: { name: "fake", postNotice: async () => ({}) } }).prune, "undefined");
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
