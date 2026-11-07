import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  MAX_LOOPS,
  MIN_EVERY_MS,
  activeLoopCount,
  createLoop,
  isLoopId,
  nextLoopId,
  platformOfLoopId,
  validatePrompt,
  validateSchedule,
} from "../src/loops/model.mjs";
import { loopDueAt, loopLateMs, roundSkipReason, roundsInLastHour } from "../src/loops/schedule.mjs";
import { roundKeyFor, roundTitle, truncateOutput } from "../src/loops/round.mjs";
import { appendRound, findRound, listRounds, loopHistoryFile, pruneHistory, readRoundLines } from "../src/loops/history.mjs";

const nowIso = () => new Date().toISOString();

test("TC-LP1 an interval under ten minutes or a missing schedule is refused", () => {
  assert.equal(validateSchedule({ every: "5m" }), "every-too-small");
  assert.equal(validateSchedule({ every: "10m" }), null);
  assert.equal(validateSchedule({ every: "2h" }), null);
  assert.equal(validateSchedule({}), "schedule-required");
  assert.equal(validateSchedule({ every: "10m", at: nowIso() }), "schedule-required");
  assert.equal(validateSchedule({ at: "not-a-date" }), "bad-at");
  assert.equal(validateSchedule({ every: "半小时" }), "bad-every");
  assert.equal(MIN_EVERY_MS, 600_000);
});

test("TC-LP2 a prompt over four kilobytes or an empty one is refused", () => {
  assert.equal(validatePrompt("  "), "empty-prompt");
  assert.equal(validatePrompt("x".repeat(4096)), null);
  assert.equal(validatePrompt("x".repeat(4097)), "prompt-too-long");
});

test("TC-LP3 ids carry the platform and continue from the highest sequence", () => {
  const loops = { "loop-slack-2": {}, "loop-slack-7": {}, "loop-discord-1": {} };
  assert.equal(nextLoopId(loops, "slack"), "loop-slack-8");
  assert.equal(nextLoopId(loops, "telegram"), "loop-telegram-1");
  assert.equal(platformOfLoopId("loop-slack-7"), "slack");
  assert.equal(platformOfLoopId("loop-7"), null);
  assert.equal(isLoopId("loop-mattermost-12"), true);
  assert.equal(isLoopId("loop-mattermost-x"), false);
  assert.equal(activeLoopCount({ ...loops, "loop-slack-3": { state: "deleted" } }), 3);
  assert.equal(MAX_LOOPS, 20);
});

test("TC-LP4 a new loop is armed with no runs and a fresh counter", () => {
  const loop = createLoop({ id: "loop-slack-1", prompt: " 看 CI ", every: "30m", nowIso: "2026-11-06T00:00:00.000Z", createdBy: "k" });
  assert.equal(loop.prompt, "看 CI");
  assert.equal(loop.state, "armed");
  assert.equal(loop.thread, true);
  assert.equal(loop.lastRound, 0);
  assert.equal(loop.failStreak, 0);
  assert.equal(loop.lastRunAt, null);
  assert.equal(createLoop({ id: "x", prompt: "p", every: "1h", thread: false, nowIso: "t" }).thread, false);
});

test("TC-LP5 the first due point is createdAt plus every, later ones anchor on lastRunAt", () => {
  const base = { every: "30m", createdAt: "2026-11-06T00:00:00.000Z" };
  assert.equal(loopDueAt(base), Date.parse("2026-11-06T00:30:00.000Z"));
  assert.equal(loopDueAt({ ...base, lastRunAt: "2026-11-06T00:40:00.000Z" }), Date.parse("2026-11-06T01:10:00.000Z"));
  assert.equal(loopDueAt({ every: null, at: "2026-11-07T00:00:00.000Z", createdAt: base.createdAt }), Date.parse("2026-11-07T00:00:00.000Z"));
  assert.equal(loopDueAt({ every: "30m", createdAt: "broken" }), Number.POSITIVE_INFINITY);
  assert.equal(loopLateMs({ ...base, lastRunAt: "2026-11-06T00:00:00.000Z" }, Date.parse("2026-11-06T00:35:00.000Z")), 300_000);
});

test("TC-LP6 a tick skips on state, schedule, a running round, the worker ceiling and the hourly budget", () => {
  const due = { state: "armed", every: "10m", createdAt: "2026-11-06T00:00:00.000Z" };
  const nowMs = Date.parse("2026-11-06T01:00:00.000Z");
  assert.equal(roundSkipReason({ loop: due, nowMs }), null);
  assert.equal(roundSkipReason({ loop: { ...due, state: "paused" }, nowMs }), "state");
  assert.equal(roundSkipReason({ loop: { ...due, createdAt: "2026-11-06T00:55:00.000Z" }, nowMs }), "not-due");
  assert.equal(roundSkipReason({ loop: due, nowMs, openJob: { id: "job-1" } }), "busy");
  assert.equal(roundSkipReason({ loop: due, nowMs, running: 5, maxWorkers: 5 }), "workers");
  assert.equal(roundSkipReason({ loop: due, nowMs, roundsLastHour: 20 }), "throttled");
  const stamps = ["2026-11-06T00:30:00.000Z", "2026-11-06T00:30:00.000Z", "2026-11-05T22:00:00.000Z"];
  assert.equal(roundsInLastHour(stamps, nowMs), 2);
});

test("TC-LP7 a round key is derived from the loop id and the round number", () => {
  assert.equal(roundKeyFor("loop-slack-3", 12), "loop-slack-3-r12");
  assert.equal(roundTitle({ id: "loop-slack-3" }, 12), "loop-slack-3 第 12 轮");
  assert.equal(truncateOutput("abc"), "abc");
  const big = "轮".repeat(20_000);
  assert.ok(Buffer.byteLength(truncateOutput(big)) <= 32 * 1024);
});

test("TC-LP10 the schedule is exactly one of every, at and cron, and a cron expression must fire", () => {
  assert.equal(validateSchedule({ cron: "0 13 * * *" }), null);
  assert.equal(validateSchedule({ cron: "*/5 9-18 * * 1-5" }), null);
  assert.equal(validateSchedule({ cron: "bad" }), "bad-cron");
  assert.equal(validateSchedule({ cron: "0 0 30 2 *" }), "never-fires");
  assert.equal(validateSchedule({ every: "30m", cron: "0 13 * * *" }), "schedule-required");
  assert.equal(validateSchedule({ at: nowIso(), cron: "0 13 * * *" }), "schedule-required");
  assert.equal(validateSchedule({ cron: "" }), "schedule-required");
});

test("TC-LP11 a cron loop carries its expression and anchors the next match on the last run", () => {
  const loop = createLoop({ id: "loop-slack-1", prompt: "p", cron: "0 13 * * *", nowIso: "2026-11-06T05:00:00.000Z" });
  assert.equal(loop.cron, "0 13 * * *");
  assert.equal(loop.every, null);
  assert.equal(loop.at, null);
  assert.equal(loopDueAt(loop), Date.parse("2026-11-07T05:00:00.000Z"));
  assert.equal(loopDueAt({ ...loop, lastRunAt: "2026-11-07T05:00:07.000Z" }), Date.parse("2026-11-08T05:00:00.000Z"));
  assert.equal(loopDueAt({ ...loop, lastRunAt: "2026-11-07T02:00:00.000Z" }), Date.parse("2026-11-07T05:00:00.000Z"));
  assert.equal(loopDueAt({ ...loop, cron: "not a cron" }), Number.POSITIVE_INFINITY);
  assert.equal(loopDueAt({ ...loop, every: "30m", cron: "0 13 * * *" }), Date.parse("2026-11-07T05:00:00.000Z"));
  assert.equal(loopDueAt({ ...loop, at: "2026-11-09T00:00:00.000Z", cron: "0 13 * * *" }), Date.parse("2026-11-09T00:00:00.000Z"));
  assert.equal(
    loopDueAt({ ...loop, cron: null, every: null, at: null }),
    Number.POSITIVE_INFINITY,
    "a loop a pre-cron daemon cannot read is never scheduled instead of running at a wrong time",
  );
});

test("TC-LP9 history appends, reads back newest first, finds a run and keeps the tail only", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-loops-"));
  for (let round = 1; round <= 3; round += 1) {
    appendRound(dir, "loop-slack-1", { runId: `loop-slack-1-r${round}`, outcome: "ok", at: `2026-11-06T00:0${round}:00.000Z`, output: `out${round}` });
  }
  assert.equal(readRoundLines(loopHistoryFile(dir, "loop-slack-1")).length, 3);
  assert.deepEqual(listRounds(dir, "loop-slack-1", { limit: 2 }).map((round) => round.runId), ["loop-slack-1-r3", "loop-slack-1-r2"]);
  assert.equal(findRound(dir, "loop-slack-1-r2").output, "out2");
  writeFileSync(loopHistoryFile(dir, "loop-slack-1"), `${readFileSync(loopHistoryFile(dir, "loop-slack-1"), "utf8")}{"broken\n`);
  assert.equal(readRoundLines(loopHistoryFile(dir, "loop-slack-1")).length, 3);
  pruneHistory(dir, Date.parse("2026-11-06T00:05:00.000Z"), { maxRounds: 1 });
  assert.deepEqual(listRounds(dir, "loop-slack-1").map((round) => round.runId), ["loop-slack-1-r3"]);
});
