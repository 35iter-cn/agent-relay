import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createUsage } from "../src/runtime/usage.mjs";

const PROMPT = {
  instructions: "判断本轮请求指向哪类工作，指代词要靠话题起始消息反推；回答不算用户请求，打招呼即使回答里出现工作名字也不算 work。",
  criteria: { work: "工作资产清单：仓库、系统、业务对象", non_work: "闲聊、纯问候", unknown: "看不出来" },
};

function harness({ judge, write, now } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "relay-usage-"));
  const logs = [];
  const usage = createUsage({
    dir,
    judge: judge ?? { judgeChoice: async () => ({ choice: "magic_work", confidence: 0.93, fallback: null }) },
    log: (level, tag, text) => logs.push([level, tag, text].join(" ")),
    now: now ?? (() => Date.parse("2026-10-23T04:00:00.000Z")),
    prompt: PROMPT,
    write,
  });
  return { usage, dir, logs };
}

const job = { id: "job-1", inbound: { text: "改一下 core.mjs" }, createdAt: "2026-10-23T03:59:00.000Z" };

function read(dir) {
  return readFileSync(join(dir, "2026-10-23.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

test("TC-U1 done writes one complete record with answerHead", async () => {
  const { usage, dir } = harness();
  const record = await usage.recordRun({
    job,
    platform: "feishu",
    key: "th-x",
    session: "fs-th-x",
    answer: "x".repeat(300),
    status: "done",
    startedAt: Date.parse("2026-10-23T03:59:30.000Z"),
  });
  assert.equal(record.status, "done");
  assert.equal(record.magic, "magic_work");
  assert.equal(record.confidence, 0.93);
  assert.equal(record.answerHead.length, 200);
  assert.equal(record.answerChars, 300);
  assert.equal(record.durationMs, 30_000);
  assert.equal(record.inputChars, job.inbound.text.length);
  const lines = read(dir);
  assert.equal(lines.length, 1);
  assert.deepEqual(Object.keys(lines[0]).sort(), Object.keys(record).sort());
});

test("TC-U2 failed status skips answerHead and magic judging", async () => {
  let judged = 0;
  const { usage } = harness({
    judge: { judgeChoice: async () => { judged += 1; return { choice: "magic_work", confidence: 0.9, fallback: null }; } },
  });
  const record = await usage.recordRun({ job, platform: "feishu", key: "k", session: "s", answer: "boom", status: "failed", startedAt: 0 });
  assert.equal(record.answerHead, undefined);
  assert.equal(record.magic, "unjudged");
  assert.equal(record.fallback, "failed");
  assert.equal(judged, 0);
});

test("TC-U3 missing startedAt falls back to zero duration", async () => {
  const { usage } = harness();
  const record = await usage.recordRun({ job, platform: "feishu", key: "k", session: "s", answer: "", status: "cancelled" });
  assert.equal(record.durationMs, 0);
  assert.equal(record.magic, "unjudged");
  assert.equal(record.fallback, "cancelled");
});

test("TC-U4 write failure is logged and does not throw", async () => {
  const { usage, logs } = harness({ write: () => { throw new Error("disk full"); } });
  const record = await usage.recordRun({ job, platform: "feishu", key: "k", session: "s", answer: "ok", status: "done", startedAt: 0 });
  assert.equal(record, null);
  assert.ok(logs.some((line) => line.includes("usage")));
});

test("TC-U5 judge failure keeps magic unknown with fallback", async () => {
  const { usage } = harness({ judge: { judgeChoice: async () => ({ choice: null, confidence: null, fallback: "nokey" }) } });
  const record = await usage.recordRun({ job, platform: "feishu", key: "k", session: "s", answer: "ok", status: "done", startedAt: 0 });
  assert.equal(record.magic, "unknown");
  assert.equal(record.fallback, "nokey");
});

function captureState() {
  const seen = [];
  const judge = {
    judgeChoice: async (args) => {
      seen.push(args);
      return { choice: "magic_work", confidence: 0.9, fallback: null };
    },
  };
  return { seen, judge };
}

function runWith(state, args = {}) {
  const { seen, judge } = captureState();
  const { usage } = harness({ judge });
  return usage
    .recordRun({ job: { id: "job-x", inbound: state }, platform: "feishu", key: "k", session: "s", answer: "ok", status: "done", startedAt: 0, ...args })
    .then((record) => ({ record, seen }));
}

test("TC-U6 state keeps start message before the turn message", async () => {
  const { seen } = await runWith({ text: "再查一下", rootText: "你 5 分钟向我汇报一下进度" });
  const state = seen[0].state;
  assert.ok(state.indexOf("【话题起始消息】") < state.indexOf("【本轮用户消息】"));
  assert.ok(state.indexOf("你 5 分钟") < state.indexOf("再查一下"));
  assert.ok(state.includes("【agent 本轮回答（仅供参考，不是用户请求）】"));
});

test("TC-U7 start message equal to the turn is not duplicated", async () => {
  const { seen } = await runWith({ text: "早上好", rootText: "早上好" });
  const state = seen[0].state;
  assert.equal(state.split("早上好").length - 1, 1);
  assert.ok(state.includes("(无，本级即话题起点)"));
});

test("TC-U8 answer is truncated to 400 chars while answerHead stays 200", async () => {
  const { record, seen } = await runWith({ text: "t" }, { answer: "x".repeat(1200) });
  assert.ok(seen[0].state.endsWith("x".repeat(400)));
  assert.equal(record.answerHead.length, 200);
});

test("TC-U9 criteria come from the configured prompt, not from source code", async () => {
  const { seen } = await runWith({ text: "t" });
  assert.deepEqual(seen[0].criteria, PROMPT.criteria);
});

test("TC-U10 instructions come from the configured prompt", async () => {
  const { seen } = await runWith({ text: "t" });
  assert.equal(seen[0].instructions, PROMPT.instructions);
});

test("TC-U13 a missing prompt leaves the magic verdict unconfigured without calling the judge", async () => {
  let calls = 0;
  const dir = mkdtempSync(join(tmpdir(), "relay-usage-"));
  const usage = createUsage({
    dir,
    judge: { judgeChoice: async () => { calls += 1; return { choice: "work" }; } },
    now: () => Date.parse("2026-10-23T04:00:00.000Z"),
  });
  const record = await usage.recordRun({ job, platform: "feishu", key: "th-1", session: "fs-th-1", answer: "ok", status: "done", startedAt: Date.parse("2026-10-23T03:59:00.000Z") });
  assert.equal(record.magic, "unconfigured");
  assert.equal(record.fallback, "no-prompt");
  assert.equal(calls, 0);
});

test("TC-U14 a malformed prompt is rejected instead of half-used", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-usage-"));
  const usage = createUsage({ dir, judge: { judgeChoice: async () => ({ choice: "work" }) }, prompt: { criteria: {} }, now: () => Date.parse("2026-10-23T04:00:00.000Z") });
  const record = await usage.recordRun({ job, platform: "feishu", key: "th-1", session: "fs-th-1", answer: "ok", status: "done", startedAt: Date.parse("2026-10-23T03:59:00.000Z") });
  assert.equal(record.magic, "unconfigured");
});

test("TC-U11 done runs record the judge verdict", async () => {
  const { seen, record } = await runWith({ text: "早上好" });
  assert.equal(seen.length, 1);
  assert.equal(record.magic, "magic_work");
});

test("TC-U12 log file is named by the Asia/Shanghai day, not the UTC day", async () => {
  const { usage, dir } = harness({ now: () => Date.parse("2026-10-25T17:30:00.000Z") });
  await usage.recordRun({ job, platform: "feishu", key: "k", session: "s", answer: "ok", status: "done", startedAt: Date.parse("2026-10-25T17:29:00.000Z") });
  const lines = readFileSync(join(dir, "2026-10-26.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).ts, "2026-10-25T17:30:00.000Z");
});

test("TC-U15 cutoffAt replaces the clock for ts, endedAt, durationMs and the day file", async () => {
  const { usage, dir } = harness();
  const record = await usage.recordRun({
    job,
    platform: "feishu",
    key: "k",
    session: "s",
    answer: "",
    status: "cancelled",
    startedAt: Date.parse("2026-10-22T13:55:00.000Z"),
    cutoffAt: Date.parse("2026-10-22T14:00:00.000Z"),
  });
  assert.equal(record.ts, "2026-10-22T14:00:00.000Z");
  assert.equal(record.endedAt, "2026-10-22T14:00:00.000Z");
  assert.equal(record.durationMs, 300_000);
  const lines = readFileSync(join(dir, "2026-10-22.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].endedAt, "2026-10-22T14:00:00.000Z");
});

test("TC-U16 without cutoffAt the clock still closes the run", async () => {
  const { usage } = harness();
  const record = await usage.recordRun({ job, platform: "feishu", key: "k", session: "s", answer: "", status: "cancelled", startedAt: Date.parse("2026-10-23T03:59:30.000Z") });
  assert.equal(record.ts, "2026-10-23T04:00:00.000Z");
  assert.equal(record.endedAt, "2026-10-23T04:00:00.000Z");
  assert.equal(record.durationMs, 30_000);
});
