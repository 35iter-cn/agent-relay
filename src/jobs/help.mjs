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
    usage: "schedule --platform <p> --key <k> --name <n> [--in <dur> | --at <iso>] [--grace <dur>]",
    detail: [
      "prompt 从 stdin 读到 EOF（`<<'EOF'` 或管道都行），落成 ~/.config/agent-relay/prompts/jobs/<name>/prompt.md。",
      "name 唯一且不复用：`[a-z0-9][a-z0-9._-]{0,63}`；同名或文件已存在会被拒（name-taken）。",
      "prompt 写给下一次的自己：为什么、查什么、怎么算做完、证据在哪。上限 8 KiB。",
      "到点用原会话续跑；跑完文件保留，作为这次任务的留档。",
    ],
    example: "agent-relay schedule --platform slack --key 1794634082.877169 --name vps-renew-20261201 --at 2026-11-29T10:00:00+08:00 <<'EOF'\n…任务书…\nEOF",
  },
  { verb: "list", usage: "schedule list --platform <p>", detail: ["列出还没跑的轮次。"] },
  { verb: "cancel", usage: "schedule cancel --platform <p> <name>", detail: ["撤掉还没跑的排期；已经开跑的会被拒（already-started），改用 `job cancel <id>`。"] },
  { verb: "help", usage: "schedule help [<verb>]", detail: ["不带 <verb> 时列全部子命令。"] },
];

const SCHEDULE_SECTIONS = [
  { heading: "inputs", lines: ["正文只从 stdin 读：`--prompt`、`--prompt-file` 都不存在。", "stdin 是终端时拒绝（stdin-is-tty），读到 0 字节拒绝（empty-prompt）。"] },
  { heading: "exit", lines: ["0 已受理（scheduled / cancelled）；1 daemon 没在跑；3 refused:<reason>"] },
];

const SCHEDULE_SUMMARY = [
  "排一轮：正文走 stdin，name 唯一，到点用原会话续跑",
  "管理还没跑的：schedule list / schedule cancel <name>",
  "参数、闸、退出码见下面的表",
];

export function jobHelp(verb = "") {
  return renderHelp({ title: "agent-relay job — 在跑与刚结束的轮次", summary: SUMMARY, verbs: JOB_VERBS, sections: SECTIONS, verb });
}

export function scheduleHelp(verb = "") {
  return renderHelp({ title: "agent-relay schedule — 排一轮未来的任务", summary: SCHEDULE_SUMMARY, verbs: SCHEDULE_VERBS, sections: SCHEDULE_SECTIONS, verb });
}
