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
4. clash API 的监听地址与 `secret` 都不进底模：底模与 Mac 一致监听 `127.0.0.1:9090`，设备 overlay 用标量覆盖（overlay 先者胜，`docs/sbtools.md` §6）
5. 白名单写在设备 overlay：路由规则 `inbound: tun-in` + `source_mac_address` + `invert` + `action: bypass` + `outbound: direct`；DNS 规则 `source_mac_address` + `invert` → 本网解析器 tag。写法见 `docs/user-guide/05-router.md`

## 补充：白名单改用源 IP（`source_mac_address` 在透明 DNS 上取不到）

**日期**：2026-11-04

`auto_redirect` 的预匹配阶段拿不到源 MAC，名单内设备在 DNS 路径上被当成名单外，拿到真实地址而不是 fakeip；接管到的 TCP 交回内核时入接口是 tun0，输入链的 conntrack 检查会丢弃，透明 TCP 查询超时。白名单因此改用 `source_ip_cidr`，DNS 与路由两处用同一份地址列表，设备在主路由上配固定租约。`source_mac_address` 的写法仍可用，但不适合按设备放行透明 DNS 的部署

## 定稿：DNS 归属拆成能力文件，本网解析器 tag 统一为 `dns-lan`

**日期**：2026-11-04（#147、#148）

三个问题同源：tun 起初用默认的 `dns_mode: hijack`；共享 `10-dns.json` 把本网名字交给 `dns-local-system`（`type: local`）并把部署域名与内网入口写死在底模；改一个 clash API 监听地址要付出一整份 `modules-router/90-experimental.json`。前两个让设备显式指定的公网解析器在内核预匹配阶段被改写、让 RFC 保留后缀落进 mDNS 分支；第三个暴露的是变体接口本身：合并在 `modules/` 之上做「同名替换、其余新增」，删不掉条目，于是「这个角色不要」只能靠整份拷贝表达，共享文件一改就静默漂移。

1. 变体接口收窄到能力文件。底模按可独立变化的事实拆出 `modules/10-dns-deployment.json`（部署域与内网入口的静态应答，只服务 mac / iOS）与 `modules/10-dns-lan-resolver.json`（本网解析器的 `type: local` 定义）。变体要丢掉某一份，就在变体目录放同名的空集文件（`{"dns":{"rules":[]}}` / `{"dns":{"servers":[]}}`），不写 `{}`：显式空集让「不要这一份」在文件里读得出来。两个文件名都排在 `10-dns.json` 之前，部署域那一份还必须排在 `09-tailscale-dns.json` 之后 —— iOS 的 `dns.rules` 首条是 ts-ep 入站拒绝（`docs/adr/0010`），约定写进 `CODING_STANDARDS.md`
2. 本网解析器的 tag 在共享底模与三个角色之间统一为 `dns-lan`。共享 `10-dns.json` 的五处 `server` 引用与 `20-route-base.json` 的 `default_domain_resolver` 都指向它，变体不再为了改引用而抄整份文件。mac / iOS 用底模的定义（`type: local`，跟随宿主系统解析器），路由变体弃用它、由设备 overlay 给主路由地址：`type: local` 对 `*.local.` 与链路本地反查域固定走内置 mDNS，没有应答者时只有超时，连 SERVFAIL 都收不到
3. `modules-router/00-inbounds.json`：`dns_mode` 由 `hijack` 改 `native`。`hijack` 配 `auto_redirect` 时内核在规则预匹配之前无差别把 53 端口 DNAT 到 tun 的 DNS 地址，规则层的 `bypass` 看不到这些包；`native` 不再做内核侧 DNS 接管，53 的接管回到 `29-dns-in.json` 与 `30-route-base-rules.json` 的规则里，顺序由 overlay 决定。沙箱 VM 内实测（1.14.3，最小 tun + `auto_redirect` 配置，`nft list table inet sing-box`）：`hijack` 有 8 条带 `dport 53` 的规则（4 条 `dnat to <tun 的 DNS 地址>` 加 4 条 pre-match），`native` 0 条
4. 路由变体弃用部署域的静态应答：`ooooo.space` 已登记在 `config/rules/custom/MyDirect.yaml`（编译成 `DOMAIN-SUFFIX,ooooo.space`，覆盖全部子域），随底模的 `MyDirect-dns → dns-lan` 交给主路由的 dnsmasq 应答，与主路由上的固定租约天然一致，底模那份通配应答只服务 mac / iOS。回退方式：把 `modules-router/10-dns-deployment.json` 的内容换成 `modules/10-dns-deployment.json` 的两条规则，`route.rules` 不动
5. 设备 overlay 提供四样：`dns.servers` 的 `dns-lan`、放行（不被改写）的解析器清单、白名单、clash API 的监听地址与 `secret`。`route.rules` 的顺序固定为 放行解析器 → 53 劫持 → 白名单 `bypass`：放行必须给设备留出口，白名单 `bypass` 匹配整台设备，放前面会把名单外设备的 DNS 一起放走
6. `modules-router/` 的差异面由 `config/sing-box/tests/router-template.test.ts` 与 `just template-variant-check router` 保证；底模引用不到只有 overlay 才有的 `dns-lan`，终态装配的夹具是 `config/sing-box/tests/fixtures/router-overlay.json`（TEST-NET-1 占位地址），测试与 justfile 读同一份

## Consequences

- 名单外设备的连接在预匹配阶段被 `bypass`，由内核直接转发给主路由，不进 sing-box；不适用内核旁路的连接按 `outbound: direct` 经 sing-box 直连。哪些协议能走到内核旁路未在真机验证，由设备验收
- 白名单规则必须限定 `inbound: tun-in`，否则 `dns-in` 的查询也会命中 `invert`，被 direct 送回本机
- 旁路由自身发起的连接既不是白名单源 IP、也没有源 MAC，同样命中 `invert` 被放行；系统更新、拉订阅不经代理
- 改名单、改 `dns-lan` 地址、改放行解析器清单都要改 overlay、重新 `encode` 并替换设备上的订阅 URL；这是 sing-box 客户端现有交付方式的代价，与 Mac / iOS 一致。设备不给 `dns.servers` 的 `dns-lan` 时，底模的 `route.default_domain_resolver` 会让内核 `check` 直接 FATAL（`initialize outbound[0]: default domain resolver not found: dns-lan`），配了出站才触发，所以单份 `template-router.json` 不可 check：本地与 CI 都先经 `scripts/merge-variant-fixture.sh` 装配出终态，设备上是它自己的 overlay
- `dns_mode: native` 之后，内核层不再有 53 端口的 DNAT：设备显式指定的公网解析器按 overlay 的放行规则直出，其余 DNS 仍由 `29-dns-in.json` 与 `30-route-base-rules.json` 的规则劫持。改回 `hijack` 会让放行清单失效
- `template-router.json` 的一致性与结构契约由 `just template-router-check` 与 `config/sing-box/tests/router-template.test.ts` 保证，CI 同口径
- 回滚：删除 `modules-router/` 与 `template-router.json`，设备改回自带的静态配置
