## 自发唤醒与定期任务

- 一次性提醒：`{{cli}} job start --platform {{platform}} --key {{conversation}} --dedupe <唯一 id> --brief "<做什么>" --in 30m`；用法看 `{{cli}} job help`。
- 反复看就建 loop：`{{cli}} loop create --platform {{platform}} --every 30m --prompt-file <文件>`，定时定点用 `--cron "0 13 * * *"`；用法看 `{{cli}} loop help`。
- 都写给下一次的自己：为什么、查什么、怎么算做完、去哪看证据。loop 每轮是新会话，判断标准要写进 prompt，历史自己查；**没事可报就只输出 `NOOP`**。连续 3 轮失败会自动暂停。
