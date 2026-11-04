# 路由器：单臂旁路由与设备白名单

在家里的一台 Linux 设备（单网口旁路由）上跑 sing-box，局域网设备把网关指向它。路由器底模 `template-router.json` 在 Mac 底模之上的差异见下表，哪些设备走代理由你自己的 overlay 决定，名单外的设备由内核直接转发给主路由。设计与取舍见 [ADR-0012](../adr/0012-router-template-for-side-router.md)

## 与 Mac 底模的差异

| 位置              | Mac                | 路由器                                                                            |
| :---------------- | :----------------- | :-------------------------------------------------------------------------------- |
| tun               | `auto_route`       | `auto_route` + `auto_redirect`（nftables 接管转发流量，白名单的 `bypass` 依赖它） |
| tun 的 `dns_mode` | 默认 `hijack`      | `native`，53 端口改由路由规则接管，见「DNS 归属」                                 |
| DNS 入口          | 只靠 tun 劫持      | 另有 `dns-in`，监听 53 端口，供把 DNS 指向旁路由的设备使用                        |
| 本网解析器        | `dns-lan`（`type: local`，共享底模 `modules/10-dns-lan-resolver.json`） | tag 同为 `dns-lan`，但路由变体用同名空集弃用底模的定义，地址由 overlay 提供         |
| clash API         | `127.0.0.1:9090`   | 监听地址由 overlay 的 `external_controller` 覆盖成 `0.0.0.0:9090`，面板可从局域网连接；`secret` 由 overlay 设置 |
| `mixed-in`        | `127.0.0.1:2080`   | 不变                                                                              |

## 前置

- Linux，nftables 可用，sing-box 1.14 及以上（`source_ip_cidr` 与 `action: bypass` 均自 1.14 起可用）
- 旁路由自身的系统 DNS 指向主路由。本网解析器 tag 三份底模统一是 `dns-lan`：mac / iOS 由共享底模的 `type: local` 定义，路由变体把它弃用（`type: local` 对 `*.local.` 固定走内置 mDNS，旁路由上没有应答者），地址改由 overlay 的 `dns-lan` 提供；`dns-lan` 填主路由地址，指回本机会绕成环
- 内核开启转发，单网口时关闭 ICMP 重定向（否则内核会让客户端改走主路由，绕过旁路由）
- 要走代理的设备：网关与 DNS 都指向旁路由。DNS 指向主路由时查询在同网段直达，fakeip 用不上

## 配置

路由器单独一份 yaml，`template_url` 指向路由器底模。白名单、`dns-lan` 地址、放行解析器清单、clash API 的监听地址与 secret 都写在 overlay 里，随载荷加密，不进任何仓库

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
        { "source_ip_cidr": ["<IP1>/32", "<IP2>/32"], "invert": true, "server": "dns-lan" }
      ]
    },
    "route": {
      "rules": [
        {
          "inbound": ["tun-in"],
          "ip_cidr": ["223.5.5.5/32"],
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

| overlay 内容                              | 作用                                                                                                                                                  |
| :---------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dns.servers` 的 `dns-lan`                 | 必填。路由变体用 `modules-router/10-dns-lan-resolver.json` 的空集弃用了共享底模的 `type: local` 定义，地址只能由这里给。底模的 `Lan-dns`、`local` / `lan` / `home.arpa`、`MyDirect-dns`、`clash_mode: direct`、`PTR` 五处 DNS 规则与 `route.default_domain_resolver` 都指向这个 tag。底模因此单份不可 check：缺了它，终态装配后内核直接 FATAL（`initialize outbound[0]: default domain resolver not found`），设备上表现为 sing-box 起不来 |
| `dns.rules` 的 `invert` 规则               | 名单外设备若也把 DNS 指向旁路由，返回真实 IP 而不是 fakeip                                                                                            |
| `route.rules` 的放行解析器规则             | 发往清单内解析器的查询不进本机 DNS 模块，直接由内核放行                                                                                                |
| `route.rules` 的 53 劫持规则               | `inbound: tun-in` + `port: 53` 的其余查询按底模的方式劫持到本机 DNS，与 `dns_mode: hijack` 时期的行为一致                                             |
| 路由规则 `bypass`                          | 名单外设备的连接在 `auto_redirect` 的预匹配阶段被旁路，由内核直接转发，不进 sing-box；不适用内核旁路的连接按 `outbound: direct` 直连                 |
| `inbound: tun-in`                          | 必填，且只能放在外层 AND 里：`invert` 反转整条规则的所有条件，写在同层会连 `inbound: tun-in` 一起反转，`dns-in` 的查询会被 direct 送回本机 53 端口    |
| `clash_api.external_controller`            | 必填。底模与 Mac 一致只监听 `127.0.0.1:9090`，给局域网监听的地址由这里覆盖；漏了面板连不上                                                             |
| `clash_api.secret`                         | 必填。clash API 对局域网监听，没有 secret 时任何设备都能切换你的节点                                                                                   |

overlay 的规则排在底模所有规则之前（只落后于服务端生成的反回环规则），所以上面几条最先生效

三条 `route.rules` 的顺序是固定的，从前往后不能换：

1. **放行解析器**：给设备显式指定的公网解析器留出口，必须先于下面的 53 劫持
2. **53 劫持**：其余 DNS 查询仍由本机应答
3. **白名单 `bypass`**：匹配的是「不在名单里」的整台设备，放在前面会把名单外设备的 DNS 也一起放走

名单地址用 IP 或 MAC 都能写，但透明 DNS 的查询在 `auto_redirect` 的预匹配阶段取不到源 MAC，名单内设备会被当成名单外，拿到真实地址而不是 fakeip，所以按 IP 放行更可靠。名单里的地址要在主路由上配固定租约

同时按 MAC 与 IP 放行（命中任一即放行）时，把条件合成一条内层 `or`，`invert` 放在 `or` 上：

```json
{
  "type": "logical",
  "mode": "and",
  "rules": [
    { "inbound": ["tun-in"] },
    {
      "type": "logical",
      "mode": "or",
      "invert": true,
      "rules": [
        { "source_mac_address": ["<MAC1>"] },
        { "source_ip_cidr": ["<IP1>/32"] }
      ]
    }
  ],
  "action": "bypass",
  "outbound": "direct"
}
```

先离线校验，再生成订阅 URL：

```bash
sbtools check -c ~/.config/sing-box/router.yaml
sbtools encode -s https://<订阅服务> -c ~/.config/sing-box/router.yaml
```

把 URL 交给路由器的拉取程序（如定时 `curl` 后 `sing-box check` 再替换配置）。改名单、改 `dns-lan`、改放行清单都要重新 `encode` 并替换路由器上的 URL

## DNS 归属

底模只留与部署无关的部分，按「可独立变化的事实」拆文件：部署域的静态应答在 `modules/10-dns-deployment.json`、本网解析器定义在 `modules/10-dns-lan-resolver.json`，路由变体用同名的空集文件弃用它们，地址与放行清单则由设备 overlay 提供。两个根因：

- 底模里的 `local` / `lan` / `home.arpa` 指向 `dns-lan` 而不是系统解析器。sing-box 的 Local 服务器对 `*.local.` 与链路本地反查域固定走内置 mDNS（<https://sing-box.sagernet.org/configuration/dns/server/mdns/>），mDNS 没有否定应答，没有应答者时只有超时 —— 客户端连 SERVFAIL 都收不到。旁路由上没有 avahi、nsswitch 也没有 mdns 模块，这个语义没有意义
- tun 的 `dns_mode` 是 `native`。`hijack` 配 `auto_redirect` 时，内核在**规则预匹配之前**无差别把 53 端口 DNAT 到 tun 的 DNS 地址（`address` 之后的那个地址），规则层的 `bypass` 看不到这些包，设备指定的公网解析器因此被本机改写

`local` / `lan` / `home.arpa` 是 RFC 保留后缀，与部署无关，留在底模

部署域 `ooooo.space` 在路由侧不需要底模那份静态通配应答：它已登记在 `config/rules/custom/MyDirect.yaml`（编译成 `DOMAIN-SUFFIX,ooooo.space`，覆盖全部子域），随底模的 `MyDirect-dns → dns-lan` 交给主路由的 dnsmasq 应答，答案与固定租约天然一致。要改回固定应答，把 `modules-router/10-dns-deployment.json` 的内容换成 `modules/10-dns-deployment.json` 里的两条规则即可（`route.rules` 不动）

## 验证

- 名单内的设备：访问代理站点正常，clash API 面板能看到它的连接
- 名单外的设备：照常上网，面板的连接列表里没有它的 TCP 连接
- 名单外设备把 DNS 指向旁路由时拿到真实 IP；名单内设备拿到 fakeip
- 局域网设备 `dig @<放行清单里的解析器> <只在内网存在的域名>` → NXDOMAIN（该解析器的真实应答）
- 在旁路由上 `nft list tables` 能看到 sing-box 自己的表；`nft list chain inet sing-box prerouting` 里没有 53 端口的 DNAT

## 注意

- 手机默认对每个 Wi-Fi 使用随机或轮换的 MAC，按 MAC 放行时要把家里这个 Wi-Fi 的「私有地址」改成固定，否则白名单匹配不上；按 IP 放行不受影响，但要在主路由上配固定租约
- 旁路由自身发起的连接查不到源 IP/MAC，同样命中 `invert` 被放行，不经代理
- 哪些连接能走到内核旁路依赖内核与 sing-box 的实现，沙箱只验证了配置合法与规则顺序，以真机的连接列表为准
