# BT 直连经策略组下发，tracker 依赖兜底代理

**日期**：2026-10-15

BitTorrent 识别只保留协议嗅探、端口与进程名三类，删除全部域名关键词；直连与代理的选择交给一个候选为 `direct` / `selfhost` / `proxy`、默认 `direct` 的策略组。Tracker 域名不单独建组，落 `final: proxy`

## Context

- 原 `torrent` 规则集用 `domain_keyword: [tracker, announce, torrent, peer_id]` 兜住 tracker 域名。这些关键词是子串匹配，会误伤大量非 BT 域名（`tracker.gg`、`issuetracker.google.com`、`torrentfreak.com`、`libtorrent.org`），且该规则排在拦截之前，把广告与黑名单域名一起截胡（见 ADR-0008）
- 海外 tracker 普遍被墙。命中关键词后走直连 → tracker 握手失败 → 客户端拿不到 peer 列表，下载报红。这正是「tracker 连不上」的根因
- 内核对 BT 的 UDP 侧识别无法区分 tracker 与 peer：`BitTorrent`（TCP 握手）、`UTP`（uTP 包结构）、`UDPTracker`（BEP-15 magic）三个嗅探器全部写入同一个 `metadata.Protocol`，而 `protocol` 字段只匹配单个字符串（`route/rule/rule_item_protocol.go`）。拆 tracker / peer 两个组在技术上做不到干净切分
- 该规则集原先直接 `route` 到 `direct`，无法在客户端切换出口；而 `download` 组已有 `direct` / `selfhost` / `proxy` 候选的先例

## Decision

1. 删除 `torrent.yaml` 的全部 `domain_keyword`，只保留 `process_name`、`port`、`port_range`（协议识别由底模的 `protocol: bittorrent` 规则承担）
2. 新增 `torrent` selector，候选 `direct` / `selfhost` / `proxy`，默认 `direct`
3. 不建 `torrent-tracker` 组：域名关键词删除后，tracker 域名不再被任何规则命中，自然落 `final: proxy`，无需专用规则集
4. `torrent` 规则集不再产出有意义的 `-dns` 伴生（无域名条目），底模删除 `torrent-dns` 的引用与声明

## Consequences

- 广告与黑名单域名不再被 BT 关键词截胡；域名类 tracker（HTTP/HTTPS）恢复走代理
- 误伤归零：不再有域名被 `tracker` / `torrent` 等子串命中
- 残余限制（内核能力边界，无配置可解）：
  - **UDP tracker 与 peer 无法区分，且都落 `torrent` 组（默认 direct）**。`route/rule/rule_action.go` 把 `sniff.UDPTracker` 注册为 `protocol: bittorrent` 的 PacketSniffer，它按 BEP-15 magic（`0x41727101980` + connect flag `0`）识别并写入 `metadata.Protocol = bittorrent`。故 UDP tracker 命中 `protocol: bittorrent` 规则 → `torrent` 组 → 默认 direct。**公网 tracker 以 UDP 为主，境外 UDP tracker 因此仍走直连、仍被墙**；若把 `torrent` 组切到 `proxy`，其 uTP peer 流量会一并进入代理
  - 「tracker 恢复可用」只对 HTTP(S) tracker 域名成立（它们不被任何规则命中，落 `final: proxy`），对 UDP tracker 不成立
  - DHT（KRPC）与 UDP tracker 的 ANNOUNCE 包（非 CONNECT）不被任何嗅探器识别，落 `final: proxy`；`UDPTracker` 只认 CONNECT（`trackerConnectFlag = 0`），后续 ANNOUNCE 包未被正则匹配则由 UDP NAT 会话保持既有裁决
  - MSE/PE 加密的 TCP peer 握手无法识别，本机场景由 `process_name` 兜底，旁路由场景无进程名可查
- 回滚：恢复 `torrent.yaml` 的域名关键词与直连出站，`just rules-build` 后 `just template-build`
