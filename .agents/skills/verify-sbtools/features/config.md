# 查看配置

用户查看本地配置的脱敏内容，并在本次运行的内核可达时查看运行时摘要。

## Sub-features

- `discovery` 覆盖 YAML 优先、仅旧 JSON、显式路径与显式路径缺文件
- `redaction` 覆盖节点与订阅整元素隐藏、敏感键替换、`outbounds` 之外的 `server` 标签保留、URL 仅 userinfo 形态兜底与 overlay 未解析标注
- `runtime` 覆盖实际 `/configs` 摘要与回环离线时的静默跳过
- `guard` 覆盖非回环 controller 拒绝、缺省 9090 回退与无配置加缺省不可达的组合错误
- `args` 覆盖 `--path` 缺值与未知参数

## How to get to it (user POV)

运行 `sbtools config` 或 `sbtools config --path <config.yaml|singbox.json>`。

## Driving it with verify-sbtools

Preconditions:

- Launch 与 Doctor 完成

运行 `bun --no-env-file .agents/skills/verify-sbtools/helpers/verify.js drive --out "$RUN" --suite offline,observability`。

脱敏输出不能包含夹具的敏感哨兵；`dns.servers[].server` 与 `dns.rules[].server` 是引用标签，必须保留。显式不存在的文件退出 1。非回环地址明确拒绝并跳过运行时摘要，但保留本地输出（退出 0）；回环 controller 离线时同样静默跳过摘要（退出 0）。磁盘无配置且缺省 9090 不可达时退出 1。真实内核摘要须反映配置的 debug 日志级别。独立 sing-box 的 `/configs` 可能报告 mixed-port 为 0，即使 mixed 入站实际正在监听；该字段不能证明监听端口。

## Gotchas

配置 root 与 overlay 都未提供 controller 时回退缺省 127.0.0.1:9090；非回环 controller 是明确拒绝，不会尝试 9090。网络隔离作用于全部非 remote 套件，并非 config 单独隔离。配置解析失败与未配置仍有回退路径，不应声称所有无效配置都会阻止连接。
