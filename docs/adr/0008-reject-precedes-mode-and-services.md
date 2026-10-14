# 拦截规则先于 clash_mode 与分流服务

**日期**：2026-10-15

`route.rules` 首匹配优先。`clash_mode` 的两条规则只能决定「业务流量走哪条线路」，不能顺手放行广告与黑名单，因此排在拦截规则之后；同理，按域名关键词做分流（曾经的 `torrent`）的规则必须排在拦截之后，否则会截胡本该 reject 的域名

## Context

- `clash_mode: global` 的规则排在 `Advertising` / `Hijacking` / `MyReject` / `Privacy` 的 `reject` 之前，导致该模式下广告与黑名单**全部放行**——`clash_mode` 本是「业务出口」开关，却顺带关掉了拦截
- `torrent` 规则集用 `domain_keyword: [tracker, announce, torrent, peer_id]` 做识别。`domain_keyword` 是子串匹配，且该规则排在 `reject` 之前，于是命中关键词的拦截域名被改成直连而非拒绝，实测：
  - `adeventtracker.spotify.com`（`Advertising`，本应 reject）→ 直连
  - `tracker.xiaomixiaoai.com`（`Advertising`）→ 直连
  - `spider-tracker.xiaohongshu.com`（`MyReject`）→ 直连
- 同一个域名在 DNS 侧被正确 reject（`MyReject-dns` 排在 `torrent-dns` 之前），路由侧却被放行——两侧顺序不一致，故障只在路由层可见
- ADR-0007 只约定了「自有清单先于外部清单」「默认直连靠后」，**没有约定拦截与分流的先后**，于是 `32-torrent` / `34-download` 的号段选择让「分流优先于拦截」成了无人审视的默认

## Decision

1. 拦截类规则（`Advertising` / `Hijacking` / `MyReject` / `Privacy`）排在 `clash_mode` 与全部服务分流规则之前
2. `clash_mode` 的两条规则从 `30-route-base-rules.json` 拆出为 `34-clash-mode.json`，位置在拦截之后
3. 按域名关键词分流的规则集不再排在拦截之前；`torrent` 的域名关键词整体删除（见 ADR-0009）
4. QUIC 守卫（UDP 443/80）维持排在 `resolve` 之前（`reject` 早于 `resolve` 的既有契约不变），但在其前加一条国内直连豁免：命中 `ChinaMax` / `Lan` / `cftunnel` / `geoip-cn` 的走 `direct`，其余才 `reject`；该守卫同时加 `no_drop: true`
5. 顺序契约固化为 `template.test.ts` 断言：非 UDP 守卫的 `reject` 规则必须早于首条 `clash_mode` 规则，且 QUIC 豁免规则必须早于其 `reject`

QUIC 守卫本身是 `e9ea4c3` 的有意设计——机场节点 UDP 承载差、丢包高、易被 QoS，强制客户端从 QUIC 降级到 TCP 走代理，这一意图保留。但它排在全部分流之前，国内 CDN（B 站 / 阿里 / 腾讯 / 抖音）的 HTTP/3 被无差别丢弃，降级 TCP 产生首屏延迟。`no_drop` 的取舍依据在源码：`route/rule/rule_action.go` 的 `RuleActionReject.Error` 在 30 秒内触发超过 50 次后会把 ICMP 不可达退化为静默丢包，届时客户端只能等 QUIC 超时——这才是卡顿的真实来源，首包降级本身只花一个 RTT。豁免依赖 fakeip 反查先于规则匹配：`route/route.go` 的 `matchRule` 先调 `prepareMatchMetadata`（假地址还原为域名）再逐条匹配，故 `ChinaMax` 这类域名规则集在 UDP 路径上可用，`geoip-cn` 覆盖非 fakeip 的裸 IP 目的

## Consequences

- `global` 模式下广告与黑名单恢复正常拦截，BT 直连也不再被 `clash_mode` 短路
- 拦截与 DNS 侧顺序重新对齐，同一域名在两侧得到一致裁决
- 排序策略补上第三条：**拦截 > 模式开关 > 服务分流**。新增服务时若需排在拦截之前，必须显式说明理由
- 回滚：`34-clash-mode.json` 并回 `30`，恢复 `reject` 到 `36` 号段，再 `just template-build`
