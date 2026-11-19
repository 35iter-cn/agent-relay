import { renderHelp } from "../help.mjs";

const PROMPT_DIR = "~/.config/agent-relay/prompts/loops/<id>/prompt.md";

export const LOOP_VERBS = [
  {
    verb: "create",
    usage: 'loop create --platform <p> --slug <name> --cron "<expr>" --prompt-file <path>\n[--title <text>]',
    detail: [
      "--slug <name>    required; the id becomes <name>-<platform>, so \"intake\" → intake-slack",
      "--prompt-file    the canonical path only, read fresh every round:",
      `                 ${PROMPT_DIR}`,
      "--prompt <text>  inline text in place of a file, paired with --allow-inline",
      "--title <text>   the name in each message header, ≤80 bytes, defaults to the loop id",
    ],
    example: `agent-relay loop create --platform slack --slug intake --cron "0 9 * * 1-5" \\
    --prompt-file ~/.config/agent-relay/prompts/loops/intake-slack/prompt.md`,
  },
  {
    verb: "update",
    usage: 'loop update <id> [--cron "<expr>" | --prompt-file <path> |\n--prompt <text> --allow-inline | --title <text>]',
    detail: [
      "one field per call; the flags you leave out stay as they are",
      "a new --cron clears the last skipped point; a paused loop stays paused until loop resume",
      '--title "" clears the header name and falls back to the loop id',
    ],
    example: 'agent-relay loop update media-archive-feishu --cron "0 13 * * *"',
  },
  {
    verb: "list",
    usage: "loop list [--platform <p>] [--all]",
    detail: ["every platform when --platform is omitted; --all keeps the deleted ones too"],
    example: "agent-relay loop list --platform slack",
  },
  { verb: "show", usage: "loop show <id>", detail: ["definition, state, next due point and the last round"], example: "agent-relay loop show intake-slack" },
  {
    verb: "run",
    usage: "loop run <id>",
    detail: ["one round right now, trigger=manual, whatever the schedule says; lastRunAt moves to now"],
    example: "agent-relay loop run intake-slack",
  },
  { verb: "log", usage: "loop log <id> [--limit 20]", detail: ["rounds newest first: runId, time, trigger, outcome"], example: "agent-relay loop log intake-slack --limit 5" },
  {
    verb: "show-run",
    usage: "loop show-run <runId>",
    detail: ["the whole output of one round, up to 32 KiB"],
    example: "agent-relay loop show-run intake-slack-r42",
  },
  { verb: "pause", usage: "loop pause <id>", detail: ["stops the clock; a round already running finishes"], example: "agent-relay loop pause intake-slack" },
  {
    verb: "resume",
    usage: "loop resume <id>",
    detail: ["back on the schedule, next due computed from now, failStreak reset to zero"],
    example: "agent-relay loop resume intake-slack",
  },
  { verb: "delete", usage: "loop delete <id>", detail: ["gone from the list; the round history stays on disk"], example: "agent-relay loop delete intake-slack" },
  {
    verb: "doctor",
    usage: "loop doctor [--platform <p>]",
    detail: [
      "read-only audit: id shape, canonical prompt path, a non-empty file, a schedule that still resolves",
      "prints <id>\\t<ok|warn|fail>\\t<problems>; exit 3 when anything fails",
    ],
    example: "agent-relay loop doctor --platform slack",
  },
  { verb: "help", usage: "loop help [<verb>]", detail: ["every verb, or the one you name"], example: "agent-relay loop help create" },
];

const SECTIONS = [
  {
    heading: "flow",
    lines: [
      "mkdir -p ~/.config/agent-relay/prompts/loops/intake-slack",
      "$EDITOR ~/.config/agent-relay/prompts/loops/intake-slack/prompt.md    # one line, see prompt:",
      'agent-relay loop create --platform slack --slug intake --cron "0 9 * * 1-5"',
      "agent-relay loop run intake-slack        # prove one round before trusting the schedule",
      "agent-relay loop log intake-slack        # then read what it actually said",
    ],
  },
  {
    heading: "schedule",
    lines: [
      "<expr> is 5 fields: min hour dom mon dow, in the machine's zone; 0 and 7 are Sunday",
      'dom and dow both set → OR: "0 9 1 * 1" is the 1st of the month, or every Monday 09:00',
      "next due = the first match after the last trigger",
      "a round still running when the next is due skips that point; skipped points are not caught up",
      'steps follow the calendar, so "*/45" alternates 45 and 15; use 60 or 120 for even spacing',
      "a one-shot reminder is `agent-relay schedule --in 30m`, not a loop",
    ],
  },
  {
    heading: "prompt",
    lines: [
      `--prompt-file is only ${PROMPT_DIR}, read fresh every round`,
      "entry prompt: one sentence of intent, plus the skill that does the work; logic lives in the skill",
      "the skill says when to stay silent: nothing new, nothing to do, same as last time",
      "it also says how a report reads, and the loop sends whatever the round ends with",
      "a round whose whole text is NOOP, or empty, sends nothing; any other text is sent as a message",
      "read, judge, report: no irreversible action inside a loop, send a notice and wait for the operator",
    ],
  },
  {
    heading: "limits",
    lines: [
      "20 loops per platform, 20 rounds per platform per hour, one round per loop at a time",
      "a skipped point is free; the hourly cap counts the rounds that ran",
      "3 failed rounds in a row → paused, with one notice",
    ],
  },
  { heading: "exit", lines: ["0 accepted (or printed locally) | 1 daemon not running | 3 refused:<reason>"] },
];

const SUMMARY = [
  "one prompt, one schedule, a fresh session every round; the round's whole text is the message",
  "start at flow:, read prompt: before you write the prompt file",
];

export function loopHelp(verb = "") {
  return renderHelp({ title: "agent-relay loop — a prompt on a clock, a fresh session every round", summary: SUMMARY, verbs: LOOP_VERBS, sections: SECTIONS, verb });
}
