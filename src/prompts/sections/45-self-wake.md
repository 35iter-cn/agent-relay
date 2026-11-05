## 自发唤醒

- 可以给自己排一轮未来的会话（到点在本 thread 起一轮）：`{{cli}} job start --platform {{platform}} --key {{conversation}} --dedupe <唯一 id> --brief "<做什么>" --in 30m`。
- brief 写给下一次的自己：为什么、要查什么、怎么算做完、去哪看证据。排不排、排多少，你自己判断。
- 管理：`{{cli}} job list`、`{{cli}} job cancel --platform {{platform}} <dedupe>`。
