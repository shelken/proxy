# 路由器使用独立底模，设备白名单放在 overlay

**日期**：2026-11-03

家里的单臂旁路由（Linux，sing-box 1.14）要和 Mac / iOS 走同一条订阅链路：sbtools 加密 yaml，服务端按 `template_url` 装配。Mac 底模是给单机用的，作为网关缺三样东西，而这三样都在 overlay 改不动的位置。路由器底模与 Mac 共用 `fragments/base/` 的片段，另在 `config/sing-box/modules.yaml` 里有一份 `roles.router`：`fragments/router/inbounds.json` 与 `fragments/router/experimental.json` 顶替共享的同名能力，并追加一个 DNS 入口片段，合并出 `template-router.json`；哪些设备走代理由各自的 overlay 决定，底模不含任何设备数据（布局在 2026-11-05 收敛为一张表加一层片段，见 `docs/adr/0017`）

## Context

- 网关模式下，局域网设备的转发流量要由 tun 的 `auto_redirect`（nftables）接管；它在 tun 入站对象里。overlay 写同 tag 的 `tun-in` 会在合并阶段 FATAL（`duplicate inbound tag: tun-in`），数组又只能追加，所以入站差异只能放进底模
- 局域网设备把 DNS 指向旁路由时，查询发往旁路由自己的地址，不经过 tun；需要一个监听 53 端口的入站。它的目的地址是私网，若不在前面劫持，会落到 `ip_is_private → direct`，被直连回本机 53 端口绕成环
- clash API 在 Mac 底模里只监听回环，homelab 的面板拉不到旁路由的连接
- 设备白名单（MAC / IP）属于个人网络数据，仓库公开，不能写进底模。tun 的 `include_mac_address` 需要设备数据，又在 overlay 改不动的入站对象里，不可用
- 1.13 起的 `bypass` 路由动作在 `auto_redirect` 的预匹配阶段让连接在内核层绕过 sing-box；1.14 起路由与 DNS 规则支持 `source_mac_address`。两者都是普通规则，可以由 overlay 追加，且 overlay 的规则排在底模之前

## Decision

1. 新增路由器变体片段（现为 `config/sing-box/fragments/router/` 下 3 个），合并入口与 iOS 共用同一个构建脚本 `scripts/modules-build.ts`（2026-11-05 前是变体模块目录加一个共用合并脚本，见 `docs/adr/0017`），产出 `template-router.json`
2. `fragments/router/inbounds.json`：tun 加 `auto_redirect: true`，私网段排除与 Mac 一致（局域网互访不进 sing-box）；`mixed-in` 仍只监听回环；新增 `direct` 入站 `dns-in`，监听 `::` 的 53 端口
3. `fragments/router/dns-in.json`：`inbound: dns-in → hijack-dns`，排在共享的 sniff 与 DNS 劫持片段之前
4. `fragments/router/experimental.json`：clash API 监听 `0.0.0.0:9090`；`secret` 不进底模，由设备 overlay 覆盖（标量，overlay 先者胜）
5. 白名单写在设备 overlay：路由规则 `inbound: tun-in` + `source_mac_address` + `invert` + `action: bypass` + `outbound: direct`；DNS 规则 `source_mac_address` + `invert` → `dns-local-system`。写法见 `docs/user-guide/05-router.md`

## Consequences

- 名单外设备的连接在预匹配阶段被 `bypass`，由内核直接转发给主路由，不进 sing-box；不适用内核旁路的连接按 `outbound: direct` 经 sing-box 直连。哪些协议能走到内核旁路未在真机验证，由设备验收
- 白名单规则必须限定 `inbound: tun-in`，否则 `dns-in` 的查询也会命中 `invert`，被 direct 送回本机
- 旁路由自身发起的连接查不到 MAC，同样命中 `invert` 被放行；系统更新、拉订阅不经代理
- 改名单要改 overlay、重新 `encode` 并替换设备上的订阅 URL；这是 sing-box 客户端现有交付方式的代价，与 Mac / iOS 一致
- `template-router.json` 的一致性与结构契约由 `just template-check`（按模块表重算并逐字节比对）与 `config/sing-box/tests/router-template.test.ts`（`roles.router` 条目注册 + 产物语义）保证，CI 同口径
- 回滚：从 `roles` 里去掉 `router`、删除 `fragments/router/` 与 `template-router.json`，设备改回自带的静态配置；旧布局的恢复方式见 `docs/adr/0017`
