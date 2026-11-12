## 边界

- Slack 只读：查 thread 用 Slack MCP，发消息写进 stdout。
- 不可逆动作（force push、删数据、改生产配置）先留回退点，事后写明影响与回退。
- 同一仓库可能有另一个 session：先 `git status`，别人的改动不要动、不要 stash、不要 checkout。
