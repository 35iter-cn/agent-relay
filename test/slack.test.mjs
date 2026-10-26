import test from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { stripMentions, sessionFor, acceptsEvent, heartbeatVerdict, refreshDelayMs, alertAllowed, pruneThreads, decideProgressMode, createRuntime, createPlatform } from "../src/platforms/slack.mjs";

const TEST_SCOPE = { channel: "CTEST", allowedUser: "UTEST", botUser: "UBOT" };

const base = { channel: TEST_SCOPE.channel, ts: "1792558469.808939", text: "帮我扫一下 <@UTEST>", user: TEST_SCOPE.allowedUser };

test("mentions are stripped together with their surrounding space", () => {
  assert.equal(stripMentions("<@U1> 帮我看下"), "帮我看下");
  assert.equal(stripMentions("帮 <@U1> 看下"), "帮 看下");
  assert.equal(stripMentions("<@U1> <@U2> 都看下"), "都看下");
  assert.equal(stripMentions("邮箱 hao@example.com"), "邮箱 hao@example.com");
});

test("mentions are stripped from the message text", () => {
  assert.equal(stripMentions("<@TESTUSER> 帮我扫一下"), "帮我扫一下");
  assert.equal(stripMentions("   "), "");
});

test("threads map to dot-free session names", () => {
  assert.equal(sessionFor("1792558469.808939"), "slack-1792558469808939");
});

test("TC-10 the bot's own messages are ignored", () => {
  assert.deepEqual(acceptsEvent({ ...base, bot_id: "B123" }, TEST_SCOPE), { ok: false, why: "bot" });
  assert.deepEqual(acceptsEvent({ ...base, user: TEST_SCOPE.botUser }, TEST_SCOPE), { ok: false, why: "bot" });
});

test("TC-10 only the allowed author in the configured channel is accepted", () => {
  assert.deepEqual(acceptsEvent({ ...base, user: "U-stranger" }, TEST_SCOPE), { ok: false, why: "author" });
  assert.deepEqual(acceptsEvent({ ...base, channel: "C-other" }, TEST_SCOPE), { ok: false, why: "channel" });
  assert.deepEqual(acceptsEvent({ ...base, text: "   " }, TEST_SCOPE), { ok: false, why: "empty-text" });
  assert.deepEqual(acceptsEvent(null, TEST_SCOPE), { ok: false, why: "empty" });
  assert.deepEqual(acceptsEvent(base, {}), { ok: false, why: "unconfigured" });
  assert.deepEqual(acceptsEvent(base, { channel: TEST_SCOPE.channel }), { ok: false, why: "unconfigured" });
});

test("thread replies join the parent thread, top-level messages start one", () => {
  const reply = acceptsEvent({ ...base, thread_ts: "1792558000.000100" }, TEST_SCOPE);
  assert.equal(reply.ok, true);
  assert.equal(reply.thread, "1792558000.000100");
  const top = acceptsEvent(base, TEST_SCOPE);
  assert.equal(top.thread, base.ts);
});

test("subtypes that carry real content are accepted, others ignored", () => {
  assert.equal(acceptsEvent({ ...base, subtype: "thread_broadcast" }, TEST_SCOPE).ok, true);
  assert.equal(acceptsEvent({ ...base, subtype: "file_share" }, TEST_SCOPE).ok, true);
  assert.deepEqual(acceptsEvent({ ...base, subtype: "channel_join" }, TEST_SCOPE), { ok: false, why: "subtype" });
});

test("TC-11 a missing server ping terminates the connection", () => {
  const now = 1_000_000;
  assert.equal(heartbeatVerdict({ lastServerPingAt: now - 31_000, lastPongAt: now }, now), "no-server-ping");
  assert.equal(heartbeatVerdict({ lastServerPingAt: now - 5_000, lastPongAt: now }, now), null);
});

test("TC-11 a missing pong terminates the connection", () => {
  const now = 1_000_000;
  assert.equal(heartbeatVerdict({ lastServerPingAt: now - 1_000, lastPongAt: now - 11_000 }, now), "no-pong");
  assert.equal(heartbeatVerdict({ lastServerPingAt: now - 1_000, lastPongAt: now - 2_000 }, now), null);
  assert.equal(heartbeatVerdict({ lastServerPingAt: now - 1_000, lastPongAt: null }, now), null);
});

test("TC-11 the connection rotates at 80% of its announced lifetime", () => {
  assert.equal(refreshDelayMs(600_000), 480_000);
  assert.equal(refreshDelayMs(10_000), 60_000);
  assert.equal(refreshDelayMs(600_000, 120_000), 120_000);
});

test("alerts respect the cooldown window", () => {
  assert.equal(alertAllowed({}, "stale", 1_000_000), true);
  assert.equal(alertAllowed({ stale: new Date(1_000_000).toISOString() }, "stale", 1_060_000), false);
  assert.equal(alertAllowed({ stale: new Date(1_000_000).toISOString() }, "stale", 1_000_000 + 31 * 60_000), true);
});

test("threads older than the retention window are pruned", () => {
  const now = Date.parse("2026-10-22T12:00:00Z");
  const pruned = pruneThreads(
    {
      old: { lastMsgTs: "2026-09-01T00:00:00Z" },
      fresh: { lastMsgTs: "2026-10-22T11:00:00Z" },
      unknown: {},
    },
    now,
  );
  assert.deepEqual(Object.keys(pruned), ["fresh", "unknown"]);
});

test("stop words cancel only the exact match", () => {
});

test("slack announces readiness once and only from the start scope", () => {
  const source = readFileSync(new URL("../src/platforms/slack.mjs", import.meta.url), "utf8");
  const helloBlock = source.slice(source.indexOf('if (envelope.type === "hello")'), source.indexOf('if (envelope.type === "disconnect")'));
  assert.doesNotMatch(helloBlock, /onReady/);
  assert.match(source, /let readyAnnounced = false;/);
  assert.match(source, /if \(!readyAnnounced\) \{/);
});

function fakeApi(handlers = {}) {
  const calls = [];
  const api = async (method, params) => {
    calls.push([method, params]);
    const handler = handlers[method];
    const res = typeof handler === "function" ? handler(params) : handler;
    return res ?? { ok: true };
  };
  return { api, calls };
}

function harness({ handlers, api, post, emoji } = {}) {
  const logs = [];
  const fake = api === undefined ? fakeApi(handlers) : { api, calls: [] };
  const sent = [];
  const runtime = createRuntime({
    api: fake.api,
    log: (level, ...args) => logs.push([level, ...args]),
    channel: "CTESTCHANNEL",
    post:
      post ??
      (async (thread, text) => {
        sent.push([thread, text]);
      }),
    emoji,
  });
  return { runtime, calls: fake.calls, logs, sent };
}

function progressCtx(over = {}) {
  return {
    jobId: "j1",
    key: "1792558469.808939",
    chatId: "CTESTCHANNEL",
    messageId: "1792558469.808939",
    threadId: null,
    replyTo: "1792558469.808939",
    progress: null,
    text: "hi",
    rootText: "hi",
    ...over,
  };
}

test("AC-1 a reaction marks the user message while the job runs", async () => {
  const { runtime, calls } = harness({ handlers: { "reactions.add": { ok: true } } });
  const entry = await runtime.onProgress(progressCtx());
  assert.deepEqual(entry, { mode: "reaction", messageId: "1792558469.808939", name: "thinking_face" });
  assert.deepEqual(calls[0], ["reactions.add", { channel: "CTESTCHANNEL", timestamp: "1792558469.808939", name: "thinking_face" }]);
});

test("AC-1 without a message id nothing is marked", async () => {
  const { runtime, calls } = harness({ handlers: {} });
  assert.equal(await runtime.onProgress(progressCtx({ messageId: null })), null);
  assert.equal(calls.length, 0);
});

test("AC-2 the reaction is removed after the job ends", async () => {
  const { runtime, calls, logs } = harness({ handlers: { "reactions.remove": { ok: true } } });
  const progress = { mode: "reaction", messageId: "1792558469.808939", name: "thinking_face" };
  await runtime.onProgressDone(progressCtx({ progress }));
  assert.deepEqual(calls[0], ["reactions.remove", { channel: "CTESTCHANNEL", timestamp: "1792558469.808939", name: "thinking_face" }]);
  assert.deepEqual(logs, []);
});

test("AC-2 an already removed reaction is not an error", async () => {
  const { runtime, logs } = harness({ handlers: { "reactions.remove": { ok: false, error: "no_reaction" } } });
  const progress = { mode: "reaction", messageId: "1792558469.808939", name: "thinking_face" };
  await runtime.onProgressDone(progressCtx({ progress }));
  assert.deepEqual(logs, []);
});

test("AC-3 a missing scope falls back to a placeholder the answer replaces", async () => {
  const { runtime, calls } = harness({
    handlers: {
      "reactions.add": { ok: false, error: "missing_scope" },
      "chat.postMessage": { ok: true, ts: "1792559000.000001" },
      "chat.update": { ok: true },
    },
  });
  const progress = await runtime.onProgress(progressCtx());
  assert.deepEqual(progress, { mode: "placeholder", messageId: "1792559000.000001", pending: true });
  assert.equal(calls[1][0], "chat.postMessage");
  assert.equal(calls[1][1].text, "⏳ 正在处理…");

  const sent = await runtime.reply(progressCtx({ progress }), "答案");
  assert.deepEqual(sent, { messageId: "1792559000.000001", patched: true });
  assert.deepEqual(calls[2], ["chat.update", { channel: "CTESTCHANNEL", ts: "1792559000.000001", text: "答案" }]);
  assert.equal(progress.pending, false);

  await runtime.onProgressDone(progressCtx({ progress }));
  assert.equal(calls.length, 3);
});

test("AC-3 a placeholder the answer never used is deleted", async () => {
  const { runtime, calls } = harness({ handlers: { "chat.delete": { ok: true } } });
  const progress = { mode: "placeholder", messageId: "1792559000.000001", pending: true };
  await runtime.onProgressDone(progressCtx({ progress }));
  assert.deepEqual(calls[0], ["chat.delete", { channel: "CTESTCHANNEL", ts: "1792559000.000001" }]);
});

test("AC-3 a placeholder that is already gone is not an error", async () => {
  const { runtime, logs } = harness({ handlers: { "chat.delete": { ok: false, error: "message_not_found" } } });
  const progress = { mode: "placeholder", messageId: "1792559000.000001", pending: true };
  await runtime.onProgressDone(progressCtx({ progress }));
  assert.deepEqual(logs, []);
});

test("an unrelated progress error leaves the message unmarked", async () => {
  const { runtime, calls, logs } = harness({ handlers: { "reactions.add": { ok: false, error: "ratelimited" } } });
  assert.equal(await runtime.onProgress(progressCtx()), null);
  assert.equal(calls.length, 1);
  assert.deepEqual(logs, [["warn", "progress-unavailable", "ratelimited"]]);
});

test("AC-4 replies carry the thread and return the ts", async () => {
  const { runtime, calls } = harness({ handlers: { "chat.postMessage": { ok: true, ts: "1792559000.000002" } } });
  const sent = await runtime.reply(progressCtx(), "答案");
  assert.deepEqual(sent, { messageId: "1792559000.000002" });
  assert.deepEqual(calls[0], ["chat.postMessage", { channel: "CTESTCHANNEL", text: "答案", thread_ts: "1792558469.808939" }]);
});

test("AC-4 editing updates the existing message", async () => {
  const { runtime, calls } = harness({ handlers: { "chat.update": { ok: true } } });
  assert.equal(await runtime.edit(progressCtx(), "1792559000.000002", "改过的答案"), true);
  assert.deepEqual(calls[0], ["chat.update", { channel: "CTESTCHANNEL", ts: "1792559000.000002", text: "改过的答案" }]);
});

test("AC-4 a failed edit reports false instead of throwing", async () => {
  const { runtime, logs } = harness({ handlers: { "chat.update": { ok: false, error: "message_not_found" } } });
  assert.equal(await runtime.edit(progressCtx(), "1792559000.000002", "改过的答案"), false);
  assert.deepEqual(logs, [["warn", "edit", "message_not_found"]]);
});

test("AC-5 without a bot token the runtime stays webhook only", async () => {
  const { runtime, sent, logs } = harness({ api: null });
  assert.equal(await runtime.onProgress(progressCtx()), null);
  assert.equal(await runtime.reply(progressCtx(), "答案"), null);
  assert.deepEqual(sent, [["1792558469.808939", "答案"]]);
  assert.equal(await runtime.edit(progressCtx(), "1792559000.000002", "x"), false);
  await runtime.onProgressDone(progressCtx({ progress: { mode: "reaction", messageId: "m" } }));
  assert.deepEqual(logs, []);
});

test("AC-5 a failing postMessage still delivers through the webhook", async () => {
  const { runtime, sent, logs } = harness({ handlers: { "chat.postMessage": { ok: false, error: "not_in_channel" } } });
  assert.equal(await runtime.reply(progressCtx(), "答案"), null);
  assert.deepEqual(sent, [["1792558469.808939", "答案"]]);
  assert.equal(logs[0][0], "warn");
});

test("the progress emoji is configurable", async () => {
  const { runtime, calls } = harness({ handlers: { "reactions.add": { ok: true } }, emoji: "hourglass_flowing_sand" });
  assert.equal((await runtime.onProgress(progressCtx())).name, "hourglass_flowing_sand");
  assert.equal(calls[0][1].name, "hourglass_flowing_sand");
});

test("decideProgressMode maps slack errors onto the degradation ladder", () => {
  assert.equal(decideProgressMode(null), "reaction");
  assert.equal(decideProgressMode("already_reacted"), "reaction");
  assert.equal(decideProgressMode("missing_scope"), "placeholder");
  assert.equal(decideProgressMode("not_allowed_token_type"), "placeholder");
  assert.equal(decideProgressMode("invalid_auth"), "placeholder");
  assert.equal(decideProgressMode("ratelimited"), "none");
});

test("slack refuses to start without a channel or an allowed user", async () => {
  const exits = [];
  const logs = [];
  const originalExit = process.exit;
  process.exit = (code) => {
    exits.push(code);
    throw new Error(`exit ${code}`);
  };
  try {
    const base = { SLACK_APP_TOKEN: "xapp", SLACK_BOT_TOKEN: "xoxb", AGENT_RELAY_SLACK_CHANNEL: "CTEST" };
    const missingUser = createPlatform({
      config: { readEnv: () => base, envFile: (name) => `/tmp/${name}`, home: "/tmp", configDir: "/tmp" },
      log: (...parts) => logs.push(parts.map(String).join(" ")),
    });
    await assert.rejects(() => missingUser.start({ onMessage: async () => {}, core: { state: { convs: {} }, save: () => {} } }), /exit 1/);

    const missingChannel = createPlatform({
      config: { readEnv: () => ({ SLACK_APP_TOKEN: "xapp", SLACK_BOT_TOKEN: "xoxb", AGENT_RELAY_ALLOWED_USER: "UTEST" }), envFile: (name) => `/tmp/${name}`, home: "/tmp", configDir: "/tmp" },
      log: (...parts) => logs.push(parts.map(String).join(" ")),
    });
    await assert.rejects(() => missingChannel.start({ onMessage: async () => {}, core: { state: { convs: {} }, save: () => {} } }), /exit 1/);
  } finally {
    process.exit = originalExit;
  }
  assert.deepEqual(exits, [1, 1]);
  assert.ok(logs.some((line) => line.includes("AGENT_RELAY_SLACK_CHANNEL")));
  assert.ok(logs.some((line) => line.includes("AGENT_RELAY_ALLOWED_USER")));
});
