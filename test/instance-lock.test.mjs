import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireInstanceLock, isProcessAlive, lockFileFor } from "../src/runtime/instance-lock.mjs";

function dir() {
  return mkdtempSync(join(tmpdir(), "relay-lock-"));
}

test("the first instance takes the lock and writes its pid", () => {
  const base = dir();
  const lock = acquireInstanceLock({ dir: base, platform: "slack", pid: 4242 });
  assert.ok(lock);
  assert.equal(lock.file, join(base, "serve-slack.pid"));
  assert.equal(readFileSync(lock.file, "utf8"), "4242\n");
  assert.equal(statSync(lock.file).mode & 0o777, 0o600);
  assert.equal(statSync(base).mode & 0o777, 0o700);
});

test("a live holder blocks a second instance", () => {
  const base = dir();
  assert.ok(acquireInstanceLock({ dir: base, platform: "slack", pid: 4242, alive: () => true }));
  assert.equal(acquireInstanceLock({ dir: base, platform: "slack", pid: 5151, alive: () => true }), null);
});

test("a stale pid file is reclaimed", () => {
  const base = dir();
  writeFileSync(lockFileFor(base, "feishu"), "999999\n");
  const lock = acquireInstanceLock({ dir: base, platform: "feishu", pid: 5151, alive: () => false });
  assert.ok(lock);
  assert.equal(readFileSync(lock.file, "utf8"), "5151\n");
});

test("locks are per platform and released cleanly", () => {
  const base = dir();
  const slack = acquireInstanceLock({ dir: base, platform: "slack", pid: 4242, alive: () => true });
  const feishu = acquireInstanceLock({ dir: base, platform: "feishu", pid: 4242, alive: () => true });
  assert.ok(slack && feishu);
  slack.release();
  assert.equal(existsSync(slack.file), false);
  assert.ok(acquireInstanceLock({ dir: base, platform: "slack", pid: 7777, alive: () => true }));
});

test("the default liveness probe treats missing and own pids correctly", () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(999999), false);
  assert.equal(isProcessAlive(0), false);
});
