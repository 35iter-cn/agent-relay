import { renderHelp } from "../help.mjs";

export const JOB_VERBS = [
  {
    verb: "list",
    usage: "job list --platform <p> [--key <k>]",
    detail: ["rounds running now and just finished: status, job id, key, name, deadline, prompt file", "a round that has not started yet is `agent-relay schedule list`"],
  },
  {
    verb: "cancel",
    usage: "job cancel --platform <p> <job-id>",
    detail: [
      "stops the running round: SIGTERM to the process group, SIGKILL after 5s",
      "the record is cut at the last progress if a stall notice was sent, at the stop time otherwise",
      "a round that has not started is refused (not-running): drop it with `agent-relay schedule cancel <name>`",
    ],
  },
  {
    verb: "restart",
    usage: "job restart --platform <p> <job-id> [what to change]",
    detail: [
      "stops the round, then starts a new one in the same agent session",
      "default prompt: `The previous round was terminated. Continue from where it stopped: don't redo finished work, don't repeat what failed.`, your words appended",
      "only a running round; a finished one is refused (not-running). The reply lands in the original thread",
    ],
  },
  {
    verb: "redeliver",
    usage: "job redeliver --platform <p> <job-id|key>",
    detail: ["re-sends a reply whose delivery failed while its body is still in state", "a body already reclaimed is refused: nothing-to-redeliver"],
  },
  { verb: "help", usage: "job help [<verb>]", detail: ["every verb, or the one you name"] },
];

const SECTIONS = [
  {
    heading: "stall notices",
    lines: [
      "handle the notice, don't carry on with the task: \"kill\" → job cancel, \"continue <what to change>\" → job restart",
      "the job id is in the notice body; copy it, don't guess",
      "never kill the process yourself and never edit the ledger: relay then loses the stop time and the record",
    ],
  },
  {
    heading: "limits",
    lines: [
      "12 self-started rounds per key per hour (RUNAWAY_PER_HOUR); over that, rejected:runaway",
      "one job per conversation at a time; a due job queues behind the thread",
      "a command envelope is valid for 10 minutes; stale command files are dropped",
    ],
  },
  { heading: "exit", lines: ["0 accepted | 1 daemon not running | 3 refused:<reason>"] },
];

const SUMMARY = [
  "`schedule` queues a round, `job` manages the running and the just-finished one",
  "a job is addressed by id; the name is an alias",
  "flags, gates and exit codes below",
];

const SCHEDULE_VERBS = [
  {
    verb: "create",
    usage: "schedule --platform <p> --key <k> --name <n> [--in <dur> | --at <iso>]\n[--grace <dur>] [--join]",
    detail: [
      "the body comes from stdin to EOF, at least 1 byte and at most 8 KiB",
      "<dur> is a number and a unit: 90s, 30m, 1.5h, 1d. 0m means now",
      "<at> is an ISO timestamp with an offset",
      "name: [a-z0-9][a-z0-9._-]{0,63}, unique for good",
      "neither --in nor --at: the round runs as soon as this conversation goes idle",
      "--grace <dur>   how long a due round may wait for the thread, default 6h",
      "--join          steer this body into a round already running at that moment",
      "                instead of waiting behind it",
    ],
    example: `agent-relay schedule --platform slack --key 1794634082.877169 --name vps-renew-20261201 \\
    --at 2026-11-29T10:00:00+08:00 <<'EOF'
why this round exists, what to check, what done looks like, where the evidence goes
EOF`,
  },
  { verb: "list", usage: "schedule list --platform <p>", detail: ["the rounds that have not started yet"], example: "schedule list --platform slack" },
  {
    verb: "cancel",
    usage: "schedule cancel --platform <p> <name>",
    detail: ["drops a round that has not started; one already running is a job, so job cancel <id>"],
    example: "schedule cancel --platform slack vps-renew-20261201",
  },
  { verb: "help", usage: "schedule help [<verb>]", detail: ["every verb, or the one you name"], example: "schedule help create" },
];

const SCHEDULE_SECTIONS = [
  { heading: "limits", lines: ["12 self-started rounds per key per hour", "one job per conversation at a time; a due round waits for the thread to go idle"] },
  { heading: "exit", lines: ["0 accepted (scheduled / cancelled) | 1 daemon not running | 3 refused:<reason>"] },
];

const SCHEDULE_SUMMARY = [
  "queue one round; at the due time this same conversation runs it, with its context",
  "the body is stdin, the name is unique and never reused, one task of a kind at a time",
];

export function jobHelp(verb = "") {
  return renderHelp({ title: "agent-relay job — running and just-finished rounds", summary: SUMMARY, verbs: JOB_VERBS, sections: SECTIONS, verb });
}

export function scheduleHelp(verb = "") {
  return renderHelp({ title: "agent-relay schedule — one round, queued for a later moment", summary: SCHEDULE_SUMMARY, verbs: SCHEDULE_VERBS, sections: SCHEDULE_SECTIONS, verb });
}
