import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { stripMentions, sessionFor, acceptsEvent, heartbeatVerdict, refreshDelayMs, alertAllowed, pruneThreads, decideProgressMode, createRuntime, createPlatform, createAttachmentDownloader, createMediaUploader, composeText, shouldAlertFiles, FILES_ALERT, MEDIA_ALERT, replyRules } from "../src/platforms/slack.mjs";
import { uploadDirFor } from "../src/platforms/shared/uploads.mjs";

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

function attachmentHarness({ files, response, info } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "relay-slack-attach-"));
  const logs = [];
  const fetches = [];
  const infos = [];
  const download = createAttachmentDownloader({
    config: { configDir: dir },
    log: (level, ...args) => logs.push([level, ...args]),
    channel: "CTESTCHANNEL",
    token: "xoxb-test",
    api: async (method, params) => {
      infos.push([method, params]);
      return info ?? { ok: true };
    },
    fetchFn: async (url) => {
      fetches.push(url);
      return response ?? okDownload("image/jpeg");
    },
  });
  return { dir, logs, fetches, infos, download };
}

function okDownload(type, size = 8) {
  return {
    ok: true,
    status: 200,
    headers: new Map([["content-type", type]]),
    arrayBuffer: async () => new ArrayBuffer(size),
  };
}

function slackFile(over = {}) {
  return {
    id: "F0CCC510MPH",
    name: "IMG_0129.jpg",
    mimetype: "image/jpeg",
    size: 580409,
    url_private_download: "https://files.slack.com/files-pri/T1-F0CCC510MPH/download/img_0129.jpg",
    ...over,
  };
}

test("AC-1 a captioned image lands in uploads and is passed as an attachment", async () => {
  const { dir, download } = attachmentHarness();
  const parsed = await download([slackFile()]);
  assert.equal(parsed.saved.length, 1);
  assert.equal(parsed.saved[0].kind, "image");
  assert.equal(parsed.saved[0].path, join(uploadDirFor(dir, "CTESTCHANNEL"), "F0CCC510MPH.jpg"));
  assert.equal(existsSync(parsed.saved[0].path), true);
  const text = composeText("图片里这是什么？", parsed);
  assert.equal(text, "图片里这是什么？");
  assert.doesNotMatch(text, /\[附件\]/);
});

test("AC-2 an image without text is accepted and says how many files arrived", async () => {
  const { download } = attachmentHarness();
  const parsed = await download([slackFile()]);
  assert.equal(composeText("", parsed), "（发了 1 个附件，未附文字）");
  assert.equal(acceptsEvent({ ...base, text: "", subtype: "file_share", files: [slackFile()] }, TEST_SCOPE).ok, true);
});

test("AC-3 more than four files downloads four and reports the rest", async () => {
  const { download, fetches } = attachmentHarness();
  const files = [0, 1, 2, 3, 4].map((n) => slackFile({ id: `F0000000000${n}`, name: `f${n}.jpg` }));
  const parsed = await download(files);
  assert.equal(fetches.length, 4);
  assert.equal(parsed.saved.length, 4);
  assert.equal(parsed.truncated, 1);
  assert.match(composeText("看这几张", parsed), /（还有 1 个附件未处理，单条消息最多 4 个）/);
});

test("AC-4 a file over the byte limit is not written and counts as failed", async () => {
  const { download, logs } = attachmentHarness();
  const parsed = await download([slackFile({ size: 21 * 1024 * 1024 })]);
  assert.equal(parsed.saved.length, 0);
  assert.equal(parsed.failed.length, 1);
  assert.match(composeText("看图", parsed), /（1 个附件下载失败，未能查看）/);
  assert.ok(logs.some(([level, event]) => level === "error" && event === "attachment"));
});

test("AC-5 an HTML body means the bot lacks files:read and is never saved", async () => {
  const { download, logs } = attachmentHarness({ response: okDownload("text/html") });
  const parsed = await download([slackFile()]);
  assert.equal(parsed.saved.length, 0);
  assert.equal(parsed.failed.length, 1);
  assert.ok(logs.some(([, event, , message]) => event === "attachment" && message.includes("files:read")));
});

test("AC-6 every download failing raises one alert naming the missing scope", async () => {
  const { download } = attachmentHarness({ response: { ok: false, status: 403, headers: new Map(), arrayBuffer: async () => new ArrayBuffer(0) } });
  const parsed = await download([slackFile()]);
  assert.equal(parsed.saved.length, 0);
  assert.equal(shouldAlertFiles(parsed), true);
  assert.equal(shouldAlertFiles({ saved: [{}], failed: [{}], truncated: 0 }), false);
  assert.match(FILES_ALERT, /files:read/);
  const source = readFileSync(new URL("../src/platforms/slack.mjs", import.meta.url), "utf8");
  assert.match(source, /if \(shouldAlertFiles\(parsed\)\) alertOnce\("files", FILES_ALERT\)/);
});

test("AC-7 an unknown mimetype keeps the name suffix, a suffixed file keeps its own", async () => {
  const { download } = attachmentHarness({ response: okDownload("application/pdf") });
  const parsed = await download([slackFile({ name: "report.pdf", mimetype: "application/pdf" })]);
  assert.match(parsed.saved[0].path, /\.pdf$/);
  assert.equal(parsed.saved[0].kind, "file");
  const bare = attachmentHarness({ response: okDownload("application/octet-stream") });
  const other = await bare.download([slackFile({ name: "no-suffix", mimetype: "application/octet-stream" })]);
  assert.match(other.saved[0].path, /\.bin$/);
});

test("AC-8 a file without a download url is resolved through files.info", async () => {
  const { download, infos } = attachmentHarness({ info: { ok: true, file: slackFile() } });
  const parsed = await download([slackFile({ url_private_download: undefined, url_private: undefined })]);
  assert.equal(infos.length, 1);
  assert.equal(infos[0][0], "files.info");
  assert.equal(parsed.saved.length, 1);

  const denied = attachmentHarness({ info: { ok: false, error: "missing_scope" } });
  const failed = await denied.download([slackFile({ url_private_download: undefined, url_private: undefined })]);
  assert.equal(failed.saved.length, 0);
  assert.equal(failed.failed.length, 1);
});

test("AC-9 messages without files never download anything", () => {
  const source = readFileSync(new URL("../src/platforms/slack.mjs", import.meta.url), "utf8");
  assert.match(source, /event\.files\?\.length \? await downloadAttachments\(event\.files\)/);
  assert.equal(acceptsEvent({ ...base, text: "   " }, TEST_SCOPE).ok, false);
  assert.equal(acceptsEvent({ ...base, user: "U-stranger", files: [slackFile()] }, TEST_SCOPE).ok, false);
  assert.equal(acceptsEvent({ ...base, bot_id: "B1", files: [slackFile()] }, TEST_SCOPE).ok, false);
});

test("TC-12 the reply rules pair every markdown habit with the mrkdwn form Slack actually renders", () => {
  for (const fragment of ["`*x*`", "`##`", "`**x**`", "`• `", "`- `", "表格"]) {
    assert.ok(replyRules.includes(fragment), `replyRules never mentions ${fragment}`);
  }
  assert.match(replyRules, /标题和粗体都写 `\*x\*`/);
  assert.match(replyRules, /列表用 `• `/);
  assert.match(replyRules, /单独一行写 `!\[\]\(\/绝对路径\.png\)`/);
});

function shotFile(bytes = "png-bytes", name = "shot.png") {
  const dir = mkdtempSync(join(tmpdir(), "relay-slack-media-"));
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return { path, name, mime: "image/png" };
}

function mediaRig({ api, fetchFn, alertOnce = () => {}, reply = async () => {} } = {}) {
  const calls = [];
  return {
    calls,
    postMedia: createMediaUploader({
      api: api ?? (async (method, params) => (calls.push({ method, params }), { ok: true, file_id: `F${calls.length}`, upload_url: `https://files.slack.test/${calls.length}` })),
      channel: "CTEST",
      token: "xoxb-TEST",
      log: () => {},
      reply,
      fetchFn,
      alertOnce,
    }),
  };
}

test("TC-MEDIA1 media is uploaded in three steps and shared into the reply thread", async () => {
  const posts = [];
  const fetchFn = async (url, init) => {
    posts.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ ok: true, files: [{ id: "F1" }, { id: "F2" }] }) };
  };
  const first = shotFile("first-bytes");
  const second = shotFile("second-bytes", "chart.png");
  const { postMedia, calls } = mediaRig({ fetchFn });
  const result = await postMedia({ replyTo: "1792.0001" }, [first, second]);

  assert.deepEqual(calls.map((call) => call.method), ["files.getUploadURLExternal", "files.getUploadURLExternal"]);
  assert.equal(calls[0].params.filename, "shot.png");
  assert.equal(calls[0].params.length, 11);
  assert.equal(calls[1].params.length, 12);
  assert.equal(posts[0].url, "https://files.slack.test/1");
  assert.equal(posts[0].init.method, "POST");
  assert.equal(posts[0].init.headers["Content-Type"], "application/octet-stream");
  assert.equal(String(posts[0].init.body), "first-bytes");
  assert.equal(String(posts[1].init.body), "second-bytes");
  assert.equal(posts[2].url, "https://slack.com/api/files.completeUploadExternal");
  assert.equal(posts[2].init.headers.Authorization, "Bearer xoxb-TEST");
  assert.equal(posts[2].init.body.get("channel_id"), "CTEST");
  assert.equal(posts[2].init.body.get("thread_ts"), "1792.0001");
  assert.deepEqual(JSON.parse(posts[2].init.body.get("files")), [{ id: "F1" }, { id: "F2" }]);
  assert.deepEqual(result, { messageId: null, degraded: false });
});

test("TC-MEDIA2 a missing files:write scope degrades to one text note plus one alert", async () => {
  const alerts = [];
  const replies = [];
  const api = async () => ({ ok: false, error: "missing_scope" });
  const fetchFn = async () => {
    throw new Error("nothing must be uploaded without a scope");
  };
  const { postMedia } = mediaRig({ api, fetchFn, alertOnce: (kind) => alerts.push(kind), reply: async (ctx, text) => replies.push({ replyTo: ctx.replyTo, text }) });
  const result = await postMedia({ replyTo: "1792.0001" }, [shotFile(), shotFile("two", "b.png")]);

  assert.equal(result.degraded, true);
  assert.deepEqual(alerts, ["media"]);
  assert.deepEqual(replies, [{ replyTo: "1792.0001", text: "（2 张图片未能上传：Slack 授权缺少 files:write）" }]);
  assert.equal(MEDIA_ALERT.includes("files:write"), true);
});

test("TC-MEDIA3 a missing bot token degrades instead of throwing", async () => {
  const replies = [];
  const alerts = [];
  const postMedia = createMediaUploader({ api: null, channel: "CTEST", token: null, log: () => {}, reply: async (ctx, text) => replies.push(text), alertOnce: (kind) => alerts.push(kind) });
  const result = await postMedia({ replyTo: "1" }, [shotFile()]);
  assert.deepEqual(result, { messageId: null, degraded: true });
  assert.deepEqual(alerts, ["media"]);
  assert.deepEqual(replies, ["（1 张图片未能上传：缺少 bot token）"]);
});

test("TC-MEDIA4 a transient upload failure is rethrown so the job retries it", async () => {
  const api = async () => ({ ok: true, file_id: "F1", upload_url: "https://files.slack.test/1" });
  const fetchFn = async (url) => (url.endsWith("completeUploadExternal") ? { ok: true, json: async () => ({ ok: false, error: "internal_error" }) } : { ok: true, status: 200 });
  const posts = [];
  const { postMedia } = mediaRig({ api, fetchFn: (url, init) => (posts.push(url), fetchFn(url, init)) });
  await assert.rejects(() => postMedia({ replyTo: "1" }, [shotFile()]), /completeUploadExternal internal_error/);
  assert.equal(posts.length, 2, "the bytes go up before complete is attempted");
});
