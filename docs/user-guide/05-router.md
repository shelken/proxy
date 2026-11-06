# 路由器：单臂旁路由与设备白名单

在家里的一台 Linux 设备（单网口旁路由）上跑 sing-box，局域网设备把网关指向它。路由器底模 `template-router.json` 与 Mac 底模的差异见下表，哪些设备走代理由你自己的 overlay 决定，名单外的设备由内核直接转发给主路由。设计与取舍见 [ADR-0012](../adr/0012-router-template-for-side-router.md)、[ADR-0014](../adr/0014-router-dns-ownership-on-device.md)

## 与 Mac 底模的差异

| 位置              | Mac                                                              | 路由器                                                                              |
| :---------------- | :--------------------------------------------------------------- | :---------------------------------------------------------------------------------- |
| tun               | `auto_route`                                                     | `auto_route` + `auto_redirect`（nftables 接管转发流量，白名单的 `bypass` 依赖它）   |
| tun 的 `dns_mode` | `hijack`                                                         | `native`，53 端口改由路由规则接管，见下文的规则次序                                 |
| DNS 入口          | 只靠 tun 劫持                                                    | 另有 `dns-in`，监听 53 端口，供把 DNS 指向旁路由的设备使用                          |
| 本网解析器        | `dns-lan`（`type: local`，来自 `platforms/mac.yaml`） | 平台层没有这份能力，定义与地址由 overlay 提供                                   |
| 部署域静态应答    | `platforms/mac.yaml` 给 `ooooo.space` 固定应答   | 平台层没有这份能力，答案由主路由 dnsmasq 给                                     |
| clash API         | `127.0.0.1:9090`                                                 | `0.0.0.0:9090`（`platforms/router.yaml`），面板可从局域网连接；`secret` 由 overlay 设置 |
| `mixed-in`        | `127.0.0.1:2080`                                                 | 不变                                                                                |

## 前置

- Linux，nftables 可用，sing-box 1.14 及以上（`.mise.toml` 锁 1.14.3，`dns_mode: native` 与 `action: bypass` 都在这个版本上验过）
- 旁路由自身的系统 DNS 指向主路由。本网解析器的 tag 在三份底模里统一是 `dns-lan`：mac / iOS 由底模的 `type: local` 定义，路由角色不定义它：`type: local` 对 `*.local.` 与链路本地反查固定走内置 mDNS，mDNS 没有否定应答，旁路由上没有应答者时只有超时。所以地址改由 overlay 的 `dns-lan` 提供，填主路由地址；指回本机会绕成环
- 内核开启转发，单网口时关闭 ICMP 重定向（否则内核会让客户端改走主路由，绕过旁路由）
- 要走代理的设备：网关与 DNS 都指向旁路由。DNS 指向主路由时查询在同网段直达，fakeip 用不上

## 配置

路由器单独一份 yaml，`template_url` 指向路由器底模。白名单、`dns-lan` 的地址、放行解析器清单、clash API 的监听地址与 secret 都写在 overlay 里，随载荷加密，不进任何仓库

```yaml
subs:
  - https://example.com/sub
template_url: https://raw.githubusercontent.com/shelken/proxy/main/config/sing-box/template-router.json
overlay: |
  {
    "experimental": {
      "clash_api": {
        "external_controller": "0.0.0.0:9090",
        "secret": "<随机串>"
      }
    },
    "dns": {
      "servers": [{ "type": "udp", "tag": "dns-lan", "server": "<主路由地址>" }],
      "rules": [
        { "invert": true, "server": "dns-lan", "source_ip_cidr": ["<IP1>/32", "<IP2>/32"] }
      ]
    },
    "route": {
      "rules": [
        {
          "inbound": ["tun-in"],
          "ip_cidr": ["<解析器地址>/32"],
          "port": [53],
          "network": ["udp", "tcp"],
          "action": "bypass",
          "outbound": "direct"
        },
        {
          "inbound": ["tun-in"],
          "port": [53],
          "network": ["udp", "tcp"],
          "action": "hijack-dns"
        },
        {
          "type": "logical",
          "mode": "and",
          "rules": [
            { "inbound": ["tun-in"] },
            {
              "type": "logical",
              "mode": "and",
              "invert": true,
              "rules": [{ "source_ip_cidr": ["<IP1>/32", "<IP2>/32"] }]
            }
          ],
          "action": "bypass",
          "outbound": "direct"
        }
      ]
    }
  }
```

| overlay 内容                     | 作用                                                                                                                                                                                                                                                    |
| :------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `dns.servers` 的 `dns-lan`        | 必填。路由角色的列表里没有本网解析器的定义，地址只能由这里给。底模的 `Lan-dns`、`local` / `lan` / `home.arpa`、`MyDirect-dns`、`clash_mode: direct`、`PTR` 五处 DNS 规则与 `route.default_domain_resolver` 都指向这个 tag；缺了它单份底模不可内核 check（`initialize outbound[0]: default domain resolver not found`），设备上表现为 sing-box 起不来 |
| `dns.rules` 的 `invert` 规则      | 名单外设备若也把 DNS 指向旁路由，返回真实 IP 而不是 fakeip                                                                                                                                                                                              |
| `route.rules` 的放行解析器规则    | 发往清单内解析器的查询不进本机 DNS，由内核直接放行；设备显式指定的公网解析器不再被改写                                                                                                                                                                   |
| `route.rules` 的 53 劫持规则      | `inbound: tun-in` + `port: 53` 的其余查询劫持到本机 DNS。tun 用 `dns_mode: native`，这一步只能由规则给                                                                                                                                                   |
| `route.rules` 的白名单 `bypass`   | 名单外设备的连接在 `auto_redirect` 的预匹配阶段被旁路，由内核直接转发，不进 sing-box；不适用内核旁路的连接按 `outbound: direct` 直连                                                                                                                     |
| `clash_api.secret`                | 必填。clash API 对局域网监听，没有 secret 时任何设备都能切换你的节点                                                                                                                                                                                    |

`route.rules` 这三条的次序是固定的：**放行解析器 → 53 劫持 → 白名单 `bypass`**。第一条要给设备显式指定的解析器留出口；白名单那条匹配的是「不在名单里」的整台设备，排在 53 劫持之前会把名单外设备的 DNS 一起放走。overlay 的规则整体排在底模规则之前，所以这三条最先生效

`invert` 反转整条规则，所以「排除白名单」必须两层：外层 AND 限定 `inbound: tun-in`，内层只反转源 IP。写在同一层会把 `dns-in` 进来的查询（不满足 `tun-in`，整条为假）翻成命中，被 `direct` 送回本机 53 端口

先离线校验，再生成订阅 URL：

```bash
sbtools check -c ~/.config/sing-box/router.yaml
sbtools encode -s https://<订阅服务> -c ~/.config/sing-box/router.yaml
```

把 URL 交给路由器的拉取程序（如定时 `curl` 后 `sing-box check` 再替换配置）。改名单或上面那几项就改 overlay、重新 `encode`、替换路由器上的 URL

## 验证

- 名单内的设备：访问代理站点正常，clash API 面板能看到它的连接
- 名单外的设备：照常上网，面板的连接列表里没有它的 TCP 连接
- 内网名字立刻得到否定应答：`dig @<旁路由> <主机>.local` 与 `dig @<旁路由> cpa.int.ooooo.space` 不再等十秒
- 设备显式指定的公网解析器仍然可用：`dig @<旁路由> <域名>` 与直连该解析器的结果一致，没被本机改写
- 在旁路由上 `nft list tables` 能看到 sing-box 自己的表

## 注意

- 白名单按源 IP 匹配：透明 DNS 的查询在 `auto_redirect` 的预匹配阶段取不到源 MAC，按 MAC 放行会让名单内设备在 DNS 路径上被当成名单外。要在主路由上给设备配固定租约
- 手机开随机 MAC 不影响识别；名单外的设备即使把 DNS 指向盒子，拿到的也是真实 IP
- 旁路由自身发起的连接源 IP 不在名单里，同样命中 `invert` 被放行，不经代理
- 哪些连接能走到内核旁路依赖内核与 sing-box 的实现，沙箱只验证了配置合法与规则顺序，以真机的连接列表为准
