# 变体接口用能力文件，不用整份拷贝

**日期**：2026-11-04

变体（`modules-ios/`、`modules-router/`）与共享底模的接口从「整份文件同名替换」收窄成「能力文件 + 同名空集弃用」：底模按可独立变化的事实拆文件，变体不要哪一份就在自己的目录放同名空集文件。同时把本网解析器的 tag 在三个角色之间统一为 `dns-lan`，于是没有任何规则需要为改 tag 而抄文件。取代 [0012](0012-router-template-for-side-router.md) 里「同名整份替换」那段机制，它带来的三份拷贝（`modules-router/90-experimental.json`、`10-dns.json`、`20-route-base.json`）随之删除

## Context

- 合并语义是「`modules/` 为底，变体目录同名替换、其余新增」（`scripts/merge-variant-template.sh`）。它删不掉条目，所以「这个角色不要这一片」当时只能靠整份拷贝表达
- 拷贝的代价是静默漂移：底模改一条规则，三份拷贝要逐份跟改，跟漏了就与底模分岔，而没有任何检查会发现
- 反例约束：iOS 的 `dns.rules` 首条必须是 ts-ep 入站拒绝（[0010](0010-ios-template-with-embedded-tailscale.md)），所以「部署域的静态应答」这一份在共享底模里的位置被卡在 `09-tailscale-dns.json` 与 `10-dns.json` 之间

## Decision

1. 底模按可独立变化的事实拆文件，本次拆出部署域与内网入口的静态应答（只服务 mac / iOS）、本网解析器的定义两份；变体不要某一份，就在变体目录放同名空集文件，写显式空集而不是 `{}`，让「不要这一份」在文件里读得出来
2. 本网解析器的 tag 三份底模统一为 `dns-lan`：mac / iOS 用底模的 `type: local`（跟随宿主系统解析器），路由变体弃用它、由设备 overlay 给主路由地址
3. clash API 的监听地址不再由变体写死：底模与 Mac 一致只监听回环，设备 overlay 用标量覆盖
4. 路由侧弃用部署域的静态应答：`ooooo.space` 交给底模 `MyDirect-dns → dns-lan` 之后的主路由 dnsmasq，前提经 `dig @<主路由> cpa.int.ooooo.space A` 实测成立（[05-router.md](../user-guide/05-router.md) 的 overlay 契约）
5. 文件名次序即数组次序这条约定写进 `CODING_STANDARDS.md`：能力文件排在 `10-dns.json` 之前，部署域那一份还排在 `09-tailscale-dns.json` 之后

## Consequences

- 变体目录里除真有对象差异的 `00-inbounds.json` 之外不再放共享文件的拷贝；改文件名等于改数组次序，动手前先跑 `just template-build` 对照三份产物
- mac / iOS 的产物只随 tag 改名变化，数组次序不动；路由变体不再自带本网解析器、部署域应答与 clash API 监听地址
- `dns_mode: native` 的核对面：沙箱 VM 内用 `hijack` 与 `native` 各起一份最小 tun + `auto_redirect` 配置，`nft list table inet sing-box` 里前者有 53 端口的 DNAT、后者一条都没有
- 回退：把 `modules-router/10-dns-deployment.json` 的内容换成 `modules/10-dns-deployment.json` 的两条规则，`route.rules` 不动
- 跨仓时序：底模先进 `main` 而设备 overlay 未重铸时，盒子的订阅刷新会在 `sing-box check` 处失败并保留旧配置，表现为不收敛而不是掉线；部署链见 [05-router.md](../user-guide/05-router.md)
