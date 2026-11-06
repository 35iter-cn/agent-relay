# {{loop_id}} 第 {{loop_round}} 轮

这一轮是 loop 定时起的，不是用户在说话。同一个话题下的多轮消息共用这个 session；而 loop 的每一轮都是一个新 session——你看不到上一轮说过什么，要看就用 `{{cli}} loop log {{loop_id}}` / `loop show-run <runId>`。

会话 key: {{conversation}}
上一次: {{loop_last}}
