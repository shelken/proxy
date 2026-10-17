# iOS：一个 VPN 同时代理与访问 Tailscale 内网

iOS 同一时间只能开一个 VPN，sing-box 与独立的 Tailscale App 不能并存。iOS 底模 `template-ios.json` 在 sing-box 内嵌 Tailscale 客户端，代理与内网访问共用这一个 VPN。子网和节点名不写在配置里，由 Tailscale 已获批的路由自动决定

## 流量去向

| 访问目标 | 去向 |
| :--- | :--- |
| Tailscale 已认领的子网（如 `*.int.ooooo.space` 解析出的内网地址） | Tailscale |
| Tailnet 节点的 MagicDNS 名 | Tailscale |
| 未被 Tailscale 认领的私网地址（如家里打印机） | 直连 |
| 国内站点 | 直连，与 Mac 相同 |
| 其他站点 | 代理，与 Mac 相同 |

## 前置：Tailnet 侧

- 开启 MagicDNS
- 某台在线设备作为子网路由器，发布并在控制台批准你要访问的子网
- ACL 或 grants 允许 sing-box 这个新设备访问目标地址与端口
- 客户端内置的 sing-box 内核至少为 1.14，并包含 Tailscale endpoint，具体取决于所用客户端的构建，本仓库无法替你确认

sing-box 内嵌的 Tailscale 是独立的设备身份，不会继承 iOS Tailscale App 的登录状态

## 配置

iOS 单独用一份 `config.yaml`，`template_url` 指向 iOS 底模，其余写法与 [00-cli-sync.md](./00-cli-sync.md) 相同

```yaml
subs:
  - https://example.com/sub
template_url: https://raw.githubusercontent.com/shelken/proxy/main/config/sing-box/template-ios.json
```

| 字段 | 说明 |
| :--- | :--- |
| `template_url` | 指向 `template-ios.json`，替代 Mac 使用的 `template.json`。远端文件更新后，下次拉取订阅即生效，不需要重启服务端 |

按 [01-mac-sfm.md](./01-mac-sfm.md) 的方式 `encode` 生成订阅 URL，再把 URL 导入 iOS 客户端的远程配置

底模已通过 sbtools 的远程底模校验：只含合法 JSON，不含 `certificate_path` 等禁用字段，体积远小于 1 MB 上限

## 首次登录

底模没有写入 `auth_key`，不要把它写进配置或订阅。Tailscale endpoint 在未登录时会进入等待认证状态，并通过平台通知提供登录链接，按链接登录即可。登录界面的具体表现取决于客户端

## 验证

按顺序检查，每步都应符合预期

| 步骤 | 访问 | 预期 |
| :--- | :--- | :--- |
| 1 | 蜂窝网络下打开内网服务 | 能访问，客户端日志显示出站为 `ts-ep` |
| 2 | 访问子网路由器的 MagicDNS 名 | 能解析并访问 |
| 3 | 访问国内站点 | 直连 |
| 4 | 访问需要代理的站点 | 走代理 |
| 5 | 在家 Wi‑Fi 访问家里未被认领的设备 | 直连 |

## 与 Mac 底模的差异

| 项目 | Mac `template.json` | iOS `template-ios.json` |
| :--- | :--- | :--- |
| TUN 排除私网 | 排除 `10/8`、`172.16/12`、`192.168/16` | 只排除 `fe80::/10`，私网流量进入 sing-box 再分流 |
| Tailscale | 无 | 内嵌 endpoint `ts-ep` 与 MagicDNS |
| Tailnet 入站 | 无 | 路由与 DNS 均拒绝来自 `ts-ep` 的入站，手机只作客户端 |

两者的 `MyProxy`、国内直连、拦截等分流规则完全相同

## 排障

| 现象 | 检查 |
| :--- | :--- |
| 内网地址访问超时 | 子网路由是否已在控制台批准，子网路由器是否在线，ACL 是否放行 |
| MagicDNS 名解析失败 | 控制台是否开启 MagicDNS，名称是否为节点的实际名称 |
| 家里的设备突然不通 | 家庭网段是否与 Tailscale 发布的子网重叠，重叠的目标会被送进 Tailnet |
| 始终等待登录 | 是否已按通知中的链接完成登录 |

## 限制

- 入站拒绝只约束进入 sing-box 路由与 DNS 的流量。Taildrop 等 Tailscale 自身的 PeerAPI 能力由 Tailnet 的文件共享策略控制，不受这些规则约束
- 以下依赖真实设备与 Tailnet，文档不作保证：状态目录在重启后保留登录、锁屏与切网后的恢复、子网路由撤销后的行为
- 决策背景见 [ADR-0010](../adr/0010-ios-template-with-embedded-tailscale.md)
