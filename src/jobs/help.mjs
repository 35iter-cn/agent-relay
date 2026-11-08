import { renderHelp } from "../help.mjs";

export const JOB_VERBS = [
  {
    verb: "start",
    usage:
      "job start --platform <p> --key <k> --dedupe <id> (--brief <text> | --brief-file <path>) [--in <dur> | --at <iso>] [--grace <dur>]",
    detail: [
      "--key <k>       目标会话 key，从 `agent-relay job list` 或本 thread 的上下文里拿",
      "--dedupe <id>   唯一 id，同一个 id 排第二次会被拒（duplicate）",
      "--brief         这一轮要做什么；也会作为提示词的一部分交给会话",
      "--in <dur>      相对延后（30m / 2h），与 --at 二选一，都不给就立刻跑",
      "--at <iso>      绝对时刻（2026-11-08T13:00:00+08:00）",
      "--grace <dur>   过期没跑成就取消，默认 6h",
      "到期时线程必须空闲才起；起跑晚了会记 lateMs 并告诉这一轮晚了多久。",
    ],
    example: 'agent-relay job start --platform slack --key <thread-id> --dedupe ci-check-1 --brief "看一下 CI" --in 30m',
  },
  { verb: "cancel", usage: "job cancel --platform <p> <dedupe>", detail: ["取消一条还没开始的定时轮；已经开始的不受影响（用 `agent-relay stall <p> cancel <key>`）。"] },
  { verb: "list", usage: "job list --platform <p> [--key <k>]", detail: ["列出 scheduled 与 running 的轮次。"] },
  { verb: "help", usage: "job help [<verb>]", detail: ["不带 <verb> 时列全部子命令；带时只看那一条。"] },
];

const SECTIONS = [
  {
    heading: "limits",
    lines: [
      "同一个 key 每小时最多 12 次自发轮次（RUNAWAY_PER_HOUR），超了 rejected:runaway",
      "一个会话同一时刻只跑一个 job；到期的 job 排在线程空闲之后，不插队",
      "命令信封 10 分钟内有效，过期的命令文件被丢弃",
    ],
  },
  { heading: "exit", lines: ["0 已受理（scheduled / started / cancelled）；1 daemon 没在跑；3 refused:<reason>"] },
];

export function jobHelp(verb = "") {
  return renderHelp({ title: "agent-relay job — 把一次会话轮次放到时钟上", verbs: JOB_VERBS, sections: SECTIONS, verb });
}
