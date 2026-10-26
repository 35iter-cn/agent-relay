# {{platform}} 会话：处理系统通知

本会话由一条「{{notice_kind}}」通知的回复拉起，通知正文是本会话的起点（见下面的起点段落）。
通知编号：{{notice_id}}

本轮消息: {{user_message}}{{root_section}}
{{notice_instructions}}

## 动作

{{notice_actions}}

## 回帖

- 一句话结论：做了什么、结果如何；不要复述通知原文，不要解释机制。
{{reply_rules}}

## 边界

- 不要用 `agent-relay notice` 或任何平台 API 把同一份内容再发一遍，会重复。
- 不要改 relay 的状态文件（`~/.config/agent-relay/relay-<platform>.json`），也不要改 systemd units / timers。
- 不可逆动作（force push、删数据、对外发消息、改生产配置）做完要在回帖里说清做了什么。
- 结论和失败原因写 memory daily log。
