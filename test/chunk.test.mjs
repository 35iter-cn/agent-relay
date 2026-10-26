import test from "node:test";
import assert from "node:assert/strict";
import { chunkText } from "../src/shared/chunk.mjs";

test("empty input yields a single empty chunk", () => {
  assert.deepEqual(chunkText("", 10), [""]);
  assert.deepEqual(chunkText(null, 10), [""]);
});

test("text under the limit is returned unchanged", () => {
  assert.deepEqual(chunkText("hello", 10), ["hello"]);
});

test("text exactly at the limit is one chunk", () => {
  const text = "x".repeat(10);
  assert.deepEqual(chunkText(text, 10), [text]);
});

test("one character over the limit splits into two chunks", () => {
  const chunks = chunkText("x".repeat(11), 10);
  assert.deepEqual(chunks, ["x".repeat(10), "x"]);
});

test("multi-line text is split on line boundaries", () => {
  const text = ["aaaa", "bbbb", "cccc"].join("\n");
  assert.deepEqual(chunkText(text, 10), ["aaaa\nbbbb", "cccc"]);
});

test("a single line longer than the limit is hard-split", () => {
  const text = `head\n${"y".repeat(25)}`;
  const chunks = chunkText(text, 10);
  assert.deepEqual(chunks, ["head", "y".repeat(10), "y".repeat(10), "yyyyy"]);
  assert.equal(chunks.join(""), "head" + "y".repeat(25));
});

test("carriage returns stay with their line", () => {
  const chunks = chunkText("aaaa\r\nbbbb", 6);
  assert.deepEqual(chunks, ["aaaa\r", "bbbb"]);
});

test("cjk and emoji count as single characters", () => {
  const text = "汉".repeat(5) + "🙂".repeat(5);
  const chunks = chunkText(text, 5);
  assert.deepEqual(chunks, ["汉".repeat(5), "🙂".repeat(5)]);
});

test("every chunk respects the limit", () => {
  const text = Array.from({ length: 40 }, (_, i) => `line-${i} ${"z".repeat(i)}`).join("\n");
  for (const limit of [12, 40, 200]) {
    for (const chunk of chunkText(text, limit)) {
      assert.ok([...chunk].length <= limit, `chunk of ${[...chunk].length} exceeds ${limit}`);
    }
  }
});

test("invalid limits are rejected", () => {
  assert.throws(() => chunkText("x", 0), /invalid chunk limit/);
  assert.throws(() => chunkText("x", -1), /invalid chunk limit/);
});
