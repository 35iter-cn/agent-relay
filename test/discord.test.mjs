import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMediaUploader,
  createPlatform,
  mediaBatches,
  mediaFailureKind,
  mediaFormData,
  mediaPayload,
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
  typingTargets,
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

const MIB = 1_024 * 1_024;
const mediaFile = (size, name = "shot.png") => ({ path: `/tmp/${name}`, name, mime: "image/png", size });

function shotFile(bytes = "png-bytes", name = "shot.png") {
  const dir = mkdtempSync(join(tmpdir(), "relay-discord-media-"));
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return { path, name, mime: "image/png", size: bytes.length };
}

function mediaRig({ fetchFn, remember = () => {}, unarchive = null, reply = async () => {}, token = "bot-TEST" } = {}) {
  const replies = [];
  const postMedia = createMediaUploader({
    token,
    channelId: "500",
    log: () => {},
    fetchFn,
    remember,
    unarchive,
    reply: async (ctx, text) => {
      replies.push(text);
      await reply(ctx, text);
    },
  });
  return { postMedia, replies };
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("TC-DC13 images are batched by cumulative size, never above the 20 MiB ceiling", () => {
  const six = 6 * MIB;
  assert.deepEqual(mediaBatches([mediaFile(six), mediaFile(six), mediaFile(six), mediaFile(six)]).map((batch) => batch.length), [3, 1]);
  assert.deepEqual(mediaBatches([mediaFile(10 * MIB), mediaFile(10 * MIB)]).map((batch) => batch.length), [2]);
  assert.deepEqual(mediaBatches([mediaFile(1_024), mediaFile(1_024), mediaFile(1_024), mediaFile(1_024)]).map((batch) => batch.length), [4]);
  assert.deepEqual(mediaBatches([mediaFile(20 * MIB)]).map((batch) => batch.length), [1]);
  assert.deepEqual(mediaBatches([]), []);
});

test("TC-DC14 a media payload only carries the message reference outside a thread", () => {
  assert.deepEqual(mediaPayload(null, null), { allowed_mentions: { parse: [] } });
  assert.deepEqual(mediaPayload(null, "900"), {
    allowed_mentions: { parse: [] },
    message_reference: { message_id: "900", fail_if_not_exists: false },
  });
  assert.equal(mediaPayload("caption", null).content, "caption");
});

test("TC-DC15 the multipart form carries payload_json plus one files[n] part per image", () => {
  class FakeBlob {
    constructor(parts, options) {
      this.parts = parts;
      this.type = options?.type;
    }
  }
  class FakeFormData {
    constructor() {
      this.entries = [];
    }
    append(key, value, name) {
      this.entries.push({ key, value, name });
    }
  }
  const form = mediaFormData(
    [mediaFile(10, "a.png"), { ...mediaFile(20, "b.jpg"), mime: "image/jpeg" }],
    { allowed_mentions: { parse: [] } },
    { FormDataCtor: FakeFormData, BlobCtor: FakeBlob, readFile: (path) => `bytes:${path}` },
  );

  assert.equal(form.entries[0].key, "payload_json");
  assert.equal(JSON.parse(form.entries[0].value).allowed_mentions.parse.length, 0);
  assert.equal(form.entries[1].key, "files[0]");
  assert.equal(form.entries[1].name, "a.png");
  assert.equal(form.entries[1].value.type, "image/png");
  assert.deepEqual(form.entries[1].value.parts, ["bytes:/tmp/a.png"]);
  assert.equal(form.entries[2].key, "files[1]");
  assert.equal(form.entries[2].value.type, "image/jpeg");

  const unnamed = mediaFormData([{ path: "/tmp/x.png", mime: "image/png" }], mediaPayload(null, null), {
    FormDataCtor: FakeFormData,
    BlobCtor: FakeBlob,
    readFile: () => "b",
  });
  assert.equal(unnamed.entries[1].name, "image-0");
});

test("TC-DC16 only permission and size rejections downgrade, everything else is a retryable failure", () => {
  assert.equal(mediaFailureKind({ status: 403 }), "permission");
  assert.equal(mediaFailureKind({ code: 50013 }), "permission");
  assert.equal(mediaFailureKind({ status: 413 }), "size");
  assert.equal(mediaFailureKind({ code: 40005 }), "size");
  assert.equal(mediaFailureKind({ code: 50045 }), "size");
  assert.equal(mediaFailureKind({ code: 10003, status: 404 }), null);
  assert.equal(mediaFailureKind(null), null);
});

test("TC-DC17 a missing Attach Files permission degrades into one text note instead of throwing", async () => {
  const { postMedia, replies } = mediaRig({ fetchFn: async () => json(403, { message: "Missing Permissions", code: 50013 }) });
  const result = await postMedia({ threadId: "901", key: "t901" }, [shotFile(), shotFile("two", "b.png")]);

  assert.equal(result.degraded, true);
  assert.deepEqual(replies, ["（2 张图片未能上传：Discord 授权缺少 Attach Files）"]);
});

test("TC-DC18 an archived thread is unarchived once and retried, a server error is not", async () => {
  let calls = 0;
  const unarchived = [];
  const { postMedia, replies } = mediaRig({
    fetchFn: async (url) => {
      if (url.endsWith("/channels/901")) return json(200, { archived: false });
      calls += 1;
      if (calls === 1) return json(400, { message: "Thread is archived", code: 50083 });
      return json(200, { id: "1001" });
    },
    unarchive: async (channel) => {
      unarchived.push(channel);
    },
  });
  const result = await postMedia({ threadId: "901", key: "t901" }, [shotFile()]);

  assert.deepEqual(unarchived, ["901"]);
  assert.equal(result.degraded, false);
  assert.deepEqual(replies, []);

  const broken = mediaRig({ fetchFn: async () => json(500, { message: "boom" }) });
  await assert.rejects(() => broken.postMedia({ threadId: "901" }, [shotFile()]), /500 boom/);
  assert.deepEqual(broken.replies, []);
});

test("TC-DC19 images land where reply does and are indexed so answering them continues the conversation", async () => {
  const posts = [];
  const remembered = [];
  const fetchFn = async (url, init) => {
    posts.push({ url, init });
    return json(200, { id: `m${posts.length}` });
  };

  const inThread = mediaRig({
    fetchFn,
    remember: (messageId, key) => remembered.push([messageId, key]),
  });
  await inThread.postMedia({ threadId: "901", key: "t901", replyTo: "700" }, [shotFile()]);
  assert.equal(posts[0].url, "https://discord.com/api/v10/channels/901/messages");
  assert.equal(posts[0].init.headers.Authorization, "Bot bot-TEST");
  assert.equal(JSON.parse(posts[0].init.body.get("payload_json")).message_reference, undefined);
  assert.deepEqual(remembered, [["m1", "t901"]]);

  const inChannel = mediaRig({ fetchFn });
  await inChannel.postMedia({ replyTo: "700", key: "g700" }, [shotFile()]);
  assert.equal(posts[1].url, "https://discord.com/api/v10/channels/500/messages");
  assert.deepEqual(JSON.parse(posts[1].init.body.get("payload_json")).message_reference, { message_id: "700", fail_if_not_exists: false });
});

test("TC-DC11 clearing the dispatch window keeps a running job's typing alive", () => {
  const keys = new Set();
  const jobs = new Set();
  const channel = "901";
  keys.add(channel);
  jobs.add(channel);
  keys.delete(channel);
  assert.deepEqual(typingTargets(keys, jobs), [channel]);
  jobs.delete(channel);
  assert.deepEqual(typingTargets(keys, jobs), []);
});
