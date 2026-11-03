# 路由器：单臂旁路由与设备白名单

在家里的一台 Linux 设备（单网口旁路由）上跑 sing-box，局域网设备把网关指向它。路由器底模 `template-router.json` 在 Mac 底模之上改了三处，哪些设备走代理由你自己的 overlay 决定，名单外的设备由内核直接转发给主路由。设计与取舍见 [ADR-0012](../adr/0012-router-template-for-side-router.md)

## 与 Mac 底模的差异

| 位置       | Mac              | 路由器                                                                            |
| :--------- | :--------------- | :-------------------------------------------------------------------------------- |
| tun        | `auto_route`     | `auto_route` + `auto_redirect`（nftables 接管转发流量，白名单的 `bypass` 依赖它） |
| DNS 入口   | 只靠 tun 劫持    | 另有 `dns-in`，监听 53 端口，供把 DNS 指向旁路由的设备使用                        |
| clash API  | `127.0.0.1:9090` | `0.0.0.0:9090`，面板可从局域网连接；`secret` 由 overlay 设置                      |
| `mixed-in` | `127.0.0.1:2080` | 不变                                                                              |

## 前置

- Linux，nftables 可用，sing-box 1.14 及以上（`source_mac_address` 自 1.14 起支持）
- 旁路由自身的系统 DNS 指向主路由。底模的 `dns-local-system` 用系统解析，指回本机会绕成环
- 内核开启转发，单网口时关闭 ICMP 重定向（否则内核会让客户端改走主路由，绕过旁路由）
- 要走代理的设备：网关与 DNS 都指向旁路由。DNS 指向主路由时查询在同网段直达，fakeip 用不上

## 配置

路由器单独一份 yaml，`template_url` 指向路由器底模。白名单、clash API 的 secret 都写在 overlay 里，随载荷加密，不进任何仓库

```yaml
subs:
  - https://example.com/sub
template_url: https://raw.githubusercontent.com/shelken/proxy/main/config/sing-box/template-router.json
overlay: |
  {
    "experimental": { "clash_api": { "secret": "<随机串>" } },
    "dns": {
      "rules": [
        { "source_mac_address": ["<MAC1>", "<MAC2>"], "invert": true, "server": "dns-local-system" }
      ]
    },
    "route": {
      "rules": [
        {
          "type": "logical",
          "mode": "and",
          "rules": [
            { "inbound": ["tun-in"] },
            {
              "type": "logical",
              "mode": "and",
              "invert": true,
              "rules": [{ "source_mac_address": ["<MAC1>", "<MAC2>"] }]
            }
          ],
          "action": "bypass",
          "outbound": "direct"
        }
      ]
    }
  }
```

| 规则               | 作用                                                                                                                                                                                                                                      |
| :----------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 路由规则 `bypass`  | 名单外设备的连接在 `auto_redirect` 的预匹配阶段被旁路，由内核直接转发，不进 sing-box；不适用内核旁路的连接按 `outbound: direct` 直连                                                                                                      |
| `inbound: tun-in`  | 必填，且要放在外层 AND 里。`invert` 反转的是整条规则的所有条件：把 `inbound` 与 `invert` 写在同一层，`dns-in` 收到的查询（不满足 `tun-in`，整条为假）会被翻成命中，再被 `direct` 送回本机 53 端口绕成环，白名单设备的 DNS 也拿不到 fakeip |
| DNS 规则           | 名单外设备若也把 DNS 指向旁路由，返回真实 IP 而不是 fakeip                                                                                                                                                                                |
| `clash_api.secret` | 必填。clash API 对局域网监听，没有 secret 时任何设备都能切换你的节点                                                                                                                                                                      |

overlay 的规则排在底模所有规则之前（只落后于服务端生成的反回环规则），所以这两条最先生效

按 IP 放行时，把 MAC 与 IP 合成一条 logical 规则，`invert` 放在内层的 `or` 上：

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
        { "source_ip_cidr": ["<IP>/32"] }
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

把 URL 交给路由器的拉取程序（如定时 `curl` 后 `sing-box check` 再替换配置）。改名单就改 overlay、重新 `encode`、替换路由器上的 URL

## 验证

- 名单内的设备：访问代理站点正常，clash API 面板能看到它的连接
- 名单外的设备：照常上网，面板的连接列表里没有它的 TCP 连接
- 在旁路由上 `nft list tables` 能看到 sing-box 自己的表

## 注意

- 手机默认对每个 Wi-Fi 使用随机或轮换的 MAC，要把家里这个 Wi-Fi 的「私有地址」改成固定，否则白名单匹配不上
- 旁路由自身发起的连接查不到 MAC，同样命中 `invert` 被放行，不经代理
- 哪些连接能走到内核旁路依赖内核与 sing-box 的实现，沙箱只验证了配置合法与规则顺序，以真机的连接列表为准
