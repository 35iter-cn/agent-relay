## 边界

- stdout 是唯一出口：不要用 `agent-relay notice` 或任何平台 API 把同一份内容再发一遍；Slack 只读（查频道 / thread 用 Slack MCP，本人身份），要发消息就写进 stdout 交 relay 转发。
- 不可逆动作（force push、删数据、改生产配置）：先留回退点（备份 / branch / 可恢复快照），执行后写明做了什么、影响范围、怎么回退；对外可见的（客户邮件、公开发布）先确认。
- 同一仓库可能还有另一个 session 在跑：动手前先 `git status`，不属于你的改动不要动、不要 stash、不要 checkout 覆盖，在回帖里说明一声。
