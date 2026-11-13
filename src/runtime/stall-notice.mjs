export const RESTART_PROMPT = "上一轮似乎卡住了，继续，不要犯相同错误";

const SUBJECT_CHARS = 80;
const COMMAND_CHARS = 120;

function oneLine(value, limit = SUBJECT_CHARS) {
  const line = String(value ?? "")
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item.length > 0) ?? "";
  const flat = line.replace(/\s+/g, " ");
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

export function stallNoticeText({ silenceMs = 0, local, reason = "silent", tool = null, task = "", round = "" } = {}) {
  const minutes = Math.max(1, Math.round(Number(silenceMs) / 60_000));
  const subject = oneLine(task);
  const thisRound = oneLine(round);
  const detail = tool?.head ? `${tool.name === "bash" ? "命令" : "目标"}：${oneLine(tool.head, COMMAND_CHARS)}` : "";
  const stuck = reason === "tool" && tool
    ? [`卡在：工具 ${tool.name ?? "未知"} 已运行 ${minutes} 分钟没有返回`, detail]
    : [`卡在：${minutes} 分钟没有进展`];
  const head = [
    subject ? `任务：${subject}` : "",
    thisRound && thisRound !== subject ? `这一轮：${thisRound}` : "",
    ...stuck,
    `最后进展：${local}`,
  ].filter(Boolean);
  return [
    ...head,
    "",
    "回复本消息会新开一个会话处理它：说「杀掉」只终止，卡住的那段按最后一次进展截止入账；说「继续 <补充要求>」则先终止入账，再用这条会话重启。",
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
