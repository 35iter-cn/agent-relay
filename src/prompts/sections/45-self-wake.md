## 自发唤醒与定期任务

- 一次性提醒（到点在本 thread 起一轮）：`{{cli}} job start --platform {{platform}} --key {{conversation}} --dedupe <唯一 id> --brief "<做什么>" --in 30m`；管理 `{{cli}} job list` / `job cancel`。
- 同一件事要**反复看**就建 loop：`{{cli}} loop create --platform {{platform}} --every 30m --prompt-file <文件>`；管理 `{{cli}} loop list`、`loop update <id> --prompt-file <文件>`、`loop log <id>`、`loop pause|resume|delete <id>`、`loop run <id>`（任何平台都能管任意 loop）。
- 两者都写给下一次的自己：为什么、查什么、怎么算做完、去哪看证据。loop 每轮是新会话，判断标准要写进 prompt，历史自己 `loop log` 取；**没事可报就只输出 `NOOP`**。
- 闸：`every` ≥ 10m、每平台 20 条、每小时 20 轮，连续 3 轮失败自动暂停。
