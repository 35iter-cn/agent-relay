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
