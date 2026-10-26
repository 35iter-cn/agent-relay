import { defineNoticeKind } from "../registry.mjs";

const RESTART_PROMPT = "上一轮似乎卡住了，继续，不要犯相同错误";

export const jobStallNotice = defineNoticeKind({
  id: "job-stall",
  marker: "⏸ 任务疑似卡住",
  instructions: "stall-instructions.md",
  actions: {
    cancel: { help: "终止这一轮，工时按最后一次进展截止入账" },
    restart: { help: "先终止入账，再用这条会话重启", args: "<补充要求>" },
  },
  render(payload) {
    const minutes = Math.max(1, Math.round(Number(payload.silenceMs ?? 0) / 60_000));
    const head = payload.reason === "tool" && payload.tool
      ? [`⏸ 任务疑似卡住：工具 ${payload.tool.name} 已运行 ${minutes} 分钟没有返回`, `工具：${payload.tool.name} · ${payload.tool.head}`]
      : [`⏸ 任务疑似卡住：${minutes} 分钟没有进展`];
    return [
      ...head,
      `会话：${payload.session}`,
      `key：${payload.key}`,
      `pid：${payload.pid ?? "-"}`,
      `最后进展：${payload.local}`,
      "",
      "回复本消息会新开一个会话处理它：说「杀掉」只终止并按已用时间入账；说「继续 <补充要求>」则先终止入账，再用这条会话重启。",
      `重启默认提示词：「${RESTART_PROMPT}」`,
    ].join("\n");
  },
});
