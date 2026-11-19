import { renderHelp } from "../help.mjs";

export const JOB_VERBS = [
  {
    verb: "list",
    usage: "job list --platform <p> [--key <k>]",
    detail: ["列出在跑与刚结束的轮次：状态、job id、会话 key、name、到期时间、prompt 文件。", "还没跑的轮次在 `agent-relay schedule list` 里。"],
  },
  {
    verb: "cancel",
    usage: "job cancel --platform <p> <job-id>",
    detail: [
      "终止正在跑的那一轮：对整个进程组发 SIGTERM，宽限 5 秒后仍存活就 SIGKILL。",
      "卡住的那段时间按最后一次进展截止入账。还没跑的会被拒（not-running），用 `agent-relay schedule cancel <name>`。",
    ],
  },
  {
    verb: "restart",
    usage: "job restart --platform <p> <job-id> [补充要求]",
    detail: [
      "先终止，再用原 session 派新一轮继续；默认提示词是「上一轮似乎卡住了，继续，不要犯相同错误」，带补充要求就接在后面。",
      "只对在跑或卡住的那一轮成立；已结束的被拒（not-running）。答案回到原会话。",
    ],
  },
  {
    verb: "redeliver",
    usage: "job redeliver --platform <p> <job-id|key>",
    detail: ["把一条投递失败、内容还在的回复再发一次；已发出去的分片会跳过。", "内容已被回收会报 refused:nothing-to-redeliver。"],
  },
  { verb: "help", usage: "job help [<verb>]", detail: ["不带 <verb> 时列全部子命令；带时只看那一条。"] },
];

const SECTIONS = [
  {
    heading: "卡住的通知",
    lines: [
      "收到卡住通知时只做处置，不要接着做原任务：说「杀掉」就 cancel，说「继续 <补充要求>」就 restart。",
      "job id 写在通知正文里，照抄即可，不要猜。",
      "不要自己 kill 进程，也不要手改账本：那样工时那一行就补不上了。",
    ],
  },
  {
    heading: "limits",
    lines: [
      "同一个 key 每小时最多 12 次自发轮次（RUNAWAY_PER_HOUR），超了 rejected:runaway",
      "一个会话同一时刻只跑一个 job；到期的 job 排在线程空闲之后，不插队",
      "命令信封 10 分钟内有效，过期的命令文件被丢弃",
    ],
  },
  { heading: "exit", lines: ["0 已受理；1 daemon 没在跑；3 refused:<reason>"] },
];

const SUMMARY = [
  "三个词：`schedule` 排未来，`job` 管在跑与刚结束的，`loop` 管定期",
  "job 一律按 id 寻址；name 只是别名",
  "参数、闸、退出码见下面的表",
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
  return renderHelp({ title: "agent-relay job — 在跑与刚结束的轮次", summary: SUMMARY, verbs: JOB_VERBS, sections: SECTIONS, verb });
}

export function scheduleHelp(verb = "") {
  return renderHelp({ title: "agent-relay schedule — one round, queued for a later moment", summary: SCHEDULE_SUMMARY, verbs: SCHEDULE_VERBS, sections: SCHEDULE_SECTIONS, verb });
}
