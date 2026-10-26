import test from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { definePlatform, isPlatform, PLATFORMS } from "../src/platforms/contract.mjs";

test("three platforms are registered", () => {
  assert.deepEqual(PLATFORMS, ["feishu", "slack", "telegram"]);
  assert.equal(isPlatform("slack"), true);
  assert.equal(isPlatform("matrix"), false);
});

test("a platform without the required surface is rejected", () => {
  assert.throws(() => definePlatform({ name: "feishu", start: () => {} }), /reply:function/);
  assert.throws(() => definePlatform({ name: "unknown", start: () => {}, reply: () => {}, sessionFor: () => "" }), /unknown platform/);
  assert.throws(() => definePlatform(null), /platform contract violated/);
});

test("a complete platform passes and is returned as-is", () => {
  const platform = { name: "slack", start: () => {}, reply: () => {}, sessionFor: () => "", postNotice: () => {} };
  assert.equal(definePlatform(platform), platform);
});

test("TC-28 adapters keep no cross-call reply state", () => {
  for (const name of ["feishu", "slack", "telegram"]) {
    const source = readFileSync(new URL(`../src/platforms/${name}.mjs`, import.meta.url), "utf8");
    if (name === "feishu") assert.ok(source.includes("defaultClientFactory"));
    assert.doesNotMatch(source, /new WeakMap\(\)/, `${name} must not hold a WeakMap across calls`);
  }
});
