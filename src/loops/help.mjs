import { renderHelp } from "../help.mjs";

export const LOOP_VERBS = [
  {
    verb: "create",
    usage: 'loop create --platform <p> --slug <name> --cron "<expr>" --prompt-file <path> [--title <text>] [--no-thread]',
    detail: [
      "schedule 只有 cron 一种，必须给。",
      '  --cron "<expr>"   5 字段（分 时 日 月 周），按 Asia/Shanghai 定点，如 "0 13 * * *" 是每天 13:00',
      "  到期的那一刻上一轮还在跑：这个触发点作废，不补跑；loop show 会显示 skipped。",
      "  一次性提醒不属于 loop，用 agent-relay job start --in 30m / --at <iso>。",
      "  --prompt-file <p> 只存路径，每轮现读；唯一合法值 = ~/.config/agent-relay/prompts/loops/<id>/prompt.md",
      "--slug <name> 必填：id = <name>-<platform>（如 intake-slack）。先写 prompt.md，再建 loop。",
      "路径不在那个目录下会被 refused: prompt-file-not-canonical；内联 --prompt 需要 --allow-inline。",
      "每轮是新会话，输出作为一条消息发出；只输出 NOOP（或什么都不输出）的轮次不发消息。",
      "--title <text> 每轮消息头的可读名字（≤80 字节，如「每日简报」）。不给就回落到 loop id。",
      "--no-thread 不给轮次消息开 thread（默认开，平台支持才生效）。",
    ],
    example: 'agent-relay loop create --platform slack --slug intake --cron "*/30 * * * *" --prompt-file ~/.config/agent-relay/prompts/loops/intake-slack/prompt.md',
  },
  { verb: "list", usage: "loop list [--platform <p>] [--all]", detail: ["不带 --platform 时合并所有平台；--all 连已删除的也列出来。"] },
  { verb: "show", usage: "loop show <id>", detail: ["打一条 loop 的定义、状态、下一次触发点与最近一轮结果。"] },
  {
    verb: "update",
    usage: 'loop update <id> [--cron "<expr>" | --prompt-file <path> | --prompt <text> --allow-inline | --title <text> | --thread | --no-thread]',
    detail: [
      "改 --cron 会替换表达式并清掉上一次的 skipped 记录。",
      "只改 prompt 时 schedule 与 lastRunAt 不动；paused 的 loop 改 schedule 不会自己恢复，要 loop resume。",
      "--prompt-file 只存路径、每轮现读，切换时清掉内联文本；改回内联要加 --allow-inline。",
      "--title 改每轮消息头的名字，--title \"\" 清空并回落到 loop id。",
    ],
    example: "agent-relay loop update media-archive-feishu --cron \"0 13 * * *\"",
  },
  { verb: "pause", usage: "loop pause <id>", detail: ["停掉定时，正在跑的一轮照常收尾。"] },
  { verb: "resume", usage: "loop resume <id>", detail: ["重新进入调度，并按当前 schedule 算下一次；failStreak 归零。"] },
  { verb: "delete", usage: "loop delete <id>", detail: ["从列表里消失，历史文件保留。"] },
  { verb: "run", usage: "loop run <id>", detail: ["立刻起一轮（trigger=manual），不管 schedule；会把 lastRunAt 推到此刻。"] },
  { verb: "log", usage: "loop log <id> [--limit 20]", detail: ["倒序列出轮次：runId / 时刻 / trigger / outcome。"] },
  { verb: "show-run", usage: "loop show-run <runId>", detail: ["打印某一轮的完整输出（每轮最多 32 KiB）。"] },
  {
    verb: "doctor",
    usage: "loop doctor [--platform <p>]",
    detail: [
      "只读巡检：id 形态、prompt 路径是否等于 prompts/loops/<id>/prompt.md、文件是否存在非空、schedule 是否还能算出下一次。",
      "输出 <id>\t<ok|warn|fail>\t<问题列表>；有 fail 时退出码 3。",
    ],
  },
  { verb: "help", usage: "loop help [<verb>]", detail: ["不带 <verb> 时列全部子命令；带时只看那一条。"] },
];

const SECTIONS = [
  {
    heading: "schedules",
    lines: [
      'cron "<expr>" 墙钟定点（分 时 日 月 周），时区固定 Asia/Shanghai；周 0 与 7 都是周日',
      "日与周同时受限时是 OR：0 9 1 * 1 = 每月 1 号或每周一 09:00",
      "下一个到期点 = 上一个触发点之后的第一个匹配时刻；上一轮还在跑就跳过那个点，不补跑",
      "90m 这类等间隔写不出来（*/45 是 45/15 交替），只能取 60 或 120",
    ],
  },
  {
    heading: "gates",
    lines: [
      "过密表达式由每小时 20 轮兜住；跳过的触发点不占这 20 轮",
      "每平台最多 20 条 loop；每平台每小时最多 20 轮；每条 loop 同时只有一轮在跑",
      "连续 3 轮失败自动暂停，并发一条通知",
    ],
  },
  { heading: "exit", lines: ["0 已受理（或本地打印）；1 daemon 没在跑；3 refused:<reason>"] },
];

const SUMMARY = [
  "模型读这三行就够：一段提示词按计划反复跑，每轮新会话，输出就是一条消息",
  "空轮 = 整个输出恰好 NOOP，不发消息；连续 3 轮失败自动暂停",
  "参数、闸、退出码见下面的表",
];

export function loopHelp(verb = "") {
  return renderHelp({ title: "agent-relay loop — 一段提示词按计划反复跑", summary: SUMMARY, verbs: LOOP_VERBS, sections: SECTIONS, verb });
}
