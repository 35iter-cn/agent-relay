import { renderHelp } from "../help.mjs";

export const LOOP_VERBS = [
  {
    verb: "create",
    usage:
      'loop create --platform <p> (--every <dur> | --at <iso> | --cron "<expr>") (--prompt <text> | --prompt-file <path>) [--no-thread]',
    detail: [
      "三种 schedule 互斥，恰好给一个。",
      "  --every <dur>     间隔，下一轮从上一轮实际起跑时刻算起（30m / 2h），最小 10 分钟",
      "  --at <iso>        一次性定点（2026-11-08T13:00:00+08:00），跑完 loop 变 done",
      '  --cron "<expr>"   5 字段（分 时 日 月 周），按 Asia/Shanghai 定点，如 "0 13 * * *" 是每天 13:00',
      "每轮是新会话，输出作为一条消息发出；只输出 NOOP（或什么都不输出）的轮次不发消息。",
      "--no-thread 关掉 discord 的轮次 thread（默认开）。",
    ],
    example: 'agent-relay loop create --platform discord --cron "0 13 * * *" --prompt-file ./digest.txt',
  },
  { verb: "list", usage: "loop list [--platform <p>] [--all]", detail: ["不带 --platform 时合并所有平台；--all 连已删除的也列出来。"] },
  { verb: "show", usage: "loop show <id>", detail: ["打一条 loop 的定义、状态、下一次触发点与最近一轮结果。"] },
  {
    verb: "update",
    usage: 'loop update <id> [--every <dur> | --at <iso> | --cron "<expr>" | --prompt <text> | --prompt-file <path> | --thread | --no-thread]',
    detail: [
      "给任意一种 schedule 就会替换全部三种（--every 会清掉 --cron，反之亦然）。",
      "只改 prompt 时 schedule 与 lastRunAt 不动；done 的 loop 改了 schedule 会自动回到 armed。",
    ],
    example: "agent-relay loop update loop-discord-1 --cron \"0 13 * * *\"",
  },
  { verb: "pause", usage: "loop pause <id>", detail: ["停掉定时，正在跑的一轮照常收尾。"] },
  { verb: "resume", usage: "loop resume <id>", detail: ["重新进入调度，并按当前 schedule 算下一次；failStreak 归零。"] },
  { verb: "delete", usage: "loop delete <id>", detail: ["从列表里消失，历史文件保留。"] },
  { verb: "run", usage: "loop run <id>", detail: ["立刻起一轮（trigger=manual），不管 schedule；会把 lastRunAt 推到此刻。"] },
  { verb: "log", usage: "loop log <id> [--limit 20]", detail: ["倒序列出轮次：runId / 时刻 / trigger / outcome。"] },
  { verb: "show-run", usage: "loop show-run <runId>", detail: ["打印某一轮的完整输出（每轮最多 32 KiB）。"] },
  { verb: "help", usage: "loop help [<verb>]", detail: ["不带 <verb> 时列全部子命令；带时只看那一条。"] },
];

const SECTIONS = [
  {
    heading: "schedules",
    lines: [
      "every <dur>   下一个到期点 = 上一轮实际起跑 + 间隔；适合任意间隔与「跑完再等」",
      "at <iso>      只跑一轮，跑完 state=done；一次性提醒用这个",
      'cron "<expr>" 墙钟定点（分 时 日 月 周），时区固定 Asia/Shanghai；周 0 与 7 都是周日',
      "日与周同时受限时是 OR：0 9 1 * 1 = 每月 1 号或每周一 09:00",
      "三种不能互相代替：cron 表达不了 90m 这类间隔，也表达不了一次性",
    ],
  },
  {
    heading: "gates",
    lines: [
      "every >= 10m（cron 不受此限，过密由每小时 20 轮兜住）",
      "每平台最多 20 条 loop；每平台每小时最多 20 轮；每条 loop 同时只有一轮在跑",
      "连续 3 轮失败自动暂停，并发一条通知",
    ],
  },
  { heading: "exit", lines: ["0 已受理（或本地打印）；1 daemon 没在跑；3 refused:<reason>"] },
];

export function loopHelp(verb = "") {
  return renderHelp({ title: "agent-relay loop — 一段提示词按计划反复跑", verbs: LOOP_VERBS, sections: SECTIONS, verb });
}
