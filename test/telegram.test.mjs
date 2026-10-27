import test from "node:test";
import assert from "node:assert/strict";
import {
  stripMentions,
  sessionFor,
  topicKey,
  isGeneralTopic,
  nextOffset,
  escapeHtml,
  toTelegramHtml,
  pickTypingTarget,
  alertAllowed,
  pollUpdates,
} from "../src/platforms/telegram.mjs";

test("a topic is the conversation, the session follows from its id", () => {
  assert.equal(topicKey(21), "t21");
  assert.equal(sessionFor(topicKey(21)), "tg-t21");
  assert.equal(topicKey(0), null);
  assert.equal(topicKey(null), null);
});

test("only the general topic counts as general", () => {
  assert.equal(isGeneralTopic(undefined), true);
  assert.equal(isGeneralTopic(null), true);
  assert.equal(isGeneralTopic(1), true);
  assert.equal(isGeneralTopic("1"), true);
  assert.equal(isGeneralTopic(12), false);
  assert.equal(isGeneralTopic("12"), false);
});

test("a second message inside the same general cooldown stays silent", () => {
  const alerts = {};
  const started = 1_000_000;
  assert.equal(alertAllowed(alerts, "general", started), true);
  alerts.general = new Date(started).toISOString();
  assert.equal(alertAllowed(alerts, "general", started + 60_000), false);
  assert.equal(alertAllowed(alerts, "general", started + 31 * 60_000), true);
});

test("TC-14 fetch failures leave the cursor untouched", async () => {
  const before = 84_504_0000;
  await assert.rejects(
    pollUpdates({
      api: async () => {
        throw new Error("poll boom");
      },
      cursor: before,
      handle: async () => {},
      save: () => assert.fail("cursor must not advance when the fetch fails"),
    }),
    /poll boom/,
  );
});

test("TC-14 a successful round advances the cursor to the highest update id", async () => {
  const saved = [];
  const handled = [];
  const result = await pollUpdates({
    api: async (method, params) => {
      assert.deepEqual(params.allowed_updates, ["message"]);
      return [{ update_id: 5, message: { message_id: 1 } }, { update_id: 9, message: { message_id: 2 } }];
    },
    cursor: 5,
    handle: async (payload) => handled.push(payload.message_id),
    save: (cursor) => saved.push(cursor),
  });
  assert.equal(result.cursor, 10);
  assert.equal(result.count, 2);
  assert.deepEqual(handled, [1, 2]);
  assert.deepEqual(saved, [6, 10]);
});

test("TC-14 an empty round keeps the cursor where it was", async () => {
  const result = await pollUpdates({ api: async () => [], cursor: 42, handle: async () => {}, save: () => {} });
  assert.equal(result.cursor, 42);
});

test("nextOffset returns null for an empty update list", () => {
  assert.equal(nextOffset([]), null);
  assert.equal(nextOffset(undefined), null);
  assert.equal(nextOffset([{ update_id: 3 }]), 4);
});

test("stop words terminate only the exact match", () => {
});

test("telegram html conversion escapes and formats", () => {
  assert.equal(escapeHtml("a<b>&c"), "a&lt;b&gt;&amp;c");
  assert.equal(toTelegramHtml("**粗体** 和 `code`"), "<b>粗体</b> 和 <code>code</code>");
  assert.equal(toTelegramHtml("```\nconst a = 1 < 2;\n```"), "<pre>const a = 1 &lt; 2;</pre>");
  assert.equal(toTelegramHtml("a*b*c **x**"), "a*b*c <b>x</b>");
});

test("typing targets rotate across concurrent conversations", () => {
  assert.equal(pickTypingTarget([], 0), null);
  assert.equal(pickTypingTarget(["a", "b"], 1), "b");
  assert.equal(pickTypingTarget(["a", "b"], 2), "a");
});

test("alerts are rate limited by cooldown", () => {
  assert.equal(alertAllowed({}, "poll", 1_000_000), true);
  assert.equal(alertAllowed({ poll: new Date(1_000_000).toISOString() }, "poll", 1_060_000), false);
  assert.equal(alertAllowed({ poll: new Date(1_000_000).toISOString() }, "poll", 1_000_000 + 31 * 60_000), true);
});

test("mentions are stripped by entity offsets, never by scanning @", () => {
  assert.equal(
    stripMentions("@hao_dev 看下这个 hao@example.com", [{ type: "mention", offset: 0, length: 8 }]),
    "看下这个 hao@example.com",
  );
  assert.equal(stripMentions("邮箱 hao@example.com", []), "邮箱 hao@example.com");
  assert.equal(
    stripMentions("看 https://x.com/@someone/status", []),
    "看 https://x.com/@someone/status",
  );
  assert.equal(
    stripMentions("@a @b 好", [
      { type: "mention", offset: 0, length: 2 },
      { type: "mention", offset: 3, length: 2 },
    ]),
    "好",
  );
  assert.equal(
    stripMentions("🚀 @Hao 你好", [{ type: "text_mention", offset: 3, length: 4 }]),
    "🚀 你好",
  );
  assert.equal(stripMentions("@_user_1 无 entities", []), "@_user_1 无 entities");
});
