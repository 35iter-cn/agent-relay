import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendDailyJsonl } from "../src/shared/log.mjs";
import { writeJsonAtomic } from "../src/shared/json.mjs";
import { ensurePrivateDir } from "../src/shared/fs.mjs";
import { createPrompts } from "../src/runtime/prompts.mjs";

const ROOT = join(import.meta.dirname, "..");
const SCAN = [join(ROOT, "src"), join(ROOT, "test"), join(ROOT, "scripts"), join(ROOT, "examples")];

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

test("no platform id, tenant name or private host leaks into the sources", () => {
  const patterns = [
    /ou_[0-9a-f]{16,}/,
    /\b[UC]0[A-Z0-9]{8,}\b/,
    /MagicDoor/,
    /\.magicdoor\.io/,
  ];
  const offenders = [];
  const self = join(ROOT, "test", "privacy.test.mjs");
  for (const file of SCAN.filter(existsSync).flatMap(walk)) {
    if (file === self) continue;
    if (!/\.(mjs|md|json)$/.test(file)) continue;
    const text = readFileSync(file, "utf8");
    for (const pattern of patterns) {
      if (pattern.test(text)) offenders.push(`${file} matches ${pattern}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("the state file is written 0600 inside a 0700 directory", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "relay-private-")), "nested");
  const file = join(dir, "relay-feishu.json");
  writeJsonAtomic(file, { a: 1 });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test("ensurePrivateDir tightens an existing loose directory", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "relay-private-")), "loose");
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  ensurePrivateDir(dir);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test("jsonl event logs are created 0600", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-private-"));
  appendDailyJsonl(dir, { event: "x" }, { now: () => Date.parse("2026-10-26T12:00:00Z") });
  const [name] = readdirSync(dir);
  assert.equal(statSync(join(dir, name)).mode & 0o777, 0o600);
});

test("user prompt files override the built-in ones without touching the repo", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-private-"));
  const userDir = join(dir, "prompts");
  mkdirSync(userDir, { recursive: true });
  writeFileSync(join(userDir, "thread.md"), "USER-OVERRIDE {{user_message}}");
  const prompts = createPrompts({ dir: join(ROOT, "src", "prompts"), userDir });
  assert.equal(prompts.read("thread.md"), "USER-OVERRIDE {{user_message}}");
  assert.match(prompts.read("notice.md"), /\{\{notice_id\}\}/);
});
