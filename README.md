# agent-relay

Multi-platform IM relay daemon for coding agents.

One long-running process per IM platform bridges conversations to agent sessions
(pi today, other harnesses later): it queues work, streams chunked replies back,
detects stalled runs, and posts **notices** that users can reply to.

```
user message ──▶ platform adapter ──▶ relay core ──▶ agent session (pi --print)
                        ▲                  │
                        │                  ├─ job queue, leases, stall detection
                        └── chunked reply ─┘  stall watchdog, event log
```

## Replyable notices

Anything the relay posts on its own initiative is a **notice**, and every notice
has the same two fields:

- `text` — what the user sees in the chat (the stall alert, the intake
  broadcast, the hours report, the boot line)
- `prompt` — optional instructions injected into the session that opens when the
  user replies to that notice: what to do, which job key it belongs to, which
  command to run

A notice has no kind, no actions and no refs. Every notice opens with a fixed title
line (`📣📣📣 <类型>`, chosen by the sender via `--title`) so a chat preview says what
the message is about before any of its body is read. The relay records the notice in
the platform state file together with the message id it was posted as; when the user
replies, the adapter reports the parent message id, the relay resolves it back to
the notice and opens a session scoped to it (`notice-ntc-12`). The fixed
`prompts/sections/` notice sections then render just `text`, `prompt` and the platform
reply rules.

That means:

- adding a new notification type is a change in the sender, not in this repo:
  `agent-relay notice emit --platform feishu --text "$(…)" --prompt-file …`
- the policy for acting on a notice lives in that `prompt`; the relay itself only
  knows `agent-relay stall <platform> cancel|restart <key>` and the scheduled-turn
  entry described below — each entry point validates its own arguments. Inbound text
  is never parsed: `/stop`, `/重跑` or any other word in a reply is plain text for the
  agent, which cancels through the stall command if it decides to.
- the notice body is data, not instructions — the notice task section says so, because the
  text can carry third-party content (issue titles, chat excerpts)

The stall alert is the one notice the relay raises by itself; it builds both
fields in `src/runtime/stall-notice.mjs`.

## Scheduled turns

A conversation turn can be put on the clock: `agent-relay job start --platform slack
--key <thread> --dedupe <id> --brief "<what this turn does>" --in 30m` (or `--at <iso>`,
`--grace 6h`). The job is created straight into `status: "scheduled"` and the daemon
moves it to `queued` once `dueAt` passes **and the thread is free** — a due job never
sits in the queue and never pushes a user message out of it. From there it is an
ordinary job: same lease, serialisation per key, stall watchdog, delivery.
`job list` shows the scheduled and running turns, `job cancel` drops one that has not
started, `job redeliver <key|job-id>` resends the reply of a turn whose delivery failed
while the answer is still in the state. A turn that starts later than its `dueAt` records `lateMs` and the prompt says
how late it is; one that is still waiting past `expiresAt` is cancelled instead of
starting. `agent-relay job help` prints every subcommand, the timing flags and the
limits; the model is pointed at it instead of carrying the flags in its prompt.

Who is asking matters only for provenance, not for permission: `origin: "self"` means
the call came from inside a relay turn (the child carries `AGENT_RELAY_SELF_CHAIN`),
`origin: "external"` means it came from anywhere else. The wake prompt tells the model
which one it is, and that a brief quoting third-party text is data. Scheduling is
per-platform: each `serve <platform>` sweeps its own state file, so one stopped daemon
only delays its own turns.

## Loops

A conversation turn can be put on a clock once (`job start`); a **loop** is the repeating version. A loop is one prompt plus one cron schedule, owned by the platform it was created on:

```bash
agent-relay loop create --platform slack --slug intake --cron "*/30 * * * *" --prompt-file ~/.config/agent-relay/prompts/loops/intake-slack/prompt.md
agent-relay loop create --platform slack --cron "0 13 * * *" --prompt-file ./digest.txt
agent-relay loop list              # merges every platform, marks overdue loops
agent-relay loop run intake-slack  # start one round right now
agent-relay loop log intake-slack  # runId / time / trigger / outcome
agent-relay loop help              # every subcommand, schedule and gate
```

A loop's id is readable when you say so: `--slug intake` makes it `intake-slack`; without `--slug` it stays `loop-<platform>-<n>`. The id is also the round key prefix (`intake-slack-r7`), so renaming it later is a migration, not an edit.

**Where the prompt lives** decides when an edit lands. `--prompt-file <path>` stores only the path and reads it at the start of **every round** — edit the file, the next round uses it, no `loop update`, no restart. A file that was deleted, emptied or grown past 64 KiB fails that round (`prompt-unreadable` / `empty-prompt` / `prompt-too-long`), posts nothing, and counts towards the three-failure pause like any other failed round.

The shape is enforced rather than documented: `--slug` is required, and the only accepted `--prompt-file` is `<configDir>/prompts/loops/<loop id>/prompt.md` — another path is refused with `prompt-file-not-canonical`, and an inline `--prompt` is refused with `inline-prompt-refused` unless you say `--allow-inline` (stored as `promptInline`). A one-off prompt belongs to `job start`, not to a loop. `agent-relay loop doctor [--platform <p>]` re-checks every loop against that shape — id form, canonical path, file health, schedule — prints `<id>\t<ok|warn|fail>\t<problems>` and exits 3 when something fails.

The schedule is cron, five fields, on wall-clock minutes in `Asia/Shanghai` (`0 13 * * *` is every day at 13:00). The next due point is the first match after the previous trigger; when it arrives while the previous round is still running, **that trigger is dropped rather than caught up** — the anchor moves past it, so a round finishing at 21:59 with `*/30` meets the 22:00 trigger, and `loop show` reports the dropped point as `skipped`. A one-off turn is `job start --in/--at`, never a loop. A stored loop still carrying the retired `every` / `at` schedule is paused at boot and reported by one notice, and `loop doctor` fails it with `bad-schedule` — it never dies silently.

Every round is a **fresh session**: the round's conversation key is `<loopId>-r<round>`, so nothing from the previous round leaks in. The round's output goes out through the **notice entry** with a conversation binding (`reply: { mode: "conversation", key }`), which is the one deliberate difference to an ordinary notice: a reply to it continues *that round's* session instead of opening a `notice-<id>` conversation.

A notice is never pruned on its own. A bound notice stores only its binding, not the body — the round's text already lives in the history file, and keeping a copy in the state file would mean rewriting it on every job change.

A round whose output is only `NOOP` (or nothing at all) is a quiet round: nothing is posted, the round is recorded as `noop`, and the loop stays healthy. The model is told about this marker in its prompt (`src/prompts/sections/45-self-wake.md`), so "nothing to report" does not turn into one message per interval.

The old round history lives in `~/.config/agent-relay/loops/<loopId>.jsonl` (last 50 rounds, 90 days); a round never receives the previous output — it is told to read it with `loop log` / `loop show-run`.

Three gates keep automated rounds from running away: at most 20 loops per platform, at most `LOOP_ROUNDS_PER_HOUR` (20) rounds per platform per hour (a dropped trigger spends none of it), and one round in flight per loop. Three consecutive failed rounds pause the loop and raise one notice — a loop that dies silently is indistinguishable from "nothing happened today".

A loop is scheduled and delivered only by its own platform's daemon, which keeps the per-platform state invariant: a stopped daemon delays its own loops, nothing else. `state.loops` is written only from that daemon, through the same command-file path as `job start`.

## Structure

```
src/
├── cli.mjs                 entry: serve | notice | stall | job | loop
├── help.mjs                subcommand help renderer shared by the command families
├── config.mjs              paths, env files, state/command locations
├── shared/                 chunking, json, time, logging, retention, prompts, env, fs, boot
├── state/                  state schema + atomic store
├── jobs/                   job model, leases, delivery plan, worker signals, next action, help
├── loops/                  loop model, cron schedule, rounds, history, help
├── runtime/                core loop, prompts, stall notice, instance lock
├── notices/                notice service (emit / match / prune)
├── prompts/                prompt sections (one file per block) + stall fragments
└── platforms/              feishu | slack adapters + shared helpers
```

Design rules:

- **Platform code never holds cross-call state.** Conversations live in the job
  and arrive via `ctx`; the adapter only translates protocol.
- **Runtime never mentions a platform by name.** Differences live in
  `src/platforms/<name>.mjs`; shared behaviour (root-text cache, conversation
  pruning) lives in `src/platforms/shared/`.
- **User-initiated versus relay-initiated** live in one set of section files
  (`src/prompts/sections/NN-<name>.md`); `ENTRY_SECTIONS` in
  `src/runtime/prompts.mjs` decides which sections a conversation and a notice
  reply each render. A `platform-<name>-reply` section renders only on that
  platform.
- **The ledger is not relay's.** Relay decides which job runs when and how it
  stops; the pi extension and the agent-hours service own every ledger row.
- **A conversation key is the name a message will share with its own thread.** A root
  message has no thread yet, so its key is `th-<its own message id>`; the replies that
  later form its thread carry that id as `root_id`, which lands them on the same key.
  Never fall back to a per-message key for a root message: it splits one conversation
  into two sessions and makes steering impossible.
- **A lease is identity, not a liveness pulse.** A worker's lease is `pid` plus
  the process start ticks read once at spawn; nothing refreshes it on a timer,
  and no elapsed time makes it expire. A job is alive only while that exact
  process exists, which is what makes reap-after-crash work at any delay.
  Platform-connection heartbeats (Slack `ping`/`pong`) are a different
  mechanism and stay where they are.

## Platforms

| platform | transport | reply identity |
| --- | --- | --- |
| feishu | Lark WS long connection | `parent_id` / `root_id` |
| slack | Socket Mode | `thread_ts` |

Adapter contract (`src/platforms/contract.mjs`): `name`, `start`, `reply`,
`sessionFor` are required; `postNotice`, `postMedia`, `edit`, `onProgress`,
`onProgressDone`, `buildWorker`, `prune`, `locateReply` are optional. `postNotice` must
be callable before `start()` so the CLI can emit notices without a running daemon.

`reply` resolves to `{ messageId }` or **throws** — a null result is read as "nothing was
sent", so a platform that swallows its own error loses the answer. The thrown error
carries `retryable: false` when a second attempt cannot succeed (`invalid_thread_ts`,
`channel_not_found`, a missing token); everything else is retried three times with
`DELIVERY_BACKOFF_MS` (1.5s / 5s / 15s). A retry of a chunk that may already have landed
asks `locateReply(ctx, { text, since })` first and adopts the message it finds instead of
posting a duplicate. When every attempt fails the job ends `failed` / `reply-failed`, the
answer stays in the state, and `job redeliver` resends it: the parts already sent are
skipped by their hash.

Attachments: feishu downloads message resources through the SDK, slack downloads
`url_private_download` with the bot token — that token needs the `files:read` scope,
and a 200 `text/html` body means the scope is missing. All write into
`uploads/<chat>/<yyyymmdd>/`, capped at 4 files per inbound message (20 MB each,
7-day retention) by `src/platforms/shared/uploads.mjs`; the landed paths reach the
worker as `@path` arguments. `.slack-xoxc.tmp` is unrelated to this — it only feeds
`conversations.replies`.

Outbound images are the mirror of that: a worker asks for a picture to be sent by
putting `![](/absolute/path.png)` on a line of its own in stdout (png/jpg/jpeg/gif/webp,
20 MB each, at most 8 per reply). `extractMedia()` removes those lines, the delivery plan
sends every text chunk first and the images after, and only the adapters that implement
`postMedia` upload anything — slack walks `files.getUploadURLExternal` → upload →
`files.completeUploadExternal` into the same thread, so that token also needs the
`files:write` scope; without it the image degrades into a text note plus one alert.
Feishu keeps the reference as plain text.

## Run

```bash
bun scripts/install.mjs            # link agent-relay into ~/.local/bin
bun scripts/install.mjs --systemd  # also link the systemd template unit
agent-relay serve feishu
```

Configuration lives in `~/.config/agent-relay/` (override with
`AGENT_RELAY_CONFIG_DIR`):

```
feishu.env | slack-app.env
.slack-xoxc.tmp                     # slack root-text reads only
relay-<platform>.json               # state: conversations, jobs, notices
relay-<platform>.cmd/               # CLI → daemon command queue
logs/<platform>/<day>.jsonl
```

Environment knobs use the `AGENT_RELAY_` prefix (the legacy `RELAY_` prefix is
still read): `AGENT_RELAY_STALL_MS`, `AGENT_RELAY_TOOL_STALL_MS`,
`AGENT_RELAY_STALL_CHECK_MS`, `AGENT_RELAY_TIMEOUT_MS`, `AGENT_RELAY_MAX_WORKERS`,
`AGENT_RELAY_QUEUE_DEPTH`, `AGENT_RELAY_WORKER`, `AGENT_RELAY_ALLOWED_USER`; the
slack adapter adds its own `PING_MS` / `PONG_TIMEOUT_MS` / `ALERT_COOLDOWN_MS`.
With nothing set, one turn times out after 2 hours, `MAX_WORKERS` is 5,
`QUEUE_DEPTH` is 3 and the stall watchdog runs once a minute — the source
defaults are the production values, so no systemd drop-in is involved.

CLI commands write a JSON file into `relay-<platform>.cmd/` and wait up to 20s for
the daemon to consume it: `delivered` means the daemon handled it, `pending` means
the daemon is not running.

`serve` takes `serve-<platform>.pid` in the config directory and refuses to start
when another live process holds it, so two instances can never overwrite each
other's state. A stale pid file is reclaimed automatically.

## Upgrade

Restart a running instance without killing the job that is doing the restart:

```bash
git -C ~/code/agent-relay pull --ff-only
bun scripts/install.mjs
agent-relay-upgrade feishu
```

`scripts/relay-upgrade.sh` (linked as `agent-relay-upgrade`) does four things:

1. when it runs inside the relay service's own cgroup, it re-executes itself
   under `systemd-run --user --unit relay-upgrade-<platform>` so the restart
   cannot kill the caller half-way;
2. waits until the relay is quiet — nothing `queued` or `running`, and nothing whose
   `updatedAt` is inside the last `RELAY_UPGRADE_SETTLE` seconds (default 15) — for at
   most `RELAY_UPGRADE_WAIT` seconds, default 1800, `0` meaning no limit; on timeout it
   exits 3 and leaves the relay untouched. A quiet reading is re-checked
   `RELAY_UPGRADE_SETTLE` seconds later, because `applyWorkerResult()` saves the new
   status *before* awaiting the delivery: a job that finished mid-check is still a reply
   on its way out, and `recover()` resending missed chunks is a backstop, not a licence
   to restart into it. An unreadable or unparsable state file exits 5 instead of
   restarting blind;
3. restarts `agent-relay@<platform>` and, 10 seconds later, requires both
   `is-active` and a changed `MainPID`;
4. posts a notice with the outcome, on failure together with the last 30 journal
   lines on stderr.

It stays bash on purpose: the cgroup probe reads `/proc/self/cgroup` and the
restart uses `systemd-run`, both native to a shell.

## Privacy and retention

Everything identifying lives in `~/.config/agent-relay/`, never in the sources:

- no platform ids, tenant names, channels or hosts are baked in — `AGENT_RELAY_ALLOWED_USER`
  (feishu/slack) and `AGENT_RELAY_SLACK_CHANNEL` are required, a missing value fails
  the start instead of falling back to a default;
- credentials live in `*.env` files, config dirs are `0700`, state/log/command files
  are `0600`;
- prompt text can be overridden per deployment: a same-named file under
  `~/.config/agent-relay/prompts/` wins over the built-in template;

Retention runs at startup and every 24h (`core.pruneLogs()`):

| data | window |
| --- | --- |
| event logs | 72h |
| command queue files | 10min (also deleted the first time they are seen stale) |
| uploaded attachments | 7 days |
| notices | 7 days, max 500 |
| finished jobs | 30 days, max 2000 (scheduled, queued and active jobs are never pruned; a scheduled turn past its grace is cancelled) |
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
bun test        # unit and integration, milliseconds
bun run e2e     # process level, seconds
```

Tests live next to the code they cover under `test/`, one file per module;
`test/e2e/` holds the process-level scripts, which spawn real workers and write
real state and event files, faking only the IM delivery.

## Contributing

`main` only takes squash-merged pull requests: branch, push, open a PR, merge.
[`AGENTS.md`](AGENTS.md) records the conventions this repository expects from a
change — the test evidence a PR carries and how a change reaches the running
daemon.
