# AGENTS.md

Conventions for anyone — human or agent — changing this repository. Read
`README.md` first: its **Design rules** section is the architecture contract and
is not repeated here.

## Non-negotiables

- **Never commit to `main` directly.** Branch, push, open a PR, squash-merge.
- **No secrets, no deployment identifiers in the sources.** Platform ids, channels,
  tenant or host names live in `~/.config/agent-relay/`.
- **Configuration is the config file's job.** A new knob is a key in `config.json` — a
  default under `relay` in `src/config.mjs` when it needs a default — and never an
  environment variable. The only environment variables are process identity: `HOME`,
  `AGENT_RELAY_CONFIG_DIR`, `AGENT_RELAY_WORKDIR`, `AGENT_RELAY_SESSIONS_DIR`,
  `AGENT_RELAY_PLATFORM`, and the per-turn `AGENT_RELAY_KEY` / `AGENT_RELAY_SELF_CHAIN`,
  because the config file cannot say where it lives. The README's config tables are the
  inventory; a new key lands there in the same commit.
- **`bun test` green before a push.** `bun run e2e` green when the change touches
  stall handling or termination.

- **Anything the relay says on its own initiative goes through the notice entry**, and the notice says how a reply is handled: `reply: { mode: "conversation", key }` continues that conversation's session, everything else (`mode: "prompt"`, or no binding at all) keeps the `notice-<id>` behaviour. A loop round is a bound notice — delivering it any other way either loses the reply binding or hands the reply to the wrong session. A reply that arrives while that session's turn is still running interjects it: the bound reply steers, with a receipt, instead of queueing a second job behind the turn it is meant to interrupt.
- **A notice names its group.** The group table is configuration (`config.json`),
  never a constant in the sources; a group that is not configured falls back to
  `defaultGroup` with one warning instead of dropping the notice.
- **Notices are not pruned, and a bound notice carries no payload.** `emit` stores `text`/`prompt` only for prompt-mode notices; a bound one keeps `{messageId, reply}` alone, because the state file is rewritten on every job change and the body already exists elsewhere.

## Tests

`bun test` runs `test/<module>.test.mjs`, one file per module. Name cases
`TC-<group><n>` — `TC-ST16` for stall, `TC-V3` for prompt variants, `TC-LP<n>` /
`TC-LR<n>` / `TC-LC<n>` for loop records, loop rounds and the loop CLI. Ids are stable and get
reused in PR notes; never renumber them.

Assert the behaviour, not the existence. When a fix involves a number a user will
see, assert that number. A case that would also pass on the broken code proves
nothing.

`test/fixtures/rpc-stub.mjs` is the in-process worker double for unit tests;
`test/fixtures/rpc-hold.mjs` is the real child the e2e suites spawn. Both speak the
RPC surface, because RPC is the only worker mode.

`bun run e2e` runs `test/e2e/*.e2e.mjs`: real child processes, real state, event
and event files, real command queue — only the IM delivery is faked. It is not
part of `bun test`, because it takes seconds instead of milliseconds.

- **The first-turn prompt has a budget** (`test/prompts.test.mjs` `FIRST_TURN_PROMPT_BUDGET`). Adding a capability the model must know about means raising the number on purpose and saying why in the PR, never letting the guard be the thing that decides.
- **A rule the relay can enforce belongs in code.** Formatting the renderer requires, a retry, a fallback — if a function can do it, the model should not be asked to remember it. A new prompt line means deleting one, and the prompt budget in `test/prompts.test.mjs` caps what the model is asked to carry.
- **Only the rule that has an exact answer is enforced.** Where a judgement would need a guess — which line is the message, which lines are working notes — the prompt carries the instruction and the kernel stays out of it; `NOOP` is enforced precisely because a whole body either is that word or is not.

## Deploying

Code changes do nothing until the daemon restarts:

```bash
git -C ~/code/agent-relay pull --ff-only
agent-relay restart
```

`agent-relay restart` sends one request to every platform; each daemon waits until it
has nothing queued or running, so the turn that asked for the restart finishes first.
`--wait 0` waits with no deadline; a second request replaces the first. The restart
itself kills that platform's sessions, new messages included, until it is back.

## Where things live

| Path | What |
| --- | --- |
| `src/runtime/core.mjs` | job lifecycle, stall detection, termination, delivery |
| `src/jobs/` | job model, leases, delivery planning, session signals |
| `src/platforms/` | one adapter per IM platform |
| `src/prompts/` | prompt templates; a same-named file under `~/.config/agent-relay/prompts/` wins |
| `src/state/`, `src/notices/` | state schema + atomic store, replyable notices |
| External binaries | Called by name from `PATH` (`pi`, `agent-relay`); the systemd user environment (`~/.config/environment.d/`) owns `PATH`, so neither the unit nor the sources set it |
