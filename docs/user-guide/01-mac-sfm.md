# Mac + SFM 使用指南

在 macOS 上用 [SFM](https://sing-box.sagernet.org/clients/apple/)（sing-box for Mac）承载 sbtools
服务端产出的配置。前置：已按 [00-cli-sync.md](./00-cli-sync.md) 完成 sbtools 安装与订阅 URL 生成。

架构与加密细节见 [sbtools 架构](../sbtools.md)。

## 一次性导入

本机只需要贴一次 URL，之后由 SFM 自行拉取：

1. 打开 SFM → `Profiles` → `New Profile` → 类型选 `Remote`
2. 名称随意（如 `singbox`），URL 填 `sbtools encode` 产出的订阅 URL
3. 保存后 SFM 立即拉取一次；主界面选中该 profile → 开关 OFF→ON 启动

`Remote` 类型的 profile 内容由 URL 管理，SFM 会按间隔自动重新拉取，因此配置变更不需要再手动导入

## 更新配置

分三种情况：

**改了本机 YAML（`subs` / `nodes` / `overlay` / `template_url`）** — 重新生成 URL 并覆盖 SFM 里的旧值：

```bash
sbtools encode -s <server>
```

密文载荷就是这份配置本身，每次 `encode` 都用新的临时密钥与随机 nonce，所以 URL 必然变化。
**必须**把新 URL 贴回 SFM 覆盖旧值：profile 存的是 URL 字符串，不更新就永远拉的是旧配置。

改完先跑一次离线校验，在重贴 SFM 之前确认 overlay 合法且真的生效：

```bash
sbtools check -c ~/.config/sing-box/config.yaml
```

它把 overlay 合到底模上跑内核 `check` 并打印生效摘要（`dns.rules` 逐条、`route.default_domain_resolver`、
`log.level`）。两条典型问题它当场拦下：overlay 引用一个没声明的 `rule_set`（SFM 里才会
`FATAL ... rule-set not found`），以及改动被底模盖过没生效。

**只改了本机配置文件之外的东西**（服务端底模文件、机场订阅里新增的节点）— 无需任何操作。
服务端每次 `/sub` 请求都现拉订阅、现加载底模，SFM 下次定时拉取即取到新内容。

**换了服务端地址或轮换了服务端密钥** — 同第一种，重新 `encode` 并覆盖 URL。

URL 本身不含时间戳，不会过期；变化的只是它承载的密文

## 面板与节点切换

- 菜单栏图标 → `Open Dashboard`（或浏览器访问 `http://127.0.0.1:9090/ui`）打开 Web 面板
- `Proxies` 页：列出全部策略组，点击组内节点即切换出口；`openai` 组等专用组独立切换
- `Connections` 页：实时连接与命中规则排查

## DNS 与业务出口

- HK 不可用拖累其他业务解析：DNS 使用独立的 `dns-auto` 自动组，候选范围与测速周期见[底模](../../config/sing-box/template.json)，网站与 AI 的业务出口仍由各自策略组选择
- 地区与协议不同不保证故障域独立：查看装配产物中的真实候选，至少验证两条非同故障域的出口；没有匹配候选时现有装配器会裁剪空组并回退 DNS 出口，不能保证自动容灾
- HTTP 测速成功不保证 DoH 可用：故障恢复受测速周期、探测超时和平台网络状态影响，不保证首个失败查询自动重试
- 手动切换业务节点会关闭旧连接：未完成的 AI 流式响应、上传与下载可能中断
- 普通 DNS 解析结果随缓存文件跨重启保留：内核重启或配置重载后无需重新向上游解析常用域名，但首次访问的新域名仍依赖出口可用
- 局域网域名过期缓存不返回旧地址：TTL 过期后向本地上游重新解析，设备更换 IP 后不再连错；本地 DNS 暂时不可用时 LAN 域名会等待新答案而非用旧记录

## 已知行为与坑

- **三个网段必须互斥**：TUN 网段 `198.51.100.1/30`（TEST-NET-2 保留段）、FakeIP 池
  `198.18.0.0/15`、`route_exclude_address`（内网直连段）。历史教训：
  TUN 曾用 `172.19.0.1/30` 落在排除段 `172.16.0.0/12` 内 → 劫持 DNS 包绕过 TUN →
  系统解析器黑洞（尸检 001）；SFM 不会改写 TUN 网段，产物写什么就是什么
- **节点服务器 IP 需反回环直连**：节点 domain/IP 若被再次代理会形成回环。服务端装配时自动
  生成 `route.rules` 首条直连规则，无需手工维护
- **策略组可能被跳过**：订阅里没有某地区节点时，该地区策略组整体不出现，并输出告警。
  国家组不被路由规则引用，少一个不影响分流
- **改服务端已上线部署后需重出 URL**：服务端地址变化后 SFM 仍拉旧地址，表现为拉取失败

## 排查

配置拉不下来时按顺序看：

```bash
# 1. 服务端是否在线
curl -s https://<server>/healthz          # 期望 ok

# 2. 公钥是否可获取（客户端 encode 依赖它）
curl -s https://<server>/pubkey           # 期望 64 位十六进制

# 3. 用同一条 URL 手工拉一次，看 HTTP 码与响应体
curl -s -o /tmp/sub.json -w '%{http_code}\n' '<订阅 URL>'
```

| 现象 | 原因 |
| :--- | :--- |
| 403 | 密文损坏或用了错误公钥加密（服务端轮换过密钥），重新 `sbtools encode` |
| 400 | 载荷结构非法、订阅抓取失败，或 `sing-box merge` 报错（响应体会带 sing-box 的报错摘要） |
| 404 | 路径不对，`/sub` 之外一律 404 |
| 拉取超时 | 服务端拉机场订阅慢（单次上限 10s） |

底模在每次 `/sub` 请求时加载：`template_url` 指向的远端文件改后即时生效；未配 `template_url`
时用的是服务端二进制的编译期内嵌底模，改动需重新构建并重启服务端
