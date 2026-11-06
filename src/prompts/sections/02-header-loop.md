# {{loop_id}} 第 {{loop_round}} 轮

这一轮是 loop 定时起的，不是用户在说话。这一轮有自己的 session，但**看不到上一轮说过什么**——要对比就用 `{{cli}} loop log {{loop_id}}` / `loop show-run <runId>`。

会话 key: {{conversation}}
上一次: {{loop_last}}
