import { renderHelp } from "../help.mjs";

export const RESTART_VERBS = [
  {
    verb: "restart",
    usage: "restart [--wait <dur>|0] [--reason <text>]",
    detail: [
      "every platform, no flag needed: one request per daemon",
      "a daemon restarts once it has nothing queued or running, plus a settle window",
      "<dur> is a number and a unit: 90s, 30m, 1.5h, 1d; 0 waits with no deadline; default 1h",
      "a second request replaces the first: one slot, seq grows, the deadline restarts",
      "the receipt follows in the system group; the boot notice closes it",
    ],
    example: "restart --wait 30m --reason \"after the release build\"",
  },
  { verb: "status", usage: "restart status", detail: ["one line per platform: request, running, queued, waited, deadline"] },
  { verb: "cancel", usage: "restart cancel", detail: ["drops a pending request on every platform; one already stopping is refused"] },
  { verb: "help", usage: "restart help [<verb>]", detail: ["every verb, or the one you name"] },
];

const SECTIONS = [
  {
    heading: "limits",
    lines: [
      "one restart slot per platform; there is no queue to drain",
      "a request that never finds an idle platform expires at its deadline and restarts nothing",
      "the wait is bounded by the configured default (1h) unless --wait 0 says otherwise",
    ],
  },
  { heading: "exit", lines: ["0 queued on every platform | 1 a platform was restarted directly or skipped | 3 a platform refused"] },
];

const SUMMARY = [
  "restart the whole relay safely: every platform waits for its own rounds to finish",
  "the daemon decides when it is idle; the new instance reports the restart",
  "no platform flag, no second entry point",
];

export function restartHelp(verb = "") {
  return renderHelp({ title: "agent-relay restart — a restart that waits for the rounds", summary: SUMMARY, verbs: RESTART_VERBS, sections: SECTIONS, verb });
}
