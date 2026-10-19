# MyProxy 先于国内直连豁免

**日期**：2026-10-17

`MyProxy` 是用户显式要求走代理的清单，优先级高于 `ChinaMax`。QUIC 守卫对 `MyProxy` 的 UDP 443/80 先 `reject` 降级到 TCP，DNS 侧为 `MyProxy` 增加伴生规则集，排在 `ChinaMax-dns` 之前，经 FakeIP 交给代理出口

## Context

- ADR-0008 的 QUIC 守卫先给国内直连豁免，命中 `ChinaMax` 的流量走 `direct`。`minimax.io` 同时在 `MyProxy` 与 `ChinaMax` 中，其 UDP 443/80 在到达服务规则前被豁免直连，TCP 却走代理
- DNS 侧 `ChinaMax-dns` 排在 FakeIP 前，同样让重叠域名拿到国内真实解析
- 显式清单的语义是「用户指定」，不应被自动生成的国内清单覆盖

## Decision

1. `33-quic-guard.json` 在国内直连豁免之前增加规则：`MyProxy` 的 UDP 443/80 `reject` 且 `no_drop: true`，客户端降级 TCP 后由 `MyProxy` 服务规则走代理
2. `10-dns.json` 增加 `MyProxy-dns`，位于 `ChinaMax-dns` 之前，应答交给 `dns-fakeip`
3. 保留 ADR-0008 的顺序：拦截先于模式开关与服务分流

## Consequences

- `MyProxy` 与 `ChinaMax` 重叠的域名，TCP、QUIC、DNS 三条路径一致走代理
- 未纳入 `MyProxy` 的国内站点行为不变
