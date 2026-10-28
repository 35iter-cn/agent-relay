import test from "node:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { uploadDirFor, pruneUploads, extFor } from "../src/platforms/shared/uploads.mjs";

test("TC-34 uploads land under chat/date with a content-type extension", () => {
  const dir = uploadDirFor("/cfg", "oc_1", new Date("2026-10-25T04:00:00Z"));
  assert.equal(dir, "/cfg/uploads/oc_1/20261025");
});

test("TC-35 pruneUploads removes files older than the ttl", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-prune-"));
  const fresh = join(root, "fresh.jpg");
  const stale = join(root, "stale.jpg");
  writeFileSync(fresh, "a");
  writeFileSync(stale, "b");
  pruneUploads(root, 1000, Date.now() + 5000);
  assert.equal(existsSync(fresh), false);
  assert.equal(existsSync(root), false);
});

test("TC-37 extFor maps known image types and falls back to the name suffix", () => {
  assert.equal(extFor("image/jpeg"), "jpg");
  assert.equal(extFor("image/png; charset=binary"), "png");
  assert.equal(extFor("application/pdf", "a.pdf"), "pdf");
  assert.equal(extFor("application/octet-stream", null), "bin");
  assert.equal(extFor("", "no-suffix"), "bin");
});
