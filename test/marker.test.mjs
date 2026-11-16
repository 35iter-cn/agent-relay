import { test } from "node:test";
import assert from "node:assert/strict";
import { DELIVERY_MARKER, deliverBody } from "../src/shared/marker.mjs";

test("TC-MK1 output without a marker is delivered whole", () => {
  const raw = "review-fixer backend#1441 已推 735a067c\n  - 6 条改代码";
  assert.deepEqual(deliverBody(raw), { body: raw, marked: false });
});

test("TC-MK2 prose above the marker is dropped, the body below is kept", () => {
  const raw = "台账 20 条，六个 PR 全在等复审，没有新 review。\n<<<relay>>>\nNOOP";
  assert.deepEqual(deliverBody(raw), { body: "NOOP", marked: true });
});

test("TC-MK3 only the last marker counts", () => {
  const raw = "第一稿\n<<<relay>>>\n被推翻的正文\n<<<relay>>>\nNOOP";
  assert.deepEqual(deliverBody(raw), { body: "NOOP", marked: true });
});

test("TC-MK4 a marker line only counts when it stands alone", () => {
  const raw = "报告里写了 <<<relay>>> 这样的字符\n<<<relay>>\n后续";
  assert.deepEqual(deliverBody(raw), { body: raw, marked: false });
});

test("TC-MK5 an empty body after the marker degrades to the whole output", () => {
  const raw = "只剩过程文字\n<<<relay>>>\n ";
  assert.deepEqual(deliverBody(raw), { body: "只剩过程文字\n<<<relay>>>", marked: false });
});

test("TC-MK6 the marker is trimmed loosely and empty input stays empty", () => {
  assert.deepEqual(deliverBody(`  ${DELIVERY_MARKER}  \n正文`), { body: "正文", marked: true });
  assert.deepEqual(deliverBody(""), { body: "", marked: false });
  assert.deepEqual(deliverBody(undefined), { body: "", marked: false });
});
