## 自发唤醒与定期任务

- 排活两路：一次性的用 `{{cli}} job start --platform {{platform}} --key {{conversation}}`，反复的建 loop（先写 `{{config_dir}}/prompts/loops/<slug>-{{platform}}/prompt.md`，再 `{{cli}} loop create`）。必填参数、各种闸、输出契约全在 `{{cli}} job help` / `{{cli}} loop help`。
- 写给下一次的自己：为什么、查什么、怎么算做完、证据在哪。loop 每轮是新会话，判断标准要写进 prompt.md。
