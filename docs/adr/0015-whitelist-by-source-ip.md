# 白名单改用源 IP，不用源 MAC

**日期**：2026-11-04

透明 DNS 的查询在 `auto_redirect` 的预匹配阶段取不到源 MAC，名单内设备在 DNS 路径上被当成名单外，拿到真实地址而不是 fakeip；接管到的 TCP 交回内核时入接口是 tun0，输入链的 conntrack 检查会丢弃，透明 TCP 查询超时。路由与 DNS 两处的白名单因此改用 `source_ip_cidr`，同一份地址列表，设备在主路由上配固定租约。取代 [0012](0012-router-template-for-side-router.md) Decision 5 的 `source_mac_address` 写法

## Consequences

- `source_mac_address` 的写法仍可用，但不适合按设备放行透明 DNS 的部署
- 手机等设备开随机 MAC 不影响识别；白名单按 IP 匹配，需在主路由给设备配固定租约
- 地址列表与 `vars/networking.nix` 同网段，明文写在设备 overlay（仓库公开，不写 MAC / IP 之外的设备数据）
