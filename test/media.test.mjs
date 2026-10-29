import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractMedia, mediaHash } from "../src/jobs/media.mjs";

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "relay-media-"));
  return (name, bytes = "png-bytes") => {
    const path = join(dir, name);
    writeFileSync(path, bytes);
    return path;
  };
}

const ref = (path) => `![](${path})`;

test("TC-M1 a lone reference line between paragraphs is removed without leaving a blank line", () => {
  const make = sandbox();
  const png = make("a.png");
  const parsed = extractMedia(`第一段\n\n${ref(png)}\n\n第二段`);
  assert.equal(parsed.text, "第一段\n\n第二段");
  assert.deepEqual(parsed.files.map((file) => file.path), [png]);
});

test("TC-M2 a reference on the first line leaves no leading newline", () => {
  const make = sandbox();
  const png = make("a.png");
  assert.equal(extractMedia(`${ref(png)}\n标题正文`).text, "标题正文");
});

test("TC-M3 a reference on the last line leaves no trailing newline", () => {
  const make = sandbox();
  const png = make("a.png");
  assert.equal(extractMedia(`正文\n${ref(png)}`).text, "正文");
});

test("TC-M4 a reference between two list lines leaves the list adjacent", () => {
  const make = sandbox();
  const png = make("a.png");
  assert.equal(extractMedia(`• 第一\n${ref(png)}\n• 第二`).text, "• 第一\n• 第二");
});

test("TC-M5 a reference sharing a line with prose is left byte-for-byte alone", () => {
  const make = sandbox();
  const png = make("a.png");
  const answer = `见下图 ${ref(png)} 的红色部分`;
  const parsed = extractMedia(answer);
  assert.equal(parsed.text, answer);
  assert.deepEqual(parsed.files, []);
});

test("TC-M6 a relative path or an http reference on its own line is dropped and counted", () => {
  const make = sandbox();
  const png = make("a.png");
  const parsed = extractMedia(`结论\n![](./rel.png)\n![](https://example.com/x.png)\n${ref(png)}`);
  assert.equal(parsed.text, `结论\n（2 张图片引用无法读取，未发送）`);
  assert.deepEqual(parsed.files.map((file) => file.path), [png]);
});

test("TC-M7 an extension outside the image whitelist is dropped and counted", () => {
  const make = sandbox();
  const txt = make("notes.txt");
  const parsed = extractMedia(`结论\n${ref(txt)}`);
  assert.equal(parsed.text, `结论\n（1 张图片引用无法读取，未发送）`);
  assert.deepEqual(parsed.files, []);
});

test("TC-M8 a missing file is dropped and counted", () => {
  const parsed = extractMedia(`结论\n![](/nonexistent/relay-media.png)`);
  assert.equal(parsed.text, `结论\n（1 张图片引用无法读取，未发送）`);
});

test("TC-M9 a file over the byte limit is dropped and counted", () => {
  const make = sandbox();
  const png = make("big.png", "x".repeat(64));
  const parsed = extractMedia(`结论\n${ref(png)}`, { maxBytes: 10 });
  assert.equal(parsed.text, `结论\n（1 张图片引用无法读取，未发送）`);
  assert.deepEqual(parsed.files, []);
});

test("TC-M10 five references keep four and name the leftover in the text", () => {
  const make = sandbox();
  const paths = ["a", "b", "c", "d", "e"].map((name) => make(`${name}.png`));
  const parsed = extractMedia(`五个图\n${paths.map(ref).join("\n")}`);
  assert.equal(parsed.files.length, 4);
  assert.equal(parsed.dropped, 1);
  assert.equal(parsed.text, "五个图\n（还有 1 张图片未发送，单条回复最多 4 张）");
});

test("TC-M11 the media hash ignores order-irrelevant noise but follows size and mtime", () => {
  const make = sandbox();
  const png = make("a.png");
  const [file] = extractMedia(ref(png)).files;
  const first = mediaHash([file]);
  assert.equal(mediaHash([{ ...file }]), first);
  assert.notEqual(mediaHash([{ ...file, size: file.size + 1 }]), first);
  const later = new Date(Date.now() + 5_000);
  utimesSync(png, later, later);
  const [restat] = extractMedia(ref(png)).files;
  assert.notEqual(mediaHash([restat]), first);
});

test("TC-M12 an answer without references comes back unchanged", () => {
  const answer = "  \n第一段\n\n\n第二段  \n";
  const parsed = extractMedia(answer);
  assert.equal(parsed.text, answer);
  assert.deepEqual(parsed.files, []);
});
