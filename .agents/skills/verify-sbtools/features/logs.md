# 查看日志

用户回看日志文件的末尾，或跟踪实际内核产生的新日志。

## Sub-features

- `tail` 覆盖 `-n N`、0 行、超出文件长度、文件不存在与非法 UTF-8
- `source` 覆盖 YAML 优先于旧 JSON，以及 root 未写 `log.output` 时 overlay 的兜底
- `follow` 覆盖 `-f`、未给 `-n` 时的缺省跟踪，与交给内核 `/logs?level=` 的级别过滤
- `tail-follow` 覆盖 `-n N -f` 的先回看后跟踪
- `lifetime` 覆盖跨过 4 秒后仍能接收新事件
- `args` 覆盖 `--level` 白名单、`-n`/`--level` 缺值、非数字行数和未知参数

## How to get to it (user POV)

运行 `sbtools logs`、`sbtools logs -n N`、`sbtools logs -f` 或 `sbtools logs -n N -f --level debug`。

## Driving it with verify-sbtools

Preconditions:

- Launch 与 Doctor 完成

运行 `bun --no-env-file .agents/skills/verify-sbtools/helpers/verify.js drive --out "$RUN" --suite offline,observability`。

回看输出对应文件的实际末 N 行。YAML 存在时不额外读旧 JSON。观测组启动真实 sing-box，等待跟踪提示后发起合成 HTTP 请求。输出必须包含该请求的内核事件，且已解码 payload。跨过 4 秒后再次发起请求，跟踪进程仍能输出事件。

## Gotchas

`/logs` 不回放历史。未给 `-n` 时缺省进入跟踪（等价 `-f`）；`-n` 是显式回看请求，缺 log.output 时报错退出，不转跟踪。级别过滤由内核在 `/logs?level=` 侧生效，sbtools 不自行过滤。用例终止自己的跟踪进程并标记 `stoppedByHarness`，不要把主动终止码当作产品失败。
