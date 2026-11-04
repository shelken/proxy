# 路由器使用独立底模，设备白名单放在 overlay

**日期**：2026-11-03

家里的单臂旁路由（Linux，sing-box 1.14）要和 Mac / iOS 走同一条订阅链路：sbtools 加密 yaml，服务端按 `template_url` 装配。Mac 底模是给单机用的，作为网关缺三样东西，而这三样都在 overlay 改不动的位置。路由器底模在同一批 `modules/` 之上，通过 `modules-router/` 同名替换与新增，生成 `template-router.json`；哪些设备走代理由各自的 overlay 决定，底模不含任何设备数据

## Context

- 网关模式下，局域网设备的转发流量要由 tun 的 `auto_redirect`（nftables）接管；它在 tun 入站对象里。overlay 写同 tag 的 `tun-in` 会在合并阶段 FATAL（`duplicate inbound tag: tun-in`），数组又只能追加，所以入站差异只能放进底模
- 局域网设备把 DNS 指向旁路由时，查询发往旁路由自己的地址，不经过 tun；需要一个监听 53 端口的入站。它的目的地址是私网，若不在前面劫持，会落到 `ip_is_private → direct`，被直连回本机 53 端口绕成环
- clash API 在 Mac 底模里只监听回环，homelab 的面板拉不到旁路由的连接
- 设备白名单（MAC / IP）属于个人网络数据，仓库公开，不能写进底模。tun 的 `include_mac_address` 需要设备数据，又在 overlay 改不动的入站对象里，不可用
- 1.13 起的 `bypass` 路由动作在 `auto_redirect` 的预匹配阶段让连接在内核层绕过 sing-box；1.14 起路由与 DNS 规则支持 `source_mac_address`。两者都是普通规则，可以由 overlay 追加，且 overlay 的规则排在底模之前

## Decision

1. 新增 `config/sing-box/modules-router/`，合并逻辑与 iOS 共用 `scripts/merge-variant-template.sh <变体> <输出>`（原 `merge-ios-template.sh` 参数化），产出 `template-router.json`
2. `00-inbounds.json`：tun 加 `auto_redirect: true`，私网段排除与 Mac 一致（局域网互访不进 sing-box）；`mixed-in` 仍只监听回环；新增 `direct` 入站 `dns-in`，监听 `::` 的 53 端口
3. `29-dns-in.json`：`inbound: dns-in → hijack-dns`，排在 `30` 号段的 sniff 之前
4. `90-experimental.json`：clash API 监听 `0.0.0.0:9090`；`secret` 不进底模，由设备 overlay 覆盖（标量，overlay 先者胜）
5. 白名单写在设备 overlay：路由规则 `inbound: tun-in` + `source_mac_address` + `invert` + `action: bypass` + `outbound: direct`；DNS 规则 `source_mac_address` + `invert` → `dns-local-system`。写法见 `docs/user-guide/05-router.md`

## 补充：白名单改用源 IP（`source_mac_address` 在透明 DNS 上取不到）

**日期**：2026-11-04

`auto_redirect` 的预匹配阶段拿不到源 MAC，名单内设备在 DNS 路径上被当成名单外，拿到真实地址而不是 fakeip；接管到的 TCP 交回内核时入接口是 tun0，输入链的 conntrack 检查会丢弃，透明 TCP 查询超时。白名单因此改用 `source_ip_cidr`，DNS 与路由两处用同一份地址列表，设备在主路由上配固定租约。`source_mac_address` 的写法仍可用，但不适合按设备放行透明 DNS 的部署

## 补充：本网解析器、部署域名与放行清单也归 overlay

**日期**：2026-11-04（#147、#148）
（本节描述的机制已被下面的「收尾」一节取代，原文保留作为当时的记录）

`00-inbounds.json` 的 tun 起初用默认的 `dns_mode: hijack`，`10-dns.json` 起初把本网名字交给 `dns-local-system`（`type: local`）并把部署域名与内网入口写死在底模。前者让设备显式指定的公网解析器在内核预匹配阶段被改写，后者让 RFC 保留后缀落进 mDNS 分支，两个问题都出在「哪个解析器回答哪些名字」被写死在共享底模。这次把这三项交给设备 overlay：

1. `modules-router/10-dns.json`：删掉 `dns-local-system`（`type: local` 对 `*.local.` 与链路本地反查域固定走内置 mDNS，没有应答者时只有超时，连 SERVFAIL 都收不到）；删掉两条部署专用的 predefined 规则；其余五处 `server` 引用改指向 `dns-lan`。`local` / `lan` / `home.arpa` 是 RFC 保留后缀，与部署无关，留在底模
2. `modules-router/20-route-base.json`：`default_domain_resolver` 指向 `dns-lan`。同名替换是整文件替换，必须抄全 `auto_detect_interface` / `final` / `default_http_client`
3. `modules-router/00-inbounds.json`：`dns_mode` 由 `hijack` 改 `native`。`hijack` 配 `auto_redirect` 时内核在规则预匹配之前无差别把 53 端口 DNAT 到 tun 的 DNS 地址，规则层的 `bypass` 看不到这些包；`native` 只是不再做内核侧 DNS 接管，53 的接管回到 `29-dns-in.json` 与 `30-route-base-rules.json` 的规则里，顺序由 overlay 决定
4. 设备 overlay 提供四样：`dns.servers` 的 `dns-lan`、部署域名与内网入口的两条 predefined 规则、放行解析器清单、白名单。`route.rules` 的顺序固定为 放行解析器 → 53 劫持 → 白名单 `bypass`：放行必须给设备留出口，白名单 `bypass` 匹配整台设备，放前面会把名单外设备的 DNS 一起放走
5. `modules-router/` 的差异面由 `config/sing-box/tests/router-template.test.ts` 与 `just template-variant-check router` 保证；底模引用不到只有 overlay 才有的 `dns-lan`，终态装配的夹具是 `config/sing-box/tests/fixtures/router-overlay.json`（TEST-NET-1 占位地址），测试与 justfile 读同一份

## 收尾：变体接口收窄到能力文件，本网解析器 tag 统一为 `dns-lan`

**日期**：2026-11-04（#147、#148）

上一节用「同名整文件替换」表达差异，代价落在接口形状上：合并只能在 `modules/` 之上替换或新增文件，删不掉条目，于是「这个角色不要这一片」只剩整份拷贝一种写法（`modules-router/10-dns.json` 132 行、`20-route-base.json`、`90-experimental.json`），共享底模一改，三份拷贝就静默漂移。

决定把变体接口收窄到**能力文件**：底模按可独立变化的事实拆文件，变体不要某一份，就在变体目录放同名的空集文件（`{"dns":{"rules":[]}}`、`{"dns":{"servers":[]}}`），写显式空集而不是 `{}`，让「不要这一份」在文件里读得出来。本次拆出两份：部署域与内网入口的静态应答（只服务 mac / iOS）、本网解析器的定义。变体目录剩下的差异只有 `00-inbounds.json`（tun 的 `auto_redirect` 与 `dns_mode`）与 `29-dns-in.json`，没有任何共享文件的拷贝。

配套的三处收敛：

1. 本网解析器的 tag 在共享底模与三个角色之间统一为 `dns-lan`。`10-dns.json` 的五处 `server` 引用与 `20-route-base.json` 的 `default_domain_resolver` 都指向它，于是没有任何规则需要为改 tag 而抄文件：mac / iOS 用底模的 `type: local`（跟随宿主系统解析器），路由变体弃用它、改由设备 overlay 给主路由地址
2. clash API 的监听地址不再由变体写死：底模与 Mac 一致只监听回环，设备 overlay 用标量覆盖
3. 路由侧不再需要底模那份部署域静态应答：`ooooo.space` 已登记在 `config/rules/custom/MyDirect.yaml`（覆盖全部子域），随底模的 `MyDirect-dns → dns-lan` 交给主路由 dnsmasq 应答，与主路由上的固定租约同源；那份通配应答只服务 mac / iOS。前提已在局域网内实测（`dig @<主路由> cpa.int.ooooo.space A` → `192.168.69.46`，`int.ooooo.space` 无应答，与那两条规则的效果一致）

两条约束落在文件名上，写进了 `CODING_STANDARDS.md`：文件名的字典序就是数组次序（两个能力文件都排在 `10-dns.json` 之前），而部署域那一份还必须排在 `09-tailscale-dns.json` 之后 —— iOS 的 `dns.rules` 首条必须是 ts-ep 入站拒绝（`docs/adr/0010`）。两个能力文件因此叫 `10-dns-deployment.json` 与 `10-dns-lan-resolver.json`，mac / iOS 的产物本次只有 tag 改名，数组次序一处未动。

`dns_mode` 的两条路在沙箱 VM 内实测对照过（1.14.3，最小 tun + `auto_redirect`，`nft list table inet sing-box`）：`hijack` 有 8 条带 `dport 53` 的规则（4 条 DNAT 到 tun 的 DNS 地址加 4 条 pre-match），`native` 0 条。

回退：要让路由侧重新拿到静态应答，把 `modules-router/10-dns-deployment.json` 的内容换成 `modules/10-dns-deployment.json` 的两条规则，`route.rules` 不动。跨仓时序：底模先进 `main` 而设备 overlay 还没更新的中间态不会起不来（旧 overlay 自带 `dns-lan` 与那两条规则），但会丢掉 clash API 的局域网监听。

## Consequences

- 名单外设备的连接在预匹配阶段被 `bypass`，由内核直接转发给主路由，不进 sing-box；不适用内核旁路的连接按 `outbound: direct` 经 sing-box 直连。哪些协议能走到内核旁路未在真机验证，由设备验收
- 白名单规则必须限定 `inbound: tun-in`，否则 `dns-in` 的查询也会命中 `invert`，被 direct 送回本机
- 旁路由自身发起的连接既不是白名单源 IP、也没有源 MAC，同样命中 `invert` 被放行；系统更新、拉订阅不经代理
- 改名单、改 `dns-lan` 地址、改放行解析器清单都要改 overlay、重新 `encode` 并替换设备上的订阅 URL；这是 sing-box 客户端现有交付方式的代价，与 Mac / iOS 一致。设备不给 `dns.servers` 的 `dns-lan` 时，底模的 `route.default_domain_resolver` 会让内核 `check` 直接 FATAL（`initialize outbound[0]: default domain resolver not found: dns-lan`），配了出站才触发，所以单份 `template-router.json` 不可 check：本地与 CI 都先经 `scripts/merge-variant-fixture.sh` 装配出终态，设备上是它自己的 overlay
- `dns_mode: native` 之后，内核层不再有 53 端口的 DNAT：设备显式指定的公网解析器按 overlay 的放行规则直出，其余 DNS 仍由 `29-dns-in.json` 与 `30-route-base-rules.json` 的规则劫持。改回 `hijack` 会让放行清单失效
- `template-router.json` 的一致性与结构契约由 `just template-router-check` 与 `config/sing-box/tests/router-template.test.ts` 保证，CI 同口径
- 回滚：删除 `modules-router/` 与 `template-router.json`，设备改回自带的静态配置
