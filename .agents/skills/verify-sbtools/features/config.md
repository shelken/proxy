# 查看配置

用户查看本地配置的脱敏内容，并在本次运行的内核可达时查看运行时摘要。

## Sub-features

- `discovery` 覆盖 YAML 优先、仅旧 JSON 和显式路径
- `redaction` 覆盖节点、订阅 URL、口令与 overlay 的脱敏
- `runtime` 覆盖实际 `/configs` 摘要
- `guard` 覆盖非回环 controller 拒绝

## How to get to it (user POV)

运行 `sbtools config` 或 `sbtools config --path <config.yaml|singbox.json>`。

## Driving it with verify-sbtools

Preconditions:

- Launch 与 Doctor 完成

运行 `bun --no-env-file .agents/skills/verify-sbtools/helpers/verify.js drive --out "$RUN" --suite offline,observability`。

脱敏输出不能包含夹具的敏感哨兵，路由与标签仍可辨认。显式不存在的文件退出 1。非回环地址跳过运行时摘要，但保留本地输出。真实内核摘要须反映配置的 debug 日志级别。独立 sing-box 的 `/configs` 可能报告 mixed-port 为 0，即使 mixed 入站实际正在监听；该字段不能证明监听端口。

## Gotchas

默认配置不可得时会尝试 9090。此用例只在独立网络命名空间执行。配置解析失败与未配置仍有回退路径，不应声称所有无效配置都会阻止连接。
