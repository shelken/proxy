# iOS 的 TUN 只配 IPv4，给 SideStore 留回环接口

**日期**：2026-11-08

iOS 底模的 TUN 去掉 IPv6 地址，只保留 `198.51.100.1/30`。Mac 与路由器底模仍保持双栈，决策来自 [issue #167](https://github.com/shelken/proxy/issues/167)

## Context

- iOS 同一时间只能有一个 VPN。SideStore 需要经 `10.7.0.1` 回环访问本机的开发者服务，所以要由 sing-box 承担 LocalDevVPN 的角色
- sing-box 用 `loopback_address` 反射目的地址为 `10.7.0.1` 的 TCP 包，用 `route_address` 的 `10.7.0.1/32` 保证它进入 TUN
- SideStore 固定的 minimuxer 提交 `12be70d` 里，`DeviceConnectionManager.swift` 的 `resolveCandidateTunnels` 只接受「有 IPv4 且没有 IPv6」的 utun。带 IPv6 的接口在探测前就被丢弃，候选为空，设备端点保持 nil，安装报 `DeviceEndpointNotInitialized`
- 设备上的日志对比：Loon 的 `utun4` 只有 IPv4，探测 `10.7.0.1:49152` 返回 `reachable`；sing-box 的 `utun8` 带 `fe80::` 与 `fdfe:dcba:9876::`，没有发出任何探测。Surge 官方文档对此同样要求关闭 IPv6 虚拟网卡
- FakeIP 只发 IPv4（`dns-fakeip` 没有 `inet6_range`），AAAA 拿不到假地址，代理流量本来就走 IPv4

## Decision

1. `platforms/ios.yaml` 的 TUN `address` 只留 `198.51.100.1/30`
2. `route_address` 只写 IPv4。iOS 客户端对没有写的 IPv6 沿用默认路由，不需要列出
3. Mac 与路由器的双栈不变，`template.test.ts` 里「tun 保持双栈」的断言只针对 `template.json`

## Consequences

- 仅在 sing-box 连接期间生效，断开后手机的 IPv6 照常
- 进入 TUN 的 IPv6 包会被 sing-tun 静默丢弃：系统栈在没有 IPv6 地址时 `tcpNat6` 为空，`processIPv6TCP` 直接返回。受影响的是国内直连域名的真实 AAAA、MagicDNS 的 AAAA 与 IPv6 字面量地址。预期由应用的 Happy Eyeballs 回落到 IPv4，只有 IPv6-only 的目标会失败，这一点待设备验证
- 未确认的风险：iOS 客户端总会设置 IPv6 参数，即使地址为空。若系统仍给 utun 加 `fe80::`，过滤依然命中，需要上游处理，见 issue 清单
- 回滚：把 `fdfe:dcba:9876::1/126` 加回 `address`，并删掉对应的测试
