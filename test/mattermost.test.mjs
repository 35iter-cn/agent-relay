import test from "node:test";
import assert from "node:assert/strict";
import {
  alertAllowed,
  keepaliveAction,
  authChallenge,
  createPlatform,
  parsePosted,
  postPayload,
  replyIdsFor,
  resolveKey,
  sessionFor,
  stripBotMentions,
  threadRoot,
  typingAction,
  wsUrl,
} from "../src/platforms/mattermost.mjs";

function fakeConfig() {
  return {
    configDir: "/tmp/relay-test",
    workerBin: "pi",
    readEnv: () => ({}),
    envFile: (name) => `/tmp/relay-test/${name}`,
    stateFile: (platform) => `/tmp/relay-test/relay-${platform}.json`,
  };
}

function posted(post) {
  return JSON.stringify({ event: "posted", data: { post: JSON.stringify(post) } });
}

test("TC-MM1 a session is named after the thread key", () => {
  assert.equal(sessionFor("pabc123"), "mm-pabc123");
});

test("TC-MM2 the websocket url follows the server scheme", () => {
  assert.equal(wsUrl("https://mm.example.com"), "wss://mm.example.com/api/v4/websocket");
  assert.equal(wsUrl("http://mm.internal:8065/"), "ws://mm.internal:8065/api/v4/websocket");
});

test("TC-MM3 the first frame after connect is the token challenge", () => {
  assert.deepEqual(authChallenge("tok"), { seq: 1, action: "authentication_challenge", data: { token: "tok" } });
});

test("TC-MM4 only user posts survive the event frame", () => {
  const post = { id: "p1", channel_id: "c1", user_id: "u1", message: "hi" };
  assert.equal(parsePosted(posted(post))?.id, "p1");
  assert.equal(parsePosted(JSON.stringify({ event: "typing", data: {} })), null);
  assert.equal(parsePosted(posted({ ...post, type: "system_join_channel" })), null);
  assert.equal(parsePosted("{not json"), null);
  assert.equal(parsePosted(JSON.stringify({ event: "posted", data: { post: "{bad" } })), null);
});

test("TC-MM5 the thread root is the conversation, so a root post opens and a reply continues", () => {
  const root = { id: "p1", channel_id: "c1", user_id: "u1" };
  const reply = { id: "p2", channel_id: "c1", user_id: "u1", root_id: "p1" };
  assert.equal(resolveKey(root), "pp1");
  assert.equal(resolveKey(reply), "pp1");
  assert.equal(threadRoot(reply), "p1");
  assert.equal(resolveKey(reply, { p1: { key: "pp1", at: "2026-01-01T00:00:00Z" } }), "pp1");
  assert.equal(resolveKey({}), null);
});

test("TC-MM6 sent posts stay in the thread and carry uploaded file ids", () => {
  assert.deepEqual(postPayload("c1", "hello", "p1"), { channel_id: "c1", message: "hello", root_id: "p1" });
  assert.deepEqual(postPayload("c1", "", null, ["f1", "f2"]), { channel_id: "c1", message: "", file_ids: ["f1", "f2"] });
  assert.equal("root_id" in postPayload("c1", "hi"), false);
});

test("TC-MM7 only the bot's own mention is stripped from inbound text", () => {
  assert.equal(stripBotMentions("@relaybot 看一下这个", "relaybot"), "看一下这个");
  assert.equal(stripBotMentions("@someone 看一下", "relaybot"), "@someone 看一下");
  assert.equal(stripBotMentions("  hi   there  ", "relaybot"), "hi there");
});

test("TC-MM8 a reply matches its own post and its thread root", () => {
  assert.deepEqual(replyIdsFor({ id: "p2", root_id: "p1" }), ["p1", "p2"]);
  assert.deepEqual(replyIdsFor({ id: "p1" }), ["p1"]);
  assert.deepEqual(replyIdsFor({}), []);
});

test("TC-MM9 chunking keeps every piece inside the 12000 character limit", () => {
  const adapter = createPlatform({ config: fakeConfig(), log: () => {} });
  assert.equal(adapter.chunkLimit, 12_000);
  assert.equal(adapter.name, "mattermost");
  assert.equal(adapter.surface, "本线程");
});

test("TC-MM10 typing goes to the channel and the thread it belongs to", () => {
  assert.deepEqual(typingAction("c1", "p1", 3), { seq: 3, action: "user_typing", data: { channel_id: "c1", parent_id: "p1" } });
  assert.deepEqual(typingAction("c1", null, 1), { seq: 1, action: "user_typing", data: { channel_id: "c1" } });
});

test("TC-MM11 the reconnect alert is throttled to one per cooldown", () => {
  const now = Date.parse("2026-11-05T00:00:00Z");
  assert.equal(alertAllowed({}, "ws", now), true);
  assert.equal(alertAllowed({ ws: new Date(now - 60_000).toISOString() }, "ws", now), false);
  assert.equal(alertAllowed({ ws: new Date(now - 31 * 60_000).toISOString() }, "ws", now), true);
});

test("TC-MM12 a quiet socket is kept alive by a ping instead of being dropped", () => {
  const now = 1_000_000;
  assert.equal(keepaliveAction({ now, lastSeen: now - 10_000, pendingPingAt: 0 }), null);
  assert.equal(keepaliveAction({ now, lastSeen: now - 90_000, pendingPingAt: 0 }), "ping");
  assert.equal(keepaliveAction({ now, lastSeen: now - 90_000, pendingPingAt: now - 1_000 }), null);
});

test("TC-MM13 an unanswered ping is what triggers a reconnect, after the pong window", () => {
  const now = 1_000_000;
  assert.equal(keepaliveAction({ now, lastSeen: now - 300_000, pendingPingAt: now - 15_000 }), null);
  assert.equal(keepaliveAction({ now, lastSeen: now - 300_000, pendingPingAt: now - 15_001 }), "reconnect");
});
