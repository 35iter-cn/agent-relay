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

test("TC-LH1 the overview lists every verb plus flow, schedule, prompt, limits and exit", async () => {
  const config = makeConfig();
  const { code, out } = await run(["help"], config);
  assert.equal(code, 0);
  assert.equal(out.split("\n").filter((line) => line.startsWith("usage:")).length, 1, "one usage label");
  for (const { usage } of LOOP_VERBS) {
    const first = `  ${usage.split("\n")[0]}`;
    assert.ok(out.includes(first), `missing usage: ${first}`);
  }
  const blocks = await Promise.all(LOOP_VERBS.map(({ verb }) => run(["help", verb], config)));
  for (const [index, block] of blocks.entries()) assert.match(block.out, /^usage: /m, LOOP_VERBS[index].verb);
  for (const heading of ["flow:", "schedule:", "prompt:", "limits:", "exit:"]) assert.ok(out.includes(heading), heading);
  assert.match(out, /min hour dom mon dow/);
  assert.match(out, /skipped points are not caught up/);
  assert.match(out, /20 loops per platform/);
  assert.match(out, /refused:<reason>/);
  assert.doesNotMatch(out, /--every/);
  assert.doesNotMatch(out, /--at </);
  assert.doesNotMatch(out, /job start/);
  assert.doesNotMatch(out, /--to </);
  assert.doesNotMatch(out, /refused:stdin-is-tty|refused:name-taken|refused:too-many-loops|refused:prompt-file-not-canonical/);
});

test("TC-LH2 a single verb prints only its own block, with an example", async () => {
  const config = makeConfig();
  const { code, out } = await run(["help", "create"], config);
  assert.equal(code, 0);
  assert.match(out, /loop create --platform/);
  assert.match(out, /--prompt-file/);
  assert.match(out, /prompts\/loops\/<id>\/prompt\.md/);
  assert.match(out, /example:/);
  assert.doesNotMatch(out, /flow:/);
  assert.doesNotMatch(out, /20 loops per platform/);
  assert.doesNotMatch(out, /loop help \[<verb>\]/);
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

test("TC-LH5 the help table and the dispatch table hold the same verbs, each with an example", () => {
  const helpVerbs = LOOP_VERBS.map((entry) => entry.verb).filter((verb) => verb !== "help");
  assert.deepEqual([...LOOP_ACTIONS].sort(), helpVerbs.sort());
  for (const verb of ["help", ...helpVerbs]) {
    const block = loopHelp(verb);
    assert.ok(block, `${verb} renders`);
    assert.match(block, /^usage: /m);
    assert.match(block, /example:/, `${verb} carries an example`);
    for (const line of block.split("\n")) assert.ok(line.length <= 100, `${verb} ${line.length} cols: ${line}`);
  }
  assert.equal(loopHelp("nope"), null);
  assert.match(loopHelp(), /agent-relay loop/);
  assert.match(loopHelp(), /one prompt, one schedule/);
  assert.match(loopHelp(), /round whose whole text is NOOP/);
  assert.doesNotMatch(loopHelp(), /relay>>>|marker|QUIET_WORD/);
  assert.doesNotMatch(loopHelp("create"), /start at flow:/);
  for (const line of loopHelp().split("\n")) assert.ok(line.length <= 100, `${line.length} cols: ${line}`);
});
