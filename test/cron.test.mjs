import test from "node:test";
import assert from "node:assert/strict";
import { CRON_HORIZON_MS, cronNext, localParts, matchesCron, parseCron } from "../src/loops/cron.mjs";

const at = (iso) => Date.parse(iso);

test("TC-CR1 a five-field expression accepts the cron grammar and rejects everything else", () => {
  assert.ok(parseCron("* * * * *"));
  assert.ok(parseCron("0 13 * * *"));
  assert.ok(parseCron("*/5 0-6 1,15 1-12 0-6"));
  assert.ok(parseCron("10-50/10 9 1 * 1"));
  assert.equal(parseCron("0 13 * *"), null);
  assert.equal(parseCron("0 0 13 * * *"), null);
  assert.equal(parseCron("60 * * * *"), null);
  assert.equal(parseCron("* 24 * * *"), null);
  assert.equal(parseCron("* * 0 * *"), null);
  assert.equal(parseCron("* * * 13 *"), null);
  assert.equal(parseCron("* * * * 8"), null);
  assert.equal(parseCron("* * * *"), null);
  assert.equal(parseCron("mon * * * *"), null);
  assert.equal(parseCron("*/0 * * * *"), null);
  assert.equal(parseCron("5-1 * * * *"), null);
  assert.equal(parseCron(""), null);
  assert.equal(parseCron(null), null);
});

test("TC-CR2 day and weekday OR only when both are restricted", () => {
  const both = parseCron("0 9 1 * 1");
  assert.equal(matchesCron(both, { month: 12, day: 1, weekday: 2, hour: 9, minute: 0 }), true);
  assert.equal(matchesCron(both, { month: 12, day: 7, weekday: 1, hour: 9, minute: 0 }), true);
  assert.equal(matchesCron(both, { month: 12, day: 2, weekday: 3, hour: 9, minute: 0 }), false);
  const dayOnly = parseCron("0 9 1 * *");
  assert.equal(matchesCron(dayOnly, { month: 12, day: 1, weekday: 2, hour: 9, minute: 0 }), true);
  assert.equal(matchesCron(dayOnly, { month: 12, day: 8, weekday: 1, hour: 9, minute: 0 }), false);
  const weekOnly = parseCron("0 9 * * 1");
  assert.equal(matchesCron(weekOnly, { month: 12, day: 8, weekday: 1, hour: 9, minute: 0 }), true);
  assert.equal(matchesCron(weekOnly, { month: 12, day: 1, weekday: 2, hour: 9, minute: 0 }), false);
  assert.equal(matchesCron(parseCron("0 9 * * 7"), { month: 12, day: 6, weekday: 0, hour: 9, minute: 0 }), true);
});

test("TC-CR3 the next match is strictly after the anchor, in Asia/Shanghai", () => {
  const daily = parseCron("0 13 * * *");
  assert.equal(cronNext(daily, at("2026-11-07T14:00:00+08:00")), at("2026-11-08T13:00:00+08:00"));
  assert.equal(cronNext(daily, at("2026-11-07T12:59:30+08:00")), at("2026-11-07T13:00:00+08:00"));
  assert.equal(cronNext(daily, at("2026-11-07T13:00:07+08:00")), at("2026-11-08T13:00:00+08:00"));
  assert.equal(cronNext(parseCron("*/15 * * * *"), at("2026-11-07T13:00:07+08:00")), at("2026-11-07T13:15:00+08:00"));
  assert.equal(cronNext(parseCron("30 9 * * 1-5"), at("2026-11-07T13:00:00+08:00")), at("2026-11-09T09:30:00+08:00"));
});

test("TC-CR4 month, year and leap-day boundaries are skipped correctly", () => {
  assert.equal(cronNext(parseCron("0 0 1 3 *"), at("2026-11-07T00:00:00+08:00")), at("2027-03-01T00:00:00+08:00"));
  assert.equal(cronNext(parseCron("0 0 29 2 *"), at("2026-03-01T00:00:00+08:00")), at("2028-02-29T00:00:00+08:00"));
  assert.equal(cronNext(parseCron("0 0 31 12 *"), at("2026-11-07T00:00:00+08:00")), at("2026-12-31T00:00:00+08:00"));
});

test("TC-CR5 an expression that never matches exhausts the horizon", () => {
  const never = cronNext(parseCron("0 0 30 2 *"), at("2026-11-07T00:00:00+08:00"));
  assert.equal(never, Number.POSITIVE_INFINITY);
  assert.equal(cronNext(parseCron("0 0 30 2 *"), at("2026-11-07T00:00:00+08:00"), CRON_HORIZON_MS), Number.POSITIVE_INFINITY);
  assert.equal(cronNext(null, at("2026-11-07T00:00:00+08:00")), Number.POSITIVE_INFINITY);
});

test("TC-CR6 local parts come from the relay time zone, not the process zone", () => {
  const parts = localParts(at("2026-11-07T05:00:00.000Z"));
  assert.equal(parts.hour, 13);
  assert.equal(parts.minute, 0);
  assert.equal(parts.day, 7);
  assert.equal(parts.weekday, 6);
});
