export function stallHelp() {
  return [
    "agent-relay stall — 终止或重启卡住的一轮",
    "",
    "用法:",
    "  agent-relay stall <platform> cancel <key>",
    "  agent-relay stall <platform> restart <key> [补充说明]",
    "",
    "说明:",
    "  cancel 只终止；restart 先让那一轮收尾，再用原 session 派新 job 继续。",
    "  <key> 从 `agent-relay job list --platform <p>` 或这一轮的通知里拿；不确定时看 ~/.config/agent-relay/relay-<platform>.json 里仍在跑的 job，不要猜。",
    "  不要自己 kill <pid>，也不要手改账本；relay 回「没有在跑的任务」就是已经结束。",
    "",
  ].join("\n");
}
