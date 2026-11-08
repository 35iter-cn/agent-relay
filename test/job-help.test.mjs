import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleJobCommand, JOB_ACTIONS } from "../src/cli.mjs";
import { JOB_VERBS, jobHelp } from "../src/jobs/help.mjs";

function makeConfig() {
  const dir = mkdtempSync(join(tmpdir(), "relay-jobhelp-"));
  const configDir = join(dir, ".config/agent-relay");
  return {
    home: dir,
    cwd: dir,
    configDir,
    logDir: join(dir, "logs"),
    stateFile: (platform) => join(configDir, `relay-${platform}.json`),
    commandDir: (platform) => join(configDir, `relay-${platform}.cmd`),
  };
}

async function run(argv, config, sent = []) {
  const out = [];
  const write = (chunk) => (out.push(String(chunk)), true);
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  process.stdout.write = write;
  process.stderr.write = write;
  process.exitCode = 0;
  const dispatch = async (cfg, platform, command) => (sent.push({ platform, command }), { delivered: true });
  try {
    await handleJobCommand(argv, config, () => {}, { sendCommand: dispatch, env: {} });
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
  const code = process.exitCode;
  process.exitCode = 0;
  return { code, out: out.join("") };
}

test("TC-JH1 the job overview lists start, cancel and list with the timing rules", async () => {
  const config = makeConfig();
  const { code, out } = await run(["help"], config);
  assert.equal(code, 0);
  for (const { usage } of JOB_VERBS) assert.ok(out.includes(usage), `missing usage: ${usage}`);
  assert.match(out, /--in <dur>/);
  assert.match(out, /--at <iso>/);
  assert.match(out, /--grace <dur>/);
  assert.match(out, /limits:/);
  assert.match(out, /RUNAWAY_PER_HOUR/);
  assert.match(out, /exit:/);
});

test("TC-JH2 a single verb prints only its own block, with an example", async () => {
  const config = makeConfig();
  const { code, out } = await run(["help", "start"], config);
  assert.equal(code, 0);
  assert.match(out, /job start --platform/);
  assert.match(out, /--dedupe/);
  assert.match(out, /example:/);
  assert.doesNotMatch(out, /job cancel --platform/);
  assert.doesNotMatch(out, /limits:/);
});

test("TC-JH3 bare job is a usage hint, help is a success and an unknown verb is refused", async () => {
  const config = makeConfig();
  const sent = [];
  assert.equal((await run([], config, sent)).code, 2);
  assert.equal((await run(["--help"], config, sent)).code, 0);
  assert.equal((await run(["help", "list"], config, sent)).code, 0);
  const bogus = await run(["help", "bogus"], config, sent);
  assert.equal(bogus.code, 3);
  assert.match(bogus.out, /refused: unknown-verb/);
  const unknown = await run(["frobnicate", "--platform", "slack"], config, sent);
  assert.equal(unknown.code, 3);
  assert.match(unknown.out, /refused: unknown-verb/);
  assert.equal(sent.length, 0);
});

test("TC-JH4 the job help table and the dispatch table hold the same verbs", () => {
  const helpVerbs = JOB_VERBS.map((entry) => entry.verb).filter((verb) => verb !== "help");
  assert.deepEqual([...JOB_ACTIONS].sort(), helpVerbs.sort());
  for (const verb of ["help", ...helpVerbs]) assert.ok(jobHelp(verb), `${verb} renders`);
  assert.equal(jobHelp("nope"), null);
  assert.match(jobHelp(), /模型读这三行就够/);
  assert.match(jobHelp(), /没有静默这回事/);
  assert.doesNotMatch(jobHelp("start"), /模型读这三行就够/);
});

function stateWith(jobs) {
  const config = makeConfig();
  mkdirSync(config.configDir, { recursive: true });
  writeFileSync(config.stateFile("slack"), JSON.stringify({ jobs }));
  return config;
}

test("TC-RD3 redeliver sends the failed job id to the daemon and reports it", async () => {
  const config = stateWith({
    "job-9": { id: "job-9", key: "th-abc", status: "failed", error: "reply-failed", answer: "答案", updatedAt: "2026-11-08T12:36:14.000Z" },
  });
  const sent = [];
  const { code, out } = await run(["redeliver", "--platform", "slack", "th-abc"], config, sent);
  assert.equal(code, 0);
  assert.match(out, /redelivered/);
  assert.deepEqual(sent, [{ platform: "slack", command: { op: "redeliver", job: "job-9", key: "th-abc" } }]);
});

test("TC-RD3b a job id may be given instead of the conversation key", async () => {
  const config = stateWith({
    "job-9": { id: "job-9", key: "th-abc", status: "failed", answer: "答案", updatedAt: "2026-11-08T12:36:14.000Z" },
  });
  const sent = [];
  const { code } = await run(["redeliver", "--platform", "slack", "job-9"], config, sent);
  assert.equal(code, 0);
  assert.equal(sent[0].command.job, "job-9");
});

test("TC-RD4 nothing to resend is refused before the daemon is touched", async () => {
  const config = stateWith({
    "job-9": { id: "job-9", key: "th-abc", status: "done", updatedAt: "2026-11-08T12:36:14.000Z" },
  });
  const sent = [];
  const { code, out } = await run(["redeliver", "--platform", "slack", "th-abc"], config, sent);
  assert.equal(code, 3);
  assert.match(out, /refused: nothing-to-redeliver/);
  assert.equal(sent.length, 0);
});
