import test from "node:test";
import assert from "node:assert/strict";
import {
  createPlatform,
  sessionFor,
  threadKey,
  threadName,
  intents,
  identifyPayload,
  resumePayload,
  retryAfterMs,
  isArchivedError,
  stripBotMentions,
  routeMessage,
} from "../src/platforms/discord.mjs";

function fakeConfig() {
  return {
    configDir: "/tmp/relay-test",
    workerBin: "pi",
    readEnv: () => ({}),
    envFile: (name) => `/tmp/relay-test/${name}`,
    stateFile: (platform) => `/tmp/relay-test/relay-${platform}.json`,
  };
}

function message(overrides = {}) {
  return { id: "100", channel_id: "500", author: { id: "42", bot: false }, content: "做点什么", attachments: [], ...overrides };
}

test("TC-DC1 a thread carries the conversation, so its session follows the thread id", () => {
  assert.equal(threadKey("900"), "t900");
  assert.equal(threadKey(null), null);
  assert.equal(sessionFor(threadKey("900")), "dc-t900");
  assert.equal(sessionFor("g100"), "dc-g100");
});

test("TC-DC2 the thread name is the first line, markdown stripped, cut at 80 characters", () => {
  assert.equal(threadName("**修一下** typeless 退款\n第二行"), "修一下 typeless 退款");
  assert.equal(threadName("\n\n  `code` 起头 "), "code 起头");
  assert.equal(threadName(""), "新会话");
  assert.equal([...threadName("字".repeat(120))].length, 80);
});

test("TC-DC3 the identify intents include the privileged message content bit", () => {
  assert.equal(intents(), (1 << 0) | (1 << 9) | (1 << 15));
  assert.equal(intents() & (1 << 15), 1 << 15);
});

test("TC-DC4 identify and resume payloads carry what the gateway requires", () => {
  assert.deepEqual(identifyPayload("tok"), {
    token: "tok",
    intents: intents(),
    properties: { os: "linux", browser: "agent-relay", device: "agent-relay" },
  });
  assert.deepEqual(resumePayload("tok", "sess-1", 77), { token: "tok", session_id: "sess-1", seq: 77 });
  assert.deepEqual(resumePayload("tok", "sess-1", 0), { token: "tok", session_id: "sess-1", seq: 0 });
});

test("TC-DC5 a 429 wait comes from the body first, then the header, and is capped", () => {
  assert.equal(retryAfterMs("9", { retry_after: 0.75 }), 750);
  assert.equal(retryAfterMs("3", null), 3_000);
  assert.equal(retryAfterMs(null, null), 1_000);
  assert.equal(retryAfterMs("600", { retry_after: 120 }), 60_000);
});

test("TC-DC6 an archived-thread rejection is recognised by code or message", () => {
  assert.equal(isArchivedError({ code: 50083, message: "whatever" }), true);
  assert.equal(isArchivedError(new Error("400 Bad Request Archived thread")), true);
  assert.equal(isArchivedError({ code: 10003, message: "Unknown Channel" }), false);
  assert.equal(isArchivedError(null), false);
});

test("TC-DC7 only the bot's own mention is stripped, other mentions survive", () => {
  assert.equal(stripBotMentions("<@777> 修一下", "777"), "修一下");
  assert.equal(stripBotMentions("<@!777> 修一下", "777"), "修一下");
  assert.equal(stripBotMentions("<@888> 转给 <@777> 看", "777"), "<@888> 转给  看");
  assert.equal(stripBotMentions("无提", null), "无提");
});

test("TC-DC8 a plain message in the parent channel opens a thread, a reply continues it", () => {
  const ctx = { parentChannelId: "500", allowedUser: "42", botId: "777", threads: {}, msgKeys: {} };
  assert.deepEqual(routeMessage(message(), ctx), { ok: true, root: true, key: null, threadId: null, replyTo: null });
});

test("TC-DC9 a reply in the parent channel joins the conversation of the message it answers", () => {
  const ctx = { parentChannelId: "500", allowedUser: "42", botId: "777", threads: {}, msgKeys: { 900: { key: "t900" } } };
  const reply = message({ message_reference: { message_id: "900" } });
  assert.deepEqual(routeMessage(reply, ctx), { ok: true, root: false, key: "t900", threadId: null, replyTo: "900" });
  const orphan = message({ message_reference: { message_id: "1234" } });
  assert.equal(routeMessage(orphan, ctx).key, "g1234");
  assert.equal(routeMessage(orphan, ctx).root, false);
});

test("TC-DC10 a message inside a known thread continues that thread", () => {
  const ctx = { parentChannelId: "500", allowedUser: "42", botId: "777", threads: { 901: { key: "t901" } }, msgKeys: {} };
  const inside = message({ channel_id: "901" });
  assert.deepEqual(routeMessage(inside, ctx), { ok: true, root: false, key: "t901", threadId: "901", replyTo: null });
});

test("TC-DC11 strangers, other bots and foreign channels are ignored", () => {
  const ctx = { parentChannelId: "500", allowedUser: "42", botId: "777", threads: {}, msgKeys: {} };
  assert.equal(routeMessage(message({ author: { id: "9", bot: false } }), ctx).why, "author");
  assert.equal(routeMessage(message({ author: { id: "777", bot: true } }), ctx).why, "bot");
  assert.equal(routeMessage(message({ author: { id: "42", bot: true } }), ctx).why, "bot");
  assert.equal(routeMessage(message({ channel_id: "777" }), ctx).why, "channel");
  assert.equal(routeMessage(null, ctx).why, "empty");
  assert.equal(routeMessage(message(), { ...ctx, parentChannelId: null }).why, "unconfigured");
});

test("TC-DC12 the adapter advertises discord, a thread surface and the 2000 character limit", () => {
  const adapter = createPlatform({ config: fakeConfig(), log: () => {} });
  assert.equal(adapter.name, "discord");
  assert.equal(adapter.surface, "本线程");
  assert.equal(adapter.chunkLimit, 2_000);
  assert.equal(adapter.sessionFor("t900"), "dc-t900");
});
