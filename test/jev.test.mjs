import test from "node:test";
import assert from "node:assert/strict";
import { createJev } from "../src/judgment/jev.mjs";

const criteria = { a: "选项一", b: "选项二" };

function answer(choice, confidence) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ answers: { choice: { type: "choice", choice, confidence, probabilities: { [choice]: confidence } } } }),
  };
}

function harness(fetchImpl, extra = {}) {
  const logs = [];
  const calls = [];
  const sleeps = [];
  const jev = createJev({
    env: { JEV_API_KEY: "k", ...extra.env },
    fetchImpl: async (...args) => {
      calls.push(args);
      return fetchImpl(...args);
    },
    log: (level, tag, record) => logs.push({ level, tag, record }),
    now: extra.now,
    timeoutMs: extra.timeoutMs ?? 50,
    sleep: extra.sleep ?? ((ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    }),
    random: extra.random ?? (() => 0.5),
    base: "https://jev.test",
    model: "typesafe/jev",
  });
  return { jev, logs, calls, sleeps };
}

test("TC-J1 no key returns nokey without calling fetch", async () => {
  const { jev, calls, logs } = harness(async () => answer("a", 0.9), { env: { JEV_API_KEY: "" } });
  const result = await jev.judgeChoice({ id: "x", state: "s", instructions: "i", criteria });
  assert.equal(result.choice, null);
  assert.equal(result.fallback, "nokey");
  assert.equal(calls.length, 0);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].record.event, "jev");
});

test("TC-J2 high confidence choice is returned with probabilities", async () => {
  const { jev, logs } = harness(async () => answer("candidate_rules", 0.97));
  const result = await jev.judgeChoice({ id: "prompt-variant", state: "s", instructions: "i", criteria });
  assert.equal(result.choice, "candidate_rules");
  assert.equal(result.confidence, 0.97);
  assert.equal(result.fallback, null);
  assert.equal(logs[0].record.choice, "candidate_rules");
});

test("TC-J3 low confidence yields null choice and low-confidence fallback", async () => {
  const { jev } = harness(async () => answer("a", 0.4));
  const result = await jev.judgeChoice({ id: "x", state: "s", instructions: "i", criteria });
  assert.equal(result.choice, null);
  assert.equal(result.confidence, 0.4);
  assert.equal(result.fallback, "low-confidence");
});

test("TC-J4 abort retries twice then reports timeout", async () => {
  let calls = 0;
  const hanging = (url, init) => {
    calls += 1;
    return new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    });
  };
  const { jev, logs } = harness(hanging, { timeoutMs: 20 });
  const result = await jev.judgeChoice({ id: "x", state: "s", instructions: "i", criteria });
  assert.equal(result.fallback, "timeout");
  assert.equal(calls, 3);
  assert.equal(result.attempts, 3);
  assert.equal(logs[0].record.attempts, 3);
});

test("TC-J5 network error retries twice before failing", async () => {
  let calls = 0;
  const { jev } = harness(async () => {
    calls += 1;
    throw new Error("boom");
  });
  const result = await jev.judgeChoice({ id: "x", state: "s", instructions: "i", criteria });
  assert.equal(result.fallback, "error");
  assert.equal(calls, 3);
});

test("TC-J6 5xx retries twice then falls back to error", async () => {
  let calls = 0;
  const { jev } = harness(async () => {
    calls += 1;
    return { ok: false, status: 503, text: async () => "down" };
  });
  const result = await jev.judgeChoice({ id: "x", state: "s", instructions: "i", criteria });
  assert.equal(result.fallback, "error");
  assert.equal(calls, 3);
});

test("TC-J7 429 is not retried", async () => {
  let calls = 0;
  const { jev } = harness(async () => {
    calls += 1;
    return { ok: false, status: 429, text: async () => "slow down" };
  });
  const result = await jev.judgeChoice({ id: "x", state: "s", instructions: "i", criteria });
  assert.equal(result.fallback, "http_429");
  assert.equal(calls, 1);
});

test("TC-J8 circuit opens after three failures and stops calling fetch", async () => {
  let calls = 0;
  const { jev } = harness(async () => {
    calls += 1;
    return { ok: false, status: 429, text: async () => "slow down" };
  });
  for (let i = 0; i < 3; i += 1) await jev.judgeChoice({ id: `x${i}`, state: `s${i}`, instructions: "i", criteria });
  const callsBefore = calls;
  const result = await jev.judgeChoice({ id: "x-last", state: "s-last", instructions: "i", criteria });
  assert.equal(result.fallback, "circuit");
  assert.equal(calls, callsBefore);
});

test("TC-J9 identical state and criteria hit the cache", async () => {
  let calls = 0;
  const { jev, logs } = harness(async () => {
    calls += 1;
    return answer("a", 0.9);
  });
  await jev.judgeChoice({ id: "x", state: "same", instructions: "i", criteria });
  await jev.judgeChoice({ id: "x", state: "same", instructions: "i", criteria });
  assert.equal(calls, 1);
  assert.equal(logs.length, 2);
});

test("TC-J11 backoff doubles from 500ms with jitter", async () => {
  const { jev, sleeps } = harness(async () => {
    throw new Error("boom");
  });
  await jev.judgeChoice({ id: "x", state: "s", instructions: "i", criteria });
  assert.deepEqual(sleeps, [500, 1000]);
});

test("TC-J12 a retry that succeeds clears the fallback", async () => {
  let calls = 0;
  const { jev, sleeps } = harness(async () => {
    calls += 1;
    if (calls < 3) return { ok: false, status: 503, text: async () => "down" };
    return answer("a", 0.92);
  });
  const result = await jev.judgeChoice({ id: "x", state: "s", instructions: "i", criteria });
  assert.equal(result.fallback, null);
  assert.equal(result.choice, "a");
  assert.equal(result.attempts, 3);
  assert.deepEqual(sleeps, [500, 1000]);
});

test("TC-J10 judgeScore reads the noul answer", async () => {
  const { jev } = harness(async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ answers: { score: { type: "noul", noul: 0.72 } } }),
  }));
  const result = await jev.judgeScore({ id: "x", state: "s", instructions: "i" });
  assert.equal(result.score, 0.72);
  assert.equal(result.fallback, null);
});
