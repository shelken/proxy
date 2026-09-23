# Mac + SFM 使用指南

在 macOS 上用 [SFM](https://sing-box.sagernet.org/clients/apple/)（sing-box for Mac）承载 sb-sync
服务端产出的配置。前置：已按 [00-cli-sync.md](./00-cli-sync.md) 完成 sb-sync 安装与订阅 URL 生成。

架构与加密细节见 [sb-sync 架构](../sb-sync.md)。

## 一次性导入

本机只需要贴一次 URL，之后由 SFM 自行拉取：

1. 打开 SFM → `Profiles` → `New Profile` → 类型选 `Remote`
2. 名称随意（如 `singbox`），URL 填 `sb-sync encode` 产出的订阅 URL
3. 保存后 SFM 立即拉取一次；主界面选中该 profile → 开关 OFF→ON 启动

`Remote` 类型的 profile 内容由 URL 管理，SFM 会按间隔自动重新拉取，因此配置变更不需要再手动导入

## 更新配置

改了订阅、节点或 overlay 后，只做一件事：

```bash
sb-sync encode <server>
```

新 URL 会写入剪切板。如果 SFM 里 profile 的 URL 没变（服务端地址与密钥都没换），
**无需任何操作**，SFM 下次拉取即生效；想立刻生效就在 SFM 里对该 profile 手动刷新一次

URL 不含时间戳，不会过期。只有在更换服务端地址或轮换服务端密钥时，才需要把新 URL 重新贴进 SFM

## 面板与节点切换

- 菜单栏图标 → `Open Dashboard`（或浏览器访问 `http://127.0.0.1:9090/ui`）打开 Web 面板
- `Proxies` 页：22 大策略组，点击组内节点即切换出口；`openai` 组等专用组独立切换
- `Connections` 页：实时连接与命中规则排查

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
| 403 | 密文损坏或用了错误公钥加密（服务端轮换过密钥），重新 `sb-sync encode` |
| 400 | 载荷结构非法、订阅抓取失败，或 `sing-box merge` 报错（响应体会带 sing-box 的报错摘要） |
| 404 | 路径不对，`/sub` 之外一律 404 |
| 拉取超时 | 服务端拉机场订阅慢（单次上限 10s） |

模板文件由服务端在每次请求时读取（内嵌或 `template_url`），改底模后无需重启服务端
