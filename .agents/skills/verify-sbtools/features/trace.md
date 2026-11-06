# 链路诊断

`trace <domain>` 对域名做全链路探测，输出「第一行结论 + 一条因果链」：解析 / DNS / 拨号 / 路由 / 连通。第一行指向第一个失败段；全部通过时写「经 \<出站\> 出站」或「通，但路由判定未捕获」。两处证据：路由出站链与内核 DNS 判定。

## Sub-features

- `guard` 覆盖顶层、overlay 和 `--api` 的非回环拒绝
- `dial` 覆盖出站拨号解析失败（`✗`）与「已发起未观察」（`·`）形态；成功不显示
- `live` 覆盖实际 CONNECT 存续连接的规则集与出站链，以及无存续连接时的未捕获提示
- `fakeip` 覆盖系统解析落在 fakeip 段时的「fakeip，由内核接管」标记与退出码
- `https` 覆盖可信公网 HTTPS 成功与自签名证书失败

## How to get to it (user POV)

运行 `sbtools trace <domain>` 或 `sbtools trace <domain> --api <127.0.0.1:port>`。

## Driving it with verify-sbtools

Preconditions:

- Launch 与 Doctor 完成
- 公网组可以访问 `example.com`

运行 `bun --no-env-file .agents/skills/verify-sbtools/helpers/verify.js drive --out "$RUN" --suite offline,observability,remote`。

合成观测组核对实际 A 地址、DNS server、`Probe` 规则集与 direct 出站链。fakeip 被标记；自签名证书导致 HTTPS 阶段失败，退出码为 1。

公网组使用本次启动的内核与 mixed 入站，要求解析为真实 IP、`PublicExample` 规则集与 direct 出站链、HTTPS 首字节成功，trace 退出 0。

## Gotchas

路由规则分配不证明代理节点可连接。无 TUN 时原始 HTTPS 请求未必进入内核；生效配置可读且含回环 mixed 入站时 live 段经 CONNECT 保持连接，否则退化为直连 range 下载。未捕获到 debug 判定必须保留原提示，不用本地 DNS 推演替代该段证据。controller 由 CLI 恒定提供：未配置时回退缺省 127.0.0.1:9090 并提示；内核探活失败时只留一行「已跳过 DNS / 路由 / 链路」并继续连通段。

公网组将自己的 resolver 指向自己启动的 DNS 入站，使用 [官方 HTTPS DNS 配置](https://sing-box.sagernet.org/configuration/dns/server/https/) 查询公共 DoH。不借用 VM 默认 DNS，避免宿主机 fakeip 干扰。
