import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleLoopCommand, LOOP_ACTIONS } from "../src/cli.mjs";
import { LOOP_VERBS, loopHelp } from "../src/loops/help.mjs";

function makeConfig() {
  const dir = mkdtempSync(join(tmpdir(), "relay-loophelp-"));
  const configDir = join(dir, ".config/agent-relay");
  return {
    home: dir,
    cwd: dir,
    configDir,
    logDir: join(dir, "logs"),
    loopHistoryDir: join(configDir, "loops"),
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
    await handleLoopCommand(argv, config, () => {}, { sendCommand: dispatch, env: {} });
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
  const code = process.exitCode;
  process.exitCode = 0;
  return { code, out: out.join("") };
}

test("TC-LH1 the overview lists every subcommand plus the schedules, gates and exit codes", async () => {
  const config = makeConfig();
  const { code, out } = await run(["help"], config);
  assert.equal(code, 0);
  for (const { usage } of LOOP_VERBS) assert.ok(out.includes(usage), `missing usage: ${usage}`);
  assert.match(out, /schedules:/);
  assert.match(out, /every <dur>/);
  assert.match(out, /cron "<expr>"/);
  assert.match(out, /gates:/);
  assert.match(out, /每平台最多 20 条 loop/);
  assert.match(out, /exit:/);
  assert.match(out, /refused:<reason>/);
});

test("TC-LH2 a single verb prints only its own block", async () => {
  const config = makeConfig();
  const { code, out } = await run(["help", "create"], config);
  assert.equal(code, 0);
  assert.match(out, /create --platform/);
  assert.match(out, /--every <dur>/);
  assert.match(out, /--at <iso>/);
  assert.match(out, /--cron "<expr>"/);
  assert.match(out, /example:/);
  assert.doesNotMatch(out, /loop help \[<verb>\]/);
  assert.doesNotMatch(out, /schedules:/);
  const helpOnly = await run(["help", "help"], config);
  assert.equal(helpOnly.code, 0);
  assert.match(helpOnly.out, /loop help \[<verb>\]/);
  assert.doesNotMatch(helpOnly.out, /--cron/);
});

test("TC-LH3 the overview is a usage hint when no verb is given, and success when asked for", async () => {
  const config = makeConfig();
  assert.equal((await run([], config)).code, 2);
  assert.equal((await run(["help"], config)).code, 0);
  assert.equal((await run(["--help"], config)).code, 0);
  assert.equal((await run(["-h"], config)).code, 0);
});

test("TC-LH4 help never touches the daemon, the state file or an unknown verb", async () => {
  const config = makeConfig();
  const sent = [];
  const bogus = await run(["help", "bogus"], config, sent);
  assert.equal(bogus.code, 3);
  assert.match(bogus.out, /refused: unknown-verb/);
  const unknown = await run(["frobnicate", "loop-slack-1"], config, sent);
  assert.equal(unknown.code, 3);
  assert.match(unknown.out, /refused: unknown-verb/);
  assert.equal(sent.length, 0);
});

test("TC-LH5 the help table and the dispatch table hold the same verbs", () => {
  const helpVerbs = LOOP_VERBS.map((entry) => entry.verb).filter((verb) => verb !== "help");
  assert.deepEqual([...LOOP_ACTIONS].sort(), helpVerbs.sort());
  for (const verb of ["help", ...helpVerbs]) assert.ok(loopHelp(verb), `${verb} renders`);
  assert.equal(loopHelp("nope"), null);
  assert.match(loopHelp(), /agent-relay loop/);
});
