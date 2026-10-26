# agent-relay

Multi-platform IM relay daemon for coding agents.

One long-running process per IM platform bridges conversations to agent sessions
(pi today, other harnesses later): it queues work, streams chunked replies back,
detects stalled runs, and posts **notices** that users can reply to.

```
user message ──▶ platform adapter ──▶ relay core ──▶ agent session (pi --print)
                        ▲                  │
                        │                  ├─ job queue, leases, timeouts
                        └── chunked reply ─┘  stall watchdog, usage ledger
```

## Replyable notices

Anything the relay posts on its own initiative is a **notice**, and every notice
has the same two fields:

- `text` — what the users sees in the chat (the stall alert, the intake
  broadcast, the hours report, the boot line)
- `prompt` — optional instructions injected into the session that opens when the
  user replies to that notice: what to do, which job key it belongs to, which
  command to run

A notice has no kind, no actions and no refs. The relay records it in the
platform state file together with the message id it was posted as; when the user
replies, the adapter reports the parent message id, the relay resolves it back to
the notice and opens a session scoped to it (`notice-ntc-12`). The fixed
`prompts/notice.md` template then renders just `text`, `prompt` and the platform
reply rules.

That means:

- adding a new notification type is a change in the sender, not in this repo:
  `agent-relay notice emit --platform feishu --text "$(…)" --prompt-file …`
- the policy for acting on a notice lives in that `prompt`; the relay itself only
  knows `agent-relay stall <platform> cancel|restart <key>`, and that entry
  point validates its own arguments
- the notice body is data, not instructions — `notice.md` says so, because the
  text can carry third-party content (issue titles, chat excerpts)

The stall alert is the one notice the relay raises by itself; it builds both
fields in `src/runtime/stall-notice.mjs`.

## Structure

```
src/
├── cli.mjs                 entry: serve | notice | notify | stall
├── config.mjs              paths, env files, state/command locations
├── shared/                 chunking, json, time, logging, retention, prompts, env
├── state/                  state schema + atomic store
├── jobs/                   job model, leases, delivery plan, worker signals, next action
├── runtime/                core loop, prompts, stall notice, usage recorder
├── notices/                notice service (emit / match / prune)
├── ledger/                 agent-hours heartbeat + salvage (read/write the ledger)
├── prompts/                prompt templates (thread, notice, stall fragments)
└── platforms/              feishu | slack | telegram adapters + shared helpers
```

Design rules:

- **Platform code never holds cross-call state.** Conversations live in the job
  and arrive via `ctx`; the adapter only translates protocol.
- **Runtime never mentions a platform by name.** Differences live in
  `src/platforms/<name>.mjs`; shared behaviour (root-text cache, conversation
  pruning) lives in `src/platforms/shared/`.
- **User-initiated versus relay-initiated** is the split between `thread.md`
  (replies in a conversation) and `notice.md` (replies to a notice).

## Platforms

| platform | transport | reply identity |
| --- | --- | --- |
| feishu | Lark WS long connection | `parent_id` / `root_id` |
| slack | Socket Mode | `thread_ts` |
| telegram | long polling | `reply_to_message.message_id` / topic id |

Adapter contract (`src/platforms/contract.mjs`): `name`, `start`, `reply`,
`sessionFor` are required; `postNotice`, `edit`, `onProgress`, `onProgressDone`,
`buildWorker` are optional. `postNotice` must be callable before `start()` so the
CLI can emit notices without a running daemon.

## Run

```bash
bun scripts/install.mjs            # link agent-relay into ~/.local/bin
bun scripts/install.mjs --systemd  # also link the systemd template unit
agent-relay serve feishu
```

Configuration lives in `~/.config/agent-relay/` (override with
`AGENT_RELAY_CONFIG_DIR`):

```
feishu.env | slack-app.env | telegram.env | jev.env
webhook.url, .slack-xoxc.tmp        # slack fallbacks
relay-<platform>.json               # state: conversations, jobs, notices
relay-<platform>.cmd/               # CLI → daemon command queue
logs/<platform>/<day>.jsonl
```

Environment knobs use the `AGENT_RELAY_` prefix (the legacy `RELAY_` prefix is
still read): `AGENT_RELAY_STALL_MS`, `AGENT_RELAY_TOOL_STALL_MS`,
`AGENT_RELAY_TIMEOUT_MS`, `AGENT_RELAY_MAX_WORKERS`, `AGENT_RELAY_QUEUE_DEPTH`,
`AGENT_RELAY_WORKER`, `AGENT_RELAY_ALLOWED_USER`.

CLI commands write a JSON file into `relay-<platform>.cmd/` and wait up to 20s for
the daemon to consume it: `delivered` means the daemon handled it, `pending` means
the daemon is not running.

`serve` takes `serve-<platform>.pid` in the config directory and refuses to start
when another live process holds it, so two instances can never overwrite each
other's state. A stale pid file is reclaimed automatically.

## Privacy and retention

Everything identifying lives in `~/.config/agent-relay/`, never in the sources:

- no platform ids, tenant names, channels or hosts are baked in — `AGENT_RELAY_ALLOWED_USER`
  (feishu/slack) and `AGENT_RELAY_SLACK_CHANNEL` are required, a missing value fails
  the start instead of falling back to a default;
- credentials live in `*.env` files, config dirs are `0700`, state/log/command files
  are `0600`;
- prompt text can be overridden per deployment: a same-named file under
  `~/.config/agent-relay/prompts/` wins over the built-in template;
- `usage-prompt.json` drives the work classifier (`instructions` + `criteria`); with
  no file the verdict is `unconfigured` instead of judging against a hard-coded
  asset list. See `examples/usage-prompt.example.json`.

Retention runs at startup and every 24h (`core.pruneLogs()`):

| data | window |
| --- | --- |
| event + usage logs | 72h |
| command queue files | 10min (also deleted the first time they are seen stale) |
| uploaded attachments | 7 days |
| notices | 7 days, max 500 |
| finished jobs | 30 days, max 2000 (unfinished, queued and active jobs never pruned) |
| conversations | 30 days |
| dedupe ids | 72h, max 5000 |

## Migrating from a `taskradar` layout

```bash
bun scripts/migrate-config.mjs --dry-run
bun scripts/migrate-config.mjs
```

It copies env files and upgrades `relay-<platform>.json` to the current state
schema (adding the `notices` table). The legacy files are left untouched.

## Tests

```bash
bun test
```

Tests live next to the code they cover under `test/`, one file per module.
