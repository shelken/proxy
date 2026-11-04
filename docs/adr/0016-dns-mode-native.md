# 内核不做 53 端口接管：tun 用 dns_mode native

**日期**：2026-11-04

路由变体的 tun 不再用 `dns_mode: hijack`，改 `native`。`hijack` 配 `auto_redirect` 时，内核在**规则预匹配之前**无差别把 53 端口 DNAT 到 tun 的 DNS 地址，规则层的 `bypass` 看不到这些包，设备显式指定的公网解析器被本机改写（#148）。`native` 只是不再做内核侧 DNS 接管，53 的接管回到路由规则里，顺序由设备 overlay 决定：放行解析器 → 53 劫持 → 白名单 `bypass`

## Context

- 依赖「内网域在公网解析不到」的负向检查，因为查询被改写成 predefined 应答而失败
- 沙箱 VM（1.14.3，最小 tun + `auto_redirect` 配置）实测：`nft list table inet sing-box` 里 `hijack` 有 53 端口的 DNAT 规则，`native` 一条都没有

## Consequences

- 改回 `hijack` 会让 overlay 的放行清单失效：内核层的 DNAT 在预匹配之前生效，`bypass` 规则看不到这些包
- 53 端口的接管完全依赖 `config/sing-box/modules-router/29-dns-in.json` 与 `30-route-base-rules.json` 的规则在位
