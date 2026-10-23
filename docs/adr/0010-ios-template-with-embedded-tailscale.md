# iOS 使用独立底模，内嵌 Tailscale 承载内网访问

**日期**：2026-10-17

iOS 同一时间只能有一个 VPN，sing-box 与独立 Tailscale App 无法并存。iOS 底模在同一批 `modules/` 之上，通过 `modules-ios/` 同名替换与新增模块，生成 `template-ios.json`，由 sing-box 内嵌的 `tailscale` endpoint 同时承载代理与内网访问。Mac 的 `template.json` 不变

## Context

- 底模 `00-inbounds.json` 把 `10/8`、`172.16/12`、`192.168/16` 排除在 TUN 之外，Mac 靠它保留物理局域网直连。这些流量不进 sing-box，Tailscale 子网路由无从接管
- Tailscale 子网路由由控制台决定，配置里写死网段或节点名会随网络变化失效。sing-box 的 `preferred_by` 通过 `PeerForIP` 与 MagicDNS 自动匹配已获批的路由和节点，不需要列举
- `sing-box merge` 对数组只追加，overlay 删不掉底模里的 `192.168/16` 排除，所以无法靠 overlay 让 iOS 去掉它
- Tailnet 对手机自身 Tailscale IP 发起的连接，在 1.14.3 `protocol/tailscale/endpoint.go` 中被改写为 `127.0.0.1` 后进入路由，入站标签是 endpoint 的 tag。现有 `ip_is_private → direct` 会把它直连到本机回环。沙箱用同样条件复现：无入站拒绝时读到本机服务，入站拒绝置首后被拒
- 同用户 Peer 的 DNS 查询由 tailscale 依赖直接交给 `dnsRouter`（`endpoint.go` 的 `HandlePeerDNSQuery`，入站标签同样是 `ts-ep`），不经过 `route.rules`，路由层的入站拒绝覆盖不到。沙箱用同标签入站复现：DNS 规则 `inbound: ts-ep` 的 `reject` 返回 REFUSED，普通入站不受影响

## Decision

1. 新增 `config/sing-box/modules-ios/`，同名文件替换 `modules/` 中的对应文件，其余文件新增，合并后产出 `template-ios.json`，经现有 `template_url` 机制使用
2. iOS 的 `00-inbounds.json` 去掉三个私网排除，保留 `fe80::/10`，并与 Mac 一致排除 `224.0.0.0/4` 与 `255.255.255.255/32`。未被 Tailscale 认领的私网流量进入 sing-box 后仍由 `ip_is_private` 直连；组播与广播 Tailscale 不转发（[tailscale#11134](https://github.com/tailscale/tailscale/issues/11134)），收进 TUN 只会妨碍本地局域网发现（2026-10-23 补充）
3. 新增 `tailscale` endpoint `ts-ep`（`accept_routes`，不开 `system_interface`，不设 exit node）与 `dns-ts`。`accept_default_resolvers` 为 false，普通互联网 DNS 分流不变
4. MagicDNS 规则（`preferred_by: dns-ts`）排在 FakeIP 之前；路由规则 `preferred_by: ts-ep` 排在 `ip_is_private → direct` 之前
5. `inbound: ts-ep` 的 `reject` 在路由层排在全部规则之首，包括 `sniff` 与 DNS 劫持；在 DNS 层排在 `dns.rules` 之首，早于 MagicDNS 与静态应答。手机只作为 Tailnet 客户端，正常查询来自 `tun-in`，不受影响
6. 在家与在外一律由 Tailscale 处理已认领的子网，不依赖 SSID
7. `2080` 与 `9090` 保持原样，它们由入站拒绝保护

## Consequences

- iOS 与 Mac 底模同源，`modules-ios/` 只列差异。两份产物都由 CI 对 `modules` 重新合并并比对
- iOS 用户的家庭网段若与 Tailscale 发布的子网相同，该目标会被送入 Tailnet。当前目标网段为 `192.168.69.x`，未见冲突
- 入站拒绝只约束进入 sing-box 路由与 DNS 的流量。Tailscale 自身的 PeerAPI（Taildrop 等）由 Tailscale 授权控制，不经过 `route.rules`，要禁止收文件需检查 Tailnet 的文件共享策略。Tailscale SSH 默认未启用
- 真实 Tailnet 登录、ACL、子网路由批准与锁屏、切网表现无法在沙箱验证，由设备验收
- 回滚：删除 `modules-ios/` 与 `template-ios.json`，客户端移除 iOS 的 `template_url`
