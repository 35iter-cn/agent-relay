import test from "node:test";
import assert from "node:assert/strict";
import { flattenTables, normalizeSlackMarkdown, splitTables } from "../src/shared/markdown.mjs";

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

test("TC-MD6 a table is split into its own segment with the header as the first row", () => {
  const input = ["说明", "", "| 字段 | 值 |", "| --- | --- |", "| 协议 | UDP |", "| 端口 | 41641 |", "", "收尾"].join("\n");
  assert.deepEqual(splitTables(input), [
    { type: "text", text: "说明" },
    { type: "table", rows: [["字段", "值"], ["协议", "UDP"], ["端口", "41641"]] },
    { type: "text", text: "收尾" },
  ]);
});

test("TC-MD7 a fenced table stays inside its text segment", () => {
  const input = ["```", "| a | b |", "| --- | --- |", "```"].join("\n");
  assert.deepEqual(splitTables(input), [{ type: "text", text: input }]);
});

test("TC-MD8 slack normalization repairs the two things the renderer requires", () => {
  assert.equal(normalizeSlackMarkdown("上文\n| a | b |\n|---|---|\n| 1 | 2 |"), "上文\n\n| a | b |\n|---|---|\n| 1 | 2 |");
  assert.equal(normalizeSlackMarkdown("| a | b |\n|---|---|"), "| a | b |\n|---|---|", "a table on the first line needs no blank line");
  assert.equal(normalizeSlackMarkdown("```\n| a | b |\n|---|---|\nhttps://skip.me\n```"), "```\n| a | b |\n|---|---|\nhttps://skip.me\n```", "a fence is opaque");
  assert.equal(normalizeSlackMarkdown("[已有](https://z.com)"), "[已有](https://z.com)");
  assert.equal(normalizeSlackMarkdown("`https://a.com`"), "`https://a.com`");
  assert.equal(normalizeSlackMarkdown("见 https://a.com/x)"), "见 [https://a.com/x](https://a.com/x))");
  assert.equal(normalizeSlackMarkdown("见 https://a.com/x. 然后"), "见 [https://a.com/x](https://a.com/x). 然后");
  assert.equal(normalizeSlackMarkdown("https://a.com/(x)"), "[https://a.com/(x)](https://a.com/(x))");
});
