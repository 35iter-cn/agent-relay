# AGENTS.md

Conventions for anyone — human or agent — changing this repository. Read
`README.md` first: its **Design rules** section is the architecture contract and
is not repeated here.

## Non-negotiables

- **Never commit to `main` directly.** Branch, push, open a PR, squash-merge.
- **No secrets, no deployment identifiers in the sources.** Platform ids, channels,
  tenant or host names live in `~/.config/agent-relay/`.
- **`bun test` green before a push.** `bun run e2e` green when the change touches
  stall handling, termination, or the usage recorder.
- **The ledger is not ours.** Relay decides which job runs when and how it stops.
  Agent-hours rows are written by the pi extension and the agent-hours service.

## Workflow

Branch by intent: `fix/<topic>`, `feat/<topic>`, `docs/<topic>`, `chore/<topic>`.

Commit subjects are Conventional Commits, in English, scoped to the module:

```
fix(core): a stalled cancel bills to the last progress, not to the notice
feat(usage): let a caller close the run at a cutoff instead of the clock
refactor(jobs)!: a lease is pid identity, not a heartbeat
```

`!` marks a breaking change to the state schema, the CLI surface or the prompt
contract. One commit per decision, not per file touched.

A PR body carries four things: the problem, the change, the test evidence
(`bun test` counts, `bun run e2e` result), and the deployment step. Squash-merge;
the merge commit is the release record.

## Code

- **No comments.** Names and structure carry the intent; a comment usually means an
  extraction is missing.
- **Platform code holds no cross-call state.** Conversations arrive through `ctx`;
  an adapter translates protocol and nothing else.
- **The runtime never names a platform.** Differences live in
  `src/platforms/<name>.mjs`, shared behaviour in `src/platforms/shared/`.
- **Source defaults are production values.** A knob that needs a different value in
  production becomes an `AGENT_RELAY_*` variable — not a code edit, not a systemd
  drop-in.
- **A test-only hook is an env variable with the production default.** Anything
  added so a test can run faster or deterministically (for example
  `AGENT_RELAY_STALL_CHECK_MS`) keeps the production value as its default.

## Tests

`bun test` runs `test/<module>.test.mjs`, one file per module. Name cases
`TC-<group><n>` — `TC-ST16` for stall, `TC-U15` for usage. Ids are stable and get
reused in PR notes; never renumber them.

Assert the behaviour, not the existence. When a fix involves a number a user will
see, assert that number. A case that would also pass on the broken code proves
nothing.

`bun run e2e` runs `test/e2e/*.e2e.mjs`: real child processes, real state, event
and usage files, real command queue — only the IM delivery is faked. It is not
part of `bun test`, because it takes seconds instead of milliseconds.

## Deploying

Code changes do nothing until the daemon restarts:

```bash
git -C ~/code/agent-relay pull --ff-only
agent-relay-upgrade <feishu|slack|telegram>
```

The script waits for in-flight jobs to drain, then restarts the unit and verifies
a changed `MainPID`. It is safe to start from inside a relay session — it detaches
itself with `systemd-run`. Restarting `slack` kills the session that ran the
upgrade; that is expected, so make sure the reply goes out first.

## Where things live

| Path | What |
| --- | --- |
| `src/runtime/core.mjs` | job lifecycle, stall detection, termination, delivery |
| `src/runtime/usage.mjs` | usage rows under `logs/<platform>/<day>.jsonl` |
| `src/jobs/` | job model, leases, delivery planning, session signals |
| `src/platforms/` | one adapter per IM platform |
| `src/prompts/` | prompt templates; a same-named file under `~/.config/agent-relay/prompts/` wins |
| `src/state/`, `src/notices/` | state schema + atomic store, replyable notices |
