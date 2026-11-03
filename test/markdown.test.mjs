import test from "node:test";
import assert from "node:assert/strict";
import { flattenTables } from "../src/shared/markdown.mjs";

test("TC-MD1 a github table becomes a bullet per data row", () => {
  const input = ["| 字段 | 值 |", "| --- | --- |", "| 协议 | UDP |", "| 外部端口 | 41641 |", "", "保存即可。"].join("\n");
  assert.equal(flattenTables(input), ["- **协议**：UDP", "- **外部端口**：41641", "", "保存即可。"].join("\n"));
});

test("TC-MD2 three columns keep their order and drop the header", () => {
  const input = ["a | b | c", "--- | --- | ---", "1 | 2 | 3"].join("\n");
  assert.equal(flattenTables(input), "- **1**：2 · 3");
});

test("TC-MD3 text around the table survives verbatim", () => {
  const input = ["进去后：应用 → 高级NAT设置", "", "|字段|值|", "|:---|:---:|", "|协议|UDP|", "", "- 第一条"].join("\n");
  assert.equal(flattenTables(input), ["进去后：应用 → 高级NAT设置", "", "- **协议**：UDP", "", "- 第一条"].join("\n"));
});

test("TC-MD4 a fence keeps its pipes untouched", () => {
  const input = ["```", "| 字段 | 值 |", "| --- | --- |", "| a | b |", "```"].join("\n");
  assert.equal(flattenTables(input), input);
});

test("TC-MD5 a pipe line without a separator is not a table", () => {
  const input = ["a | b", "c | d"].join("\n");
  assert.equal(flattenTables(input), input);
  assert.equal(flattenTables("no pipes here"), "no pipes here");
  assert.equal(flattenTables(""), "");
});
