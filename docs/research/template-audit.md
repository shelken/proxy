# 底模配置审查

审查对象：`config/sing-box/template.json`、`scripts/sb-sync-rs/src/assemble.rs` 与装配层顺序，运行内核为项目锁定的 sing-box 1.14.1

## 证据边界

网络实验在 Lima VM 的独立网络命名空间运行，使用本地 UDP DNS、SOCKS 与 TLS DoH 服务，不读取订阅、节点或生产配置，不改变宿主网络

协议隔离实验验证 DNS 兜底、拒绝响应、缓存重启、TUN 路由；永久行为测试直接加载底模 DNS 配置，把上游端点替换为本地服务，规则集使用不匹配测试域的夹具。它验证默认分支的查询行为，不代表所有远程规则集或 Apple NetworkExtension 行为

## 严重程度与处理

| 原编号 | 结论 | 严重程度及范围 | 处理 |
| --- | --- | --- | --- |
| 1 | 未命中前置规则的 HTTPS、TXT 等查询使用真实 DNS 兜底，不能从中推出必须拒绝 HTTPS | 隐私策略风险，不是已证明的污染或断网 | 用户选择代理解析：保留记录，使用经 proxy 出站的加密 DNS 兜底 |
| 2 | 未持久化时，重启后同一 FakeIP 可被另一个域名重新分配 | P1，客户端仍缓存旧地址时可能错配目标 | 开启持久化；正常重启实测，崩溃瞬间的落盘保证未测 |
| 3 | 默认 TUN DNS 地址自动劫持不等于接管任意目的地址的 53 端口 | P2，DNS 管理策略覆盖范围 | 嗅探后接管 DNS 协议及目的端口 53 |
| 4 | 地区测速组未被业务组显式引用，正则只展开物理节点 | 功能选择，不是已证实的高危故障 | 保留，见下文 |
| 5 | tailscale selector 无路由或其他组的显式引用 | 清理项 | 移除，不改变 Tailscale CGNAT 排除或进程直连规则 |
| 6 | predefined 默认 NOERROR，空答案有效 | 无缺陷 | 保留 |
| 7 | Linux 实验中环回原本走 lo，有限广播原本走 TUN，排除后改走测试上联网卡 | P2，广播路由边界；没有证明应用故障 | 保留明确排除，Apple 平台未实测 |
| 8 | 新版 UDP DNS 默认直连，detour 指向空 direct 出站会启动失败 | 原建议引入 P1 启动回归 | 删除该 detour，保留默认拨号 |

未发现有证据支持的原底模 P0 全局故障

## 实测结果

| 实验 | 对照结果 |
| --- | --- |
| A 与 HTTPS/TXT | A 返回 FakeIP；本地真实上游收到 Type 65 与 Type 16 |
| HTTPS reject | 返回 RCODE 5（REFUSED），HTTPS 答案丢失 |
| 代理 DoH | HTTPS 答案数 1；HTTPS/TXT 两次请求经过 SOCKS→TLS DoH，UDP 上游计数 0 |
| FakeIP 正常重启，无持久化 | first.test 与重启后的 second.test 均获得 198.18.0.2 |
| FakeIP 正常重启，有持久化 | first.test 保持原地址，second.test 获得另一地址 |
| predefined 空应答 | RCODE 0（NOERROR），答案数 0 |
| 空 direct detour | 内核启动报 `detour to an empty direct outbound makes no sense` |
| TUN 默认 DNS 地址 | 不额外配置劫持规则也能返回 FakeIP |
| 其他目的地址 53 端口 | 实验的拒绝兜底不返回答案；新增劫持规则后返回 FakeIP |
| 广播排除 | 255.255.255.255 从 audit0 改走 uplink；127.0.0.1 前后均为 lo |

复现永久 DNS 行为测试，需要现成 VM 内的 bun、sing-box、openssl、ip 与 unshare，无需安装依赖：

```sh
GUEST_REPO="/host-home${PWD#$HOME}"
limactl shell --workdir /work proxy-test sudo -n unshare --net sh -c \
  "ip link set lo up && /opt/proxy-test/bin/bun test '$GUEST_REPO/config/sing-box/tests/dns-behavior.test.js'"
```

## 断言有效性（反向验证）

每条断言都先证明它会在被测行为缺失时失败，否则「通过」不构成证据。

| 序号 | 反向操作 | 结果 |
| --- | --- | --- |
| 1 | 删去 `dns-proxy`、`final` 改回 `dns-direct-cn` | `dohQueries` 期望 2 实收 0，测试失败 |
| 4 | 把 `hk` 加进 `proxy` 候选池 | 报「proxy 候选池不应引用地区测速组，实际引用了 ["hk"]」 |
| 5 | 把 `tailscale` selector 加回 `outbounds` | 报「tailscale 组不应出现在装配产物中」 |

三条都先在缺失状态下失败，再在修复后通过。

## 逐项验证证据

| 序号 | 验证方式 | 证据 |
| --- | --- | --- |
| 1 | VM 独立网络命名空间，真实内核 + 本地 TLS DoH | `dns-behavior.test.js` 通过，含反向验证 |
| 2 | 同上，正常重启前后对照 | 无持久化时两域名同址；有持久化时首域名保持原址 |
| 3 | 剥离实验的 TUN 对照与路由观测 | 默认 DNS 地址自动处理；其他目的地址 53 需额外劫持 |
| 4 | 真实 `finalize` 装配产物 + 反向验证 | `assembled_groups_isolate_region_urltest_and_drop_tailscale` 通过 |
| 5 | 同上 | 产物中无 `tailscale`；Rust 全量 159 项通过 |
| 6 | 真实内核 predefined 响应 | RCODE 0，答案数 0 |
| 7 | 剥离实验的路由表观测 | 255.255.255.255 排除后改走上联网卡 |
| 8 | 真实内核启动 | 带空 direct detour 的配置启动即 FATAL |

命令：

```sh
cargo test --workspace                                    # 159 项
just check-singbox && just rules-check
SING_BOX=$(which sing-box) bun test config/sing-box/tests/template.test.ts
GUEST_REPO="/host-home${PWD#$HOME}"
limactl shell --workdir /work proxy-test sudo -n unshare --net sh -c \
  "ip link set lo up && /opt/proxy-test/bin/bun test '$GUEST_REPO/config/sing-box/tests'"
```

完整 TUN 对照实验的配置、脚本与日志随审查工件提供；Linux 隔离实验不能替代 SFM 真机验证

## 第 4 项：测速组的作用与代价

`populate_selectors` 把正则匹配限定在订阅节点标签，`.*` 不会自动把 hk、jp 等策略组加入 proxy。组引用必须显式填写

```text
业务规则 → proxy → selfhost 或物理节点
地区测速 → hk/jp/... → 对应地区物理节点
```

这种配置不会自动使用地区测速结果调度业务连接。如果需要自动切换，才把相应组加入业务 selector，由用户选择该组；只添加候选不会改变原来的默认选择

这属于能力取舍：自动切换可能改善故障恢复，也可能改变出口 IP。当前组开启切换时中断既有连接，接入自动测速后尤其需要考虑长连接和登录会话。测速组有默认 30 分钟 idle_timeout，不能仅凭 interval 就断言永远持续空转或量化耗电

保留当前配置，不以 P1 缺陷驱动重构

## 第 6 项：空答案与拒绝的差别

```text
predefined + 无 answer/rcode → NOERROR + 空答案
reject                       → REFUSED
```

前者表达成功响应但没有该类型答案，后者表达拒绝处理查询。内核实测与官方默认值一致，没有证据表明这条空应答会使 macOS 解析器悬挂。不改成 REFUSED，也不添加重复的 NOERROR 默认值

## 配置边界与副作用

- 代理 DNS 兜底依赖 proxy 的可用性，失败时不自动退回国内上游；本地、国内、PTR 与 direct 模式仍按先匹配规则处理
- HTTPS 记录可携带 ALPN、地址提示及 ECH 参数，保留答案不会保证客户端一定使用 ECH；本次没有测试浏览器 ECH
- DNS 劫持只覆盖实际进入内核且到达这条规则的流量，不能覆盖被 TUN 排除的 LAN、加密 DoH/DoT 或更早的终结路由规则
- 反回环层排在 overlay 与底模之前，已命中的 route(direct) 不会再执行底模 sniff；此前把这类 SSH 失败直接归因于 sniff 缺少依据
- 本次不修改测速策略、UDP QUIC 拒绝策略、IPv6 部署策略或控制面访问策略，未把缺省配置列为故障

## 一手来源

- [DNS HTTPS 上游与默认拨号](https://sing-box.sagernet.org/configuration/dns/server/https/)
- [新版 UDP DNS 默认直连](https://sing-box.sagernet.org/configuration/dns/server/udp/)
- [DNS reject 与 predefined 默认值](https://sing-box.sagernet.org/configuration/dns/rule_action/)
- [TUN dns_mode 与 dns_address](https://sing-box.sagernet.org/configuration/inbound/tun/)
- [FakeIP 持久化](https://sing-box.sagernet.org/configuration/experimental/cache-file/)
- [URLTest 空闲与切换语义](https://sing-box.sagernet.org/configuration/outbound/urltest/)
- [RFC 9460：HTTPS/SVCB 记录用途](https://www.rfc-editor.org/rfc/rfc9460)

官方在线文档包含比项目更新的版本内容；本报告的运行结论以 1.14.1 实验为准
