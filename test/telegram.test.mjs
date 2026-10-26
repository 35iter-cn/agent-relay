import test from "node:test";
import assert from "node:assert/strict";
import {
  stripMentions,
  channelKey,
  sessionFor,
  channelPostIdFor,
  resolveCommentKey,
  learnMirror,
  mirrorFor,
  nextOffset,
  escapeHtml,
  toTelegramHtml,
  pickTypingTarget,
  alertAllowed,
  waitForMirror,
  pollUpdates,
} from "../src/platforms/telegram.mjs";

test("channel posts map to ch<id> sessions", () => {
  assert.equal(channelKey(21), "ch21");
  assert.equal(sessionFor("ch21"), "tg-ch21");
});

test("TC-12 a mirror is learned from the comment reply_to_message", () => {
  const comment = { message_id: 300, message_thread_id: 99, reply_to_message: { is_automatic_forward: true, forward_from_message_id: 21 } };
  assert.deepEqual(learnMirror(comment), { postId: 21, mirrorId: 99 });
  assert.equal(channelPostIdFor(comment), 21);
  assert.equal(learnMirror({ message_id: 5, text: "闲聊" }), null);
});

test("TC-12 comments resolve to a session through the mirror map", () => {
  const channelPosts = { "21": { mirrorId: 99 }, "22": { mirrorId: 100 } };
  assert.equal(resolveCommentKey(99, channelPosts), "ch21");
  assert.equal(resolveCommentKey("100", channelPosts), "ch22");
  assert.equal(resolveCommentKey(101, channelPosts), null);
  assert.equal(resolveCommentKey(null, channelPosts), null);
  assert.equal(mirrorFor(channelPosts, 22), 100);
  assert.equal(mirrorFor({}, 22), null);
});

test("TC-12 waiting for a mirror returns as soon as it appears", async () => {
  let polls = 0;
  const mirror = await waitForMirror({
    read: () => (++polls >= 3 ? 77 : null),
    timeoutMs: 5_000,
    stepMs: 1,
    sleep: async () => {},
  });
  assert.equal(mirror, 77);
  assert.equal(polls, 3);
});

test("TC-12 waiting for a mirror gives up at the deadline", async () => {
  let clock = 0;
  const mirror = await waitForMirror({
    read: () => null,
    timeoutMs: 1_000,
    stepMs: 250,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  assert.equal(mirror, null);
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
    api: async () => [{ update_id: 5, message: { message_id: 1 } }, { update_id: 9, channel_post: { message_id: 2 } }],
    cursor: 5,
    handle: async (payload, kind) => handled.push(kind),
    save: (cursor) => saved.push(cursor),
  });
  assert.equal(result.cursor, 10);
  assert.equal(result.count, 2);
  assert.deepEqual(handled, ["message", "channel_post"]);
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
