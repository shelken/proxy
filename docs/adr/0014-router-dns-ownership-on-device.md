# 路由角色的 DNS 归属归设备侧

**日期**：2026-11-05

路由器底模不再自带本网解析器的定义，也不做部署域的静态应答；tun 的 `dns_mode` 由 `hijack` 改 `native`，53 端口的接管交回路由规则。三件事同属一个决定：路由角色的 DNS 由设备与路由规则决定，底模不预设答案。片段的增删方式见 [0013](0013-module-manifest-with-semantic-fragments.md)，取舍背景见 [0012](0012-router-template-for-side-router.md)

## Context

- `type: local` 对 `*.local.` 与链路本地反查固定走内置 mDNS。mDNS 没有否定应答，没有应答者时只有超时（实测 10 秒），客户端连 SERVFAIL 都收不到；旁路由上没有 mDNS 应答者
- `hijack` 配 `auto_redirect` 时，内核在规则预匹配之前无差别把 53 端口 DNAT 到 tun 的 DNS 地址，规则层的 `bypass` 看不到这些包，设备显式指定的公网解析器被本机改写
- 本网解析器的地址不能进底模：它填主路由地址，而底模不写任何设备数据；旁路由自己的 53 端口被 `dns-in` 占用，不能指向回环

## Decision

1. 本网解析器的定义从 `fragments/base/dns-policy.json` 拆到 `fragments/base/dns-lan-resolver.json`，只在 `roles.mac` 与 `roles.ios` 里出现。`roles.router` 不列它，`dns-lan` 的定义与地址由设备 overlay 提供
2. 部署域的静态应答拆到 `fragments/base/dns-deployment.json`，同样只在 mac / iOS 出现。路由侧该域的答案改由主路由 dnsmasq 给（该域已登记在 `config/rules/custom/MyDirect.yaml`，覆盖全部子域）
3. `fragments/router/inbounds.json` 的 `dns_mode` 改 `native`，53 端口由 `dns-in` 与设备 overlay 的路由规则接管，顺序是「放行解析器 → 53 劫持 → 白名单 `bypass`」
4. 本网解析器的 tag 在三个角色之间统一为 `dns-lan`，底模的五处 DNS 规则与 `route.default_domain_resolver` 都不因角色而改 tag

## Consequences

- `template-router.json` 单份不可内核 check（`initialize outbound[0]: default domain resolver not found: dns-lan`），本地与 CI 都先经 `scripts/merge-variant-fixture.sh` 装配出终态
- 设备 overlay 必须提供 `dns-lan` 的地址；缺了它内核在 check 阶段就失败，设备上表现为 sing-box 起不来
- 回退部署域静态应答：把 `fragments/base/dns-deployment.json` 加进 `roles.router`，`route.rules` 不用动
- 设备侧契约（白名单写法、`dns-lan` 的地址、放行清单、clash API 的 `secret`）不在本仓库，见 `docs/user-guide/05-router.md`；本轮只改了仓库侧，那份指南与 `CODING_STANDARDS.md` 的描述下一轮同步。clash API 的监听地址仍由 `fragments/router/experimental.json` 写成 `0.0.0.0:9090`，本轮未动，overlay 可覆盖
