# 配置检查

用户在应用配置前运行 check，查看官方内核校验结果与合并后的摘要。

## Sub-features

- `embedded-check` 覆盖内嵌模板与 overlay 的真实内核检查
- `dynamic-check` 覆盖远程模板下载与检查
- `reject` 覆盖缺文件、坏 YAML、坏规则引用和缺内核

## How to get to it (user POV)

运行 `sbtools check`、`sbtools check -c <config.yaml>` 或 `sbtools check --config <config.yaml>`。

## Driving it with verify-sbtools

Preconditions:

- Launch 与 Doctor 完成
- VM 内的官方 sing-box 可执行

运行 `bun --no-env-file .agents/skills/verify-sbtools/helpers/verify.js drive --out "$RUN" --suite offline,remote`。

有效配置退出 0，显示 `内核 check 通过`，摘要反映 overlay 值。无效规则引用和不存在的 `SING_BOX` 路径必须失败。动态模板显示 `底模: dynamic`。

## Gotchas

配置了 template_url 的 check 会下载模板，不是零网络操作。check 不装配订阅节点，也不证明真实代理出口连通。非路由 DNS 动作没有 server 字段，当前摘要可能显示 `?`，不能据此判定内核配置无效。
