# 查看日志

用户回看日志文件的末尾，或跟踪实际内核产生的新日志。

## Sub-features

- `tail` 覆盖 `-n N`、0 行、超出文件长度和读取错误
- `source` 覆盖 YAML 与旧 JSON 的日志来源优先级
- `follow` 覆盖 `-f` 与级别过滤
- `tail-follow` 覆盖 `-n N -f` 的先回看后跟踪
- `lifetime` 覆盖跨过 4 秒后仍能接收新事件

## How to get to it (user POV)

运行 `sbtools logs`、`sbtools logs -n N`、`sbtools logs -f` 或 `sbtools logs -n N -f --level debug`。

## Driving it with verify-sbtools

Preconditions:

- Launch 与 Doctor 完成

运行 `bun --no-env-file .agents/skills/verify-sbtools/helpers/verify.js drive --out "$RUN" --suite offline,observability`。

回看输出对应文件的实际末 N 行。YAML 存在时不额外读旧 JSON。观测组启动真实 sing-box，等待跟踪提示后发起合成 HTTP 请求。输出必须包含该请求的内核事件，且已解码 payload。跨过 4 秒后再次发起请求，跟踪进程仍能输出事件。

## Gotchas

`/logs` 不回放历史。缺 log.output 时 `-n` 报错退出（不转跟踪），显式 `-f` 才跟踪。用例终止自己的跟踪进程并标记 `stoppedByHarness`，不要把主动终止码当作产品失败。
