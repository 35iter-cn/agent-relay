export const RESTART_PROMPT = "上一轮似乎卡住了，继续，不要犯相同错误";

export function stallNoticeText({ silenceMs = 0, local, session, key, pid, reason = "silent", tool = null } = {}) {
  const minutes = Math.max(1, Math.round(Number(silenceMs) / 60_000));
  const head = reason === "tool" && tool
    ? [`⏸ 任务疑似卡住：工具 ${tool.name} 已运行 ${minutes} 分钟没有返回`, `工具：${tool.name} · ${tool.head}`]
    : [`⏸ 任务疑似卡住：${minutes} 分钟没有进展`];
  return [
    ...head,
    `会话：${session}`,
    `key：${key}`,
    `pid：${pid ?? "-"}`,
    `最后进展：${local}`,
    "",
    "回复本消息会新开一个会话处理它：说「杀掉」只终止并按已用时间入账；说「继续 <补充要求>」则先终止入账，再用这条会话重启。",
    `重启默认提示词：「${RESTART_PROMPT}」`,
  ].join("\n");
}

export function stallNoticePrompt({ key, platform, cli = "agent-relay", instructions = "", actions = "" } = {}) {
  return [
    instructions,
    actions,
    `这条通知对应的 job key 是 \`${key}\`，平台是 \`${platform}\`，命令行入口是 \`${cli}\`。不要自己 kill 进程，也不要手改账本。`,
    `重启时用默认提示词「${RESTART_PROMPT}」再加用户的补充要求。`,
  ]
    .filter(Boolean)
    .join("\n\n");
}
