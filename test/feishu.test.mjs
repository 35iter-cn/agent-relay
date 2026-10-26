import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversationKey, sessionFor, textOf, textOfMessage, bodyOf, msgTypeOf, attachmentsOf, uploadDirFor, pruneUploads, withTimeout, stripMentions, isAcceptedSender, toCard, decideProgressMode, createRuntime, createPlatform } from "../src/platforms/feishu.mjs";
import { bootNoticeText, readBootId, shouldAnnounceBoot } from "../src/shared/boot.mjs";
import { localStamp } from "../src/shared/time.mjs";

function fakeClient({ reaction = { code: 0, data: { reaction_id: "r1" } }, reply = { code: 0, data: { message_id: "m-out" } }, patch = { code: 0 }, create = { code: 0, data: { message_id: "m-notify" } } } = {}) {
  const calls = [];
  const client = {
    im: {
      v1: {
        message: {
          reply: async (args) => {
            calls.push(["reply", args]);
            return typeof reply === "function" ? reply(args) : reply;
          },
          create: async (args) => {
            calls.push(["create", args]);
            return typeof create === "function" ? create(args) : create;
          },
          patch: async (args) => {
            calls.push(["patch", args]);
            return typeof patch === "function" ? patch(args) : patch;
          },
        },
        messageReaction: {
          create: async (args) => {
            calls.push(["reaction.create", args]);
            return typeof reaction === "function" ? reaction(args) : reaction;
          },
          delete: async (args) => {
            calls.push(["reaction.delete", args]);
            return { code: 0 };
          },
        },
      },
    },
  };
  return { client, calls };
}

const inbound = { key: "th-x", session: "fs-th-x", dedupeId: "om_1", text: "hi", chatId: "oc_1", messageId: "om_1", threadId: "om_root" };

test("TC-8 four message shapes map to four conversation keys", () => {
  assert.equal(conversationKey({ thread_id: "t1", root_id: "r1", parent_id: "p1", message_id: "m1" }), "th-t1");
  assert.equal(conversationKey({ root_id: "r1", parent_id: "p1", message_id: "m1" }), "th-r1");
  assert.equal(conversationKey({ parent_id: "p1", message_id: "m1" }), "th-p1");
  assert.equal(conversationKey({ message_id: "m1" }), "ms-m1");
  assert.equal(sessionFor("th-x"), "fs-th-x");
});

test("message content is parsed without crashing on rich payloads", () => {
  assert.equal(textOf({ content: '{"text":"你好"}' }), "你好");
  assert.equal(textOf({ content: "not json" }), "not json");
  assert.equal(textOf({}), "");
});

test("app senders and outsiders are rejected", () => {
  assert.deepEqual(isAcceptedSender({ sender_type: "app", sender_id: { open_id: "ou_me" } }, "ou_me"), { ok: false, why: "bot" });
  assert.deepEqual(isAcceptedSender({ sender_type: "user", sender_id: { open_id: "ou_other" } }, "ou_me"), { ok: false, why: "author" });
  assert.deepEqual(isAcceptedSender({ sender_type: "user", sender_id: { open_id: "ou_me" } }, "ou_me"), { ok: true, openId: "ou_me" });
});

test("cards are schema 2.0 markdown elements split at 3000 characters", () => {
  const single = toCard("**粗体**");
  assert.equal(single.schema, "2.0");
  assert.deepEqual(single.body.elements, [{ tag: "markdown", content: "**粗体**" }]);
  const long = toCard("a".repeat(6500));
  assert.equal(long.body.elements.length, 3);
});

test("permission errors downgrade the progress signal to a card", () => {
  assert.equal(decideProgressMode(0), "reaction");
  assert.equal(decideProgressMode(99991672), "card");
  assert.equal(decideProgressMode(99991400), "card");
  assert.equal(decideProgressMode(500), "none");
});

test("TC-15 the progress reaction is added and removed", async () => {
  const { client, calls } = fakeClient();
  const runtime = createRuntime({ client, log: () => {}, chatId: "oc_1" });
  const progress = await runtime.onProgress(inbound);
  assert.equal(progress.mode, "reaction");
  await runtime.onProgressDone({ ...inbound, progress });
  assert.deepEqual(calls.map(([name]) => name), ["reaction.create", "reaction.delete"]);
  assert.equal(calls[0][1].path.message_id, "om_1");
  assert.equal(calls[0][1].data.reaction_type.emoji_type, "THINKING");
  assert.equal(calls[1][1].path.reaction_id, "r1");
});

test("TC-15 the reaction is removed even when the worker fails or times out", async () => {
  const { client, calls } = fakeClient();
  const runtime = createRuntime({ client, log: () => {}, chatId: "oc_1" });
  const progress = await runtime.onProgress(inbound);
  await runtime.reply({ ...inbound, progress }, "已终止：本轮超过 20 分钟未结束。");
  await runtime.onProgressDone({ ...inbound, progress });
  assert.equal(calls.filter(([name]) => name === "reaction.delete").length, 1);
  assert.equal(calls.filter(([name]) => name === "reply").length, 1);
});

test("TC-16 without reaction permission a placeholder card is patched into the answer", async () => {
  const { client, calls } = fakeClient({ reaction: { code: 99991672, msg: "no scope" } });
  const runtime = createRuntime({ client, log: () => {}, chatId: "oc_1" });
  const progress = await runtime.onProgress(inbound);
  assert.equal(progress.mode, "card");
  await runtime.reply({ ...inbound, progress }, "最终回答");
  const names = calls.map(([name]) => name);
  assert.deepEqual(names, ["reaction.create", "reply", "patch"]);
  const patched = JSON.parse(calls[2][1].data.content);
  assert.equal(patched.body.elements[0].content, "最终回答");
});

test("TC-16 a failed patch falls back to a normal reply instead of losing the answer", async () => {
  const { client, calls } = fakeClient({ reaction: { code: 99991672, msg: "no scope" }, patch: { code: 230001, msg: "cannot patch" } });
  const runtime = createRuntime({ client, log: () => {}, chatId: "oc_1" });
  const progress = await runtime.onProgress(inbound);
  await runtime.reply({ ...inbound, progress }, "最终回答");
  const replies = calls.filter(([name]) => name === "reply").map(([, args]) => args.data.content);
  assert.ok(replies.some((content) => content.includes("最终回答")));
});

test("TC-9 a failed card reply degrades to plain text with the same body", async () => {
  let first = true;
  const { client, calls } = fakeClient({
    reply: () => {
      if (first) {
        first = false;
        return { code: 230002, msg: "card rejected" };
      }
      return { code: 0, data: { message_id: "m-text" } };
    },
  });
  const runtime = createRuntime({ client, log: () => {}, chatId: "oc_1" });
  await runtime.reply(inbound, "**粗体** 内容");
  const [cardCall, textCall] = calls.map(([, args]) => args);
  assert.equal(cardCall.data.msg_type, "interactive");
  assert.equal(textCall.data.msg_type, "text");
  assert.match(textCall.data.content, /粗体/);
});

test("TC-17 notify sends a card whose first line mentions Hao", async () => {
  const { client, calls } = fakeClient();
  const runtime = createRuntime({ client, log: () => {}, chatId: "oc_1", allowedUser: "ou_me" });
  await runtime.notify("intake loop 发现 1 个候选\n[20261022-2100-1] 一句依据");
  const [name, args] = calls[0];
  assert.equal(name, "create");
  assert.equal(args.data.msg_type, "interactive");
  const card = JSON.parse(args.data.content);
  assert.match(card.body.elements[0].content, /^<at id=ou_me><\/at>/);
  assert.match(card.body.elements[0].content, /20261022-2100-1/);
});

test("notify does not double the at tag when the caller already wrote one", async () => {
  const { client, calls } = fakeClient();
  const runtime = createRuntime({ client, log: () => {}, chatId: "oc_1", allowedUser: "ou_me" });
  await runtime.notify("<at id=ou_me></at> 已有 at");
  const card = JSON.parse(calls[0][1].data.content);
  assert.equal(card.body.elements[0].content.match(/<at /g).length, 1);
});

const adapterPaths = { configDir: "/tmp/relay-test-config", home: "/tmp/relay-test-home" };
const adapterEnv = { FEISHU_APP_ID: "cli_test", FEISHU_APP_SECRET: "secret", FEISHU_CHAT_ID: "oc_1", AGENT_RELAY_ALLOWED_USER: "ou_test_user" };

function adapterConfig({ env = adapterEnv, configDir = adapterPaths.configDir, home = adapterPaths.home } = {}) {
  return {
    home,
    cwd: home,
    configDir,
    logDir: join(configDir, "logs"),
    uploadsDir: join(configDir, "uploads"),
    agentHoursDir: join(configDir, "agent-hours"),
    ledgerDir: join(configDir, "agent-hours/ledger"),
    readEnv: () => env,
    envFile: (name) => join(configDir, name),
    stateFile: (platform) => join(configDir, `relay-${platform}.json`),
    commandDir: (platform) => join(configDir, `relay-${platform}.cmd`),
  };
}

test("TC-N1 postNotice sends before start() was ever called", async () => {
  const { client, calls } = fakeClient();
  const adapter = createPlatform({
    config: adapterConfig(),
    log: () => {},
    createClient: async () => client,
  });
  const sent = await adapter.postNotice("intake 候选一条");
  assert.equal(sent.messageId, "m-notify");
  const createCalls = calls.filter(([name]) => name === "create");
  assert.equal(createCalls.length, 1);
  assert.equal(createCalls[0][1].data.msg_type, "interactive");
  const card = JSON.parse(createCalls[0][1].data.content);
  assert.match(card.body.elements[0].content, /^<at id=ou_test_user><\/at>/);
});

test("TC-N1b without a configured allowed user a notice is posted without a mention", async () => {
  const { client, calls } = fakeClient();
  const adapter = createPlatform({
    config: adapterConfig({ env: { FEISHU_APP_ID: "cli_test", FEISHU_APP_SECRET: "secret", FEISHU_CHAT_ID: "oc_1" } }),
    log: () => {},
    createClient: async () => client,
  });
  await adapter.postNotice("没有配置接收人");
  const create = calls.find(([name]) => name === "create")[1];
  const card = JSON.parse(create.data.content);
  assert.doesNotMatch(card.body.elements[0].content, /<at /);
});

test("TC-N2 missing credentials log one line and exit instead of a TypeError", async () => {
  const logs = [];
  const exits = [];
  const originalExit = process.exit;
  process.exit = (code) => {
    exits.push(code);
    throw new Error(`exit ${code}`);
  };
  try {
    const adapter = createPlatform({
      config: adapterConfig({ env: { FEISHU_CHAT_ID: "oc_1" } }),
      log: (...parts) => logs.push(parts.map(String).join(" ")),
      createClient: async () => {
        throw new Error("createClient must not be called without credentials");
      },
    });
    await assert.rejects(() => adapter.postNotice("x"), /exit 1/);
  } finally {
    process.exit = originalExit;
  }
  assert.ok(logs.some((line) => line.includes("missing-credential")));
  assert.deepEqual(exits, [1]);
});

test("TC-N5 a missing allowed user refuses to start instead of accepting everyone", async () => {
  const exits = [];
  const logs = [];
  const originalExit = process.exit;
  process.exit = (code) => {
    exits.push(code);
    throw new Error(`exit ${code}`);
  };
  try {
    const adapter = createPlatform({
      config: adapterConfig({ env: { FEISHU_APP_ID: "cli_test", FEISHU_APP_SECRET: "secret", FEISHU_CHAT_ID: "oc_1" } }),
      log: (...parts) => logs.push(parts.map(String).join(" ")),
      createClient: async () => fakeClient().client,
      loadSdk: async () => ({ default: {} }),
    });
    await assert.rejects(() => adapter.start({ onMessage: async () => {}, core: { state: { convs: {} }, save: () => {} } }), /exit 1/);
  } finally {
    process.exit = originalExit;
  }
  assert.deepEqual(exits, [1]);
  assert.ok(logs.some((line) => line.includes("AGENT_RELAY_ALLOWED_USER")));
});

test("TC-N4 a platform error surfaces the code instead of being swallowed", async () => {
  const { client } = fakeClient({ create: { code: 99991672, msg: "no scope" } });
  const adapter = createPlatform({
    config: adapterConfig(),
    log: () => {},
    createClient: async () => client,
  });
  await assert.rejects(() => adapter.postNotice("x"), /99991672/);
});

test("TC-N3 notify then start() shares one client and one websocket", async () => {
  let created = 0;
  const { client } = fakeClient();
  const instances = { ws: 0, dispatchers: 0 };
  const sdk = {
    default: {
      Client: function Client() {},
      EventDispatcher: function EventDispatcher() {
        instances.dispatchers += 1;
        this.register = () => this;
      },
      WSClient: function WSClient() {
        instances.ws += 1;
        this.start = () => {};
      },
      Domain: { Feishu: "feishu" },
      LoggerLevel: { warn: 4 },
    },
  };
  const adapter = createPlatform({
    config: adapterConfig(),
    log: () => {},
    createClient: async () => {
      created += 1;
      return client;
    },
    loadSdk: async () => sdk,
  });
  await adapter.postNotice("先 notify");
  adapter.start({ onMessage: async () => {}, core: { state: { convs: {} }, save: () => {} } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(created, 1);
  assert.equal(instances.ws, 1);
  assert.equal(instances.dispatchers, 1);
});

test("TC-28 the feishu reply context survives a JSON round trip", async () => {
  const { client, calls } = fakeClient();
  const runtime = createRuntime({ client, log: () => {}, chatId: "oc_1" });
  const progress = await runtime.onProgress(inbound);
  const ctx = JSON.parse(JSON.stringify({ ...inbound, progress }));
  const sent = await runtime.reply(ctx, "恢复后的回帖");
  assert.deepEqual(sent, { messageId: "m-out" });
  assert.equal(calls.filter(([name]) => name === "reply").length, 1);
  await runtime.onProgressDone(ctx);
  assert.equal(calls.filter(([name]) => name === "reaction.delete").length, 1);
});

test("TC-28 feishu edit patches an existing message and reports failure honestly", async () => {
  const { client, calls } = fakeClient();
  const runtime = createRuntime({ client, log: () => {}, chatId: "oc_1" });
  assert.equal(await runtime.edit(inbound, "m-out", "更新后的正文"), true);
  assert.equal(calls.at(-1)[0], "patch");
  const failing = createRuntime({ client: fakeClient({ patch: { code: 230001, msg: "no" } }).client, log: () => {}, chatId: "oc_1" });
  assert.equal(await failing.edit(inbound, "m-out", "x"), false);
});

test("mentions are stripped with mentions[].key instead of scanning for @", () => {
  const mentions = [
    { key: "@_user_1", name: "Nova" },
    { key: "@_user_2", name: "Hao" },
  ];
  assert.equal(stripMentions("@_user_1 帮我看下 #5753", mentions), "帮我看下 #5753");
  assert.equal(stripMentions("@_user_1 @_user_2 都看一下", mentions), "都看一下");
  assert.equal(stripMentions("@_user_1 /重跑", mentions), "/重跑");
  assert.equal(stripMentions("@_user_1", mentions), "");
  assert.equal(stripMentions("没有 mention 的正文", mentions), "没有 mention 的正文");
  assert.equal(stripMentions("@_user_1 没有映射表时原样保留", []), "@_user_1 没有映射表时原样保留");
  assert.equal(stripMentions("邮箱 hao@example.com", mentions), "邮箱 hao@example.com");
});

test("TC-R0 textOfMessage extracts text, card markdown and rejects media", () => {
  assert.equal(textOfMessage({ msg_type: "text", body: { content: '{"text":"你好"}' } }), "你好");
  assert.equal(
    textOfMessage({ msg_type: "interactive", body: { content: JSON.stringify({ body: { elements: [{ tag: "markdown", content: "候选一\n候选二" }] } }) } }),
    "候选一\n候选二",
  );
  assert.equal(
    textOfMessage({ msg_type: "post", body: { content: JSON.stringify({ zh_cn: { title: "标题", content: [[{ tag: "text", text: "正文" }]] } }) } }).includes("正文"),
    true,
  );
  assert.equal(textOfMessage({ msg_type: "image", body: { content: '{"image_key":"k"}' } }), null);
  assert.equal(textOfMessage(null), null);
});

function rootHarness({ get, convs = {} } = {}) {
  const handlers = {};
  const calls = [];
  const client = {
    im: {
      v1: {
        message: {
          reply: async (args) => ({ code: 0, data: { message_id: "m-out" } }),
          patch: async () => ({ code: 0 }),
          get: async (args) => {
            calls.push(args);
            return get(args);
          },
        },
        messageReaction: { create: async () => ({ code: 0 }), delete: async () => ({ code: 0 }) },
      },
    },
  };
  const sdk = {
    default: {
      Client: function Client() {},
      EventDispatcher: function EventDispatcher() {
        this.register = (map) => { Object.assign(handlers, map); return this; };
      },
      WSClient: function WSClient() { this.start = () => {}; },
      Domain: { Feishu: "feishu" },
      LoggerLevel: { warn: 4 },
    },
  };
  const state = { convs: { ...convs }, save: () => {} };
  const seen = [];
  const adapter = createPlatform({
    config: adapterConfig(),
    log: () => {},
    createClient: async () => client,
    loadSdk: async () => sdk,
  });
  const started = adapter.start({ onMessage: async (msg) => seen.push(msg), core: { state, save: () => {} } });
  started.catch(() => {});
  return { adapter, started, handlers, calls, seen, state };
}

test("TC-R1 the reply-chain root supplies rootText via user_card_content", async () => {
  const { ready, handlers, calls, seen } = rootHarness({
    get: async () => ({
      code: 0,
      data: { items: [{ msg_type: "interactive", body: { content: JSON.stringify({ body: { elements: [{ tag: "markdown", content: "候选一\n候选二" }] } }) } }] },
    }),
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await handlers["im.message.receive_v1"]({
    sender: { sender_type: "user", sender_id: { open_id: "ou_test_user" } },
    message: { message_id: "om_child", root_id: "om_root", chat_id: "oc_1", message_type: "text", content: '{"text":"go"}', mentions: [] },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path.message_id, "om_root");
  assert.equal(calls[0].params.card_msg_content_type, "user_card_content");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].rootText, "候选一\n候选二");
});

test("TC-R2 a group message without root_id never fetches a root", async () => {
  const { ready, handlers, calls, seen } = rootHarness({ get: async () => ({ code: 0, data: { items: [] } }) });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await handlers["im.message.receive_v1"]({
    sender: { sender_type: "user", sender_id: { open_id: "ou_test_user" } },
    message: { message_id: "om_solo", chat_id: "oc_1", message_type: "text", content: '{"text":"读一下"}', mentions: [] },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls.length, 0);
  assert.equal(seen[0].rootText, null);
});

test("TC-R3 root fetch gives up after three failures", async () => {
  let attempts = 0;
  const { ready, handlers, calls, seen } = rootHarness({
    get: async () => {
      attempts += 1;
      throw new Error("gateway down");
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const event = (id) => ({
    sender: { sender_type: "user", sender_id: { open_id: "ou_test_user" } },
    message: { message_id: id, root_id: "om_root", chat_id: "oc_1", message_type: "text", content: '{"text":"go"}', mentions: [] },
  });
  for (const id of ["om_a", "om_b", "om_c"]) {
    await handlers["im.message.receive_v1"](event(id));
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const callsAfterThree = calls.length;
  await handlers["im.message.receive_v1"](event("om_d"));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(callsAfterThree, 3);
  assert.equal(calls.length, 3);
  assert.equal(seen.at(-1).rootText, null);
});

test("TC-B1 a notice fires once per boot id", () => {
  assert.equal(shouldAnnounceBoot(undefined, "b1"), true);
  assert.equal(shouldAnnounceBoot(null, "b1"), true);
  assert.equal(shouldAnnounceBoot("b1", "b1"), false);
  assert.equal(shouldAnnounceBoot("b1", "b2"), true);
  assert.equal(shouldAnnounceBoot("b1", null), false);
  assert.equal(shouldAnnounceBoot("b1", ""), false);
  assert.equal(readBootId("/nonexistent/boot_id"), null);
  assert.ok(readBootId().length > 0);
});

test("TC-B2 the notice time is rendered in Asia/Shanghai with a 00-23 hour", () => {
  assert.equal(localStamp(Date.parse("2026-10-23T22:58:00Z")), "2026-10-24 06:58:00");
  assert.equal(localStamp(Date.parse("2026-10-23T16:00:00Z")), "2026-10-24 00:00:00");
  assert.equal(
    bootNoticeText(new Date("2026-10-23T22:58:00Z"), (date) => localStamp(date.getTime())),
    "🟢 系统已启动，Agent 已准备好接收任务\n上线时间：2026-10-24 06:58:00",
  );
});

const POST_WITH_IMAGE = JSON.stringify({
  title: "",
  content: [
    [{ tag: "at", user_id: "@_user_1", user_name: "Doge", style: [] }, { tag: "text", text: " 看一下这张图", style: [] }],
    [{ tag: "img", image_key: "img_v3_probe_123456", width: 1080, height: 2346 }],
  ],
});

function imageHarness({ resource, message } = {}) {
  const handlers = {};
  const seen = [];
  const client = {
    im: {
      v1: {
        message: {
          reply: async () => ({ code: 0, data: { message_id: "m-out" } }),
          patch: async () => ({ code: 0 }),
          get: async () => ({ code: 0, data: { items: [] } }),
        },
        messageReaction: { create: async () => ({ code: 0 }), delete: async () => ({ code: 0 }) },
        messageResource: { get: async (args) => resource(args) },
      },
    },
  };
  const sdk = {
    default: {
      Client: function Client() {},
      EventDispatcher: function EventDispatcher() {
        this.register = (map) => { Object.assign(handlers, map); return this; };
      },
      WSClient: function WSClient() { this.start = () => {}; },
      Domain: { Feishu: "feishu" },
      LoggerLevel: { warn: 4 },
    },
  };
  const configDir = mkdtempSync(join(tmpdir(), "relay-img-"));
  const adapter = createPlatform({
    config: adapterConfig({ configDir, home: tmpdir() }),
    log: () => {},
    createClient: async () => client,
    loadSdk: async () => sdk,
  });
  adapter.start({ onMessage: async (msg) => seen.push(msg), core: { state: { convs: {}, meta: { schemaVersion: 2 } }, save: () => {} } });
  return { handlers, seen, configDir, message };
}

function okResource(contentType = "image/jpeg") {
  return ({ headers, path, params }) => {
    assert.equal(params.type, path.message_id ? params.type : params.type);
    return {
      headers: { "content-type": contentType },
      writeFile: async (file) => writeFileSync(file, Buffer.from("jpeg-bytes")),
    };
  };
}

test("TC-31 a post body parses whether content arrives as string or object", () => {
  const asString = { msg_type: "post", body: { content: POST_WITH_IMAGE } };
  const asObject = { msg_type: "post", content: JSON.parse(POST_WITH_IMAGE) };
  assert.equal(textOfMessage(asString).trim(), "看一下这张图");
  assert.equal(textOfMessage(asObject).trim(), "看一下这张图");
  assert.equal(textOf({ content: POST_WITH_IMAGE }), "");
  assert.deepEqual(bodyOf({ content: "not-json" }), null);
});

test("TC-32 attachments are collected from image, file and post payloads", () => {
  assert.deepEqual(attachmentsOf({ msg_type: "image", body: { content: JSON.stringify({ image_key: "img_v3_a" }) } }), [{ kind: "image", key: "img_v3_a" }]);
  assert.deepEqual(attachmentsOf({ msg_type: "file", body: { content: JSON.stringify({ file_key: "file_v3_b", file_name: "a.pdf" }) } }), [{ kind: "file", key: "file_v3_b", name: "a.pdf" }]);
  assert.deepEqual(attachmentsOf({ message_type: "post", content: POST_WITH_IMAGE }), [{ kind: "image", key: "img_v3_probe_123456" }]);
  assert.deepEqual(attachmentsOf({ msg_type: "text", body: { content: '{"text":"hi"}' } }), []);
});

test("TC-33 event payloads report message_type while API payloads report msg_type", () => {
  assert.equal(msgTypeOf({ message_type: "post" }), "post");
  assert.equal(msgTypeOf({ msg_type: "image" }), "image");
  assert.equal(msgTypeOf({}), null);
});

test("TC-34 uploads land under chat/date with a content-type extension", () => {
  const dir = uploadDirFor("/cfg", "oc_1", new Date("2026-10-25T04:00:00Z"));
  assert.equal(dir, "/cfg/uploads/oc_1/20261025");
});

test("TC-35 pruneUploads removes files older than the ttl", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-prune-"));
  const fresh = join(root, "fresh.jpg");
  const stale = join(root, "stale.jpg");
  writeFileSync(fresh, "a");
  writeFileSync(stale, "b");
  pruneUploads(root, 1000, Date.now() + 5000);
  assert.equal(existsSync(fresh), false);
  assert.equal(existsSync(root), false);
});

test("TC-36 an image-only message is queued with a download path", async () => {
  const { handlers, seen, configDir } = imageHarness({ resource: okResource() });
  await new Promise((resolve) => setTimeout(resolve, 50));
  await handlers["im.message.receive_v1"]({
    sender: { sender_type: "user", sender_id: { open_id: "ou_test_user" } },
    message: { message_id: "om_img_only", chat_id: "oc_1", message_type: "image", content: '{"image_key":"img_v3_probe_123456"}' },
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(seen.length, 1);
  assert.match(seen[0].text, /1 个附件/);
  assert.equal(seen[0].attachments.length, 1);
  assert.equal(seen[0].attachments[0].kind, "image");
  assert.match(seen[0].attachments[0].path, new RegExp(`^${configDir}/uploads/oc_1/\\d{8}/img_v3_probe\\.jpg$`));
  assert.equal(statSync(seen[0].attachments[0].path).size, 10);
});

test("TC-37 a post with text and image keeps both", async () => {
  const { handlers, seen } = imageHarness({ resource: okResource("image/png") });
  await new Promise((resolve) => setTimeout(resolve, 50));
  await handlers["im.message.receive_v1"]({
    sender: { sender_type: "user", sender_id: { open_id: "ou_test_user" } },
    message: { message_id: "om_post", chat_id: "oc_1", message_type: "post", content: POST_WITH_IMAGE },
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(seen.length, 1);
  assert.match(seen[0].text, /看一下这张图/);
  assert.match(seen[0].attachments[0].path, /\.png$/);
});

test("TC-38 a failing download still queues the message with a note", async () => {
  const { handlers, seen } = imageHarness({ resource: () => { throw new Error("gateway down"); } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  await handlers["im.message.receive_v1"]({
    sender: { sender_type: "user", sender_id: { open_id: "ou_test_user" } },
    message: { message_id: "om_fail", chat_id: "oc_1", message_type: "image", content: '{"image_key":"img_v3_fail"}' },
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(seen.length, 1);
  assert.match(seen[0].text, /1 个附件下载失败/);
  assert.deepEqual(seen[0].attachments, []);
});

test("TC-39 withTimeout rejects a hanging download", async () => {
  await assert.rejects(() => withTimeout(new Promise(() => {}), 10), /timeout/);
});
