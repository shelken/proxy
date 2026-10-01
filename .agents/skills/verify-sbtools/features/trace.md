# 链路诊断

用户查询域名的系统解析、DNS 归属、内核判定、存续连接的规则与出站链，以及 HTTPS 首字节耗时。

## Sub-features

- `guard` 覆盖顶层、overlay 和 `--api` 的非回环拒绝
- `dns` 覆盖确定性域名规则、rule_set 候选与 final 提示
- `dial` 覆盖出站拨号解析段的 `✓/✗/·/⚠` 形态（当前用例只观察 `⚠`，无独立断言）
- `live` 覆盖实际 CONNECT 存续连接的规则集和出站链，以及无存续连接时的 `规则分配目标` 兜底
- `static` 覆盖实际 `/rules` 结果
- `https` 覆盖可信公网 HTTPS 成功与自签名证书失败
- `fakeip` 覆盖假地址提示和失败计数

## How to get to it (user POV)

运行 `sbtools trace <domain>` 或 `sbtools trace <domain> --api <127.0.0.1:port>`。

## Driving it with verify-sbtools

Preconditions:

- Launch 与 Doctor 完成
- 公网组可以访问 `example.com`

运行 `bun --no-env-file .agents/skills/verify-sbtools/helpers/verify.js drive --out "$RUN" --suite offline,observability,remote`。

合成观测组核对实际 A 地址、DNS server、`Probe` 规则集与 direct 出站链。rule_set 候选不能显示为确定匹配。fakeip 必须被标记。自签名证书导致 HTTPS 阶段失败，退出码为 1。

公网组使用本次启动的内核与 mixed 入站，要求 resolver、live 规则集、静态规则和 HTTPS 首字节成功，trace 退出 0。

## Gotchas

路由规则分配不证明代理节点可连接。无 TUN 时原始 HTTPS 请求未必进入内核；生效配置可读且含回环 mixed 入站时 live 段经 CONNECT 保持连接，否则退化为直连 range 下载。未捕获到 debug 判定必须保留原提示，不能用静态规则或本地 DNS 推演替代该段证据。controller 由 CLI 恒定提供：未配置时回退缺省 127.0.0.1:9090 并提示；内核段探活失败记 `✗` 并继续其余段。

公网组将自己的 resolver 指向自己启动的 DNS 入站，使用 [官方 HTTPS DNS 配置](https://sing-box.sagernet.org/configuration/dns/server/https/) 查询公共 DoH。不借用 VM 默认 DNS，避免宿主机 fakeip 干扰。
