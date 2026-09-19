# sb-sync CLI 同步指南

面向使用任意 arm Mac 的用户。目标：装好 sb-sync，一条命令完成 sing-box 配置的更新与产出。

前置条件只有两个：macOS（Apple Silicon）与 [mise](https://mise.jdx.dev)。不需要本仓库源码。

## 安装

```bash
mise install github:shelken/proxy@latest
```

安装后验证：

```bash
sb-sync --help
```

无 mise 的设备，从 [Releases](https://github.com/shelken/proxy/releases) 下载
`sb-sync-aarch64-apple-darwin`，加执行权限后放入 PATH 即可。

## 初始化

```bash
sb-sync init
```

创建 `~/.config/sing-box/` 目录，并生成两个文件：

| 文件 | 作用 |
| :--- | :--- |
| `store.json` | 节点来源清单（订阅与私有节点） |
| `local.json` | 设备私有覆盖（DNS、置顶路由规则），参考 `config/sing-box/local.json.example` |

## 添加节点来源

两类来源任意组合：

```bash
# 机场订阅（URL）
sb-sync add sub "https://example.com/api/v1/client/subscribe?token=..."

# 自建节点（URI，支持 hysteria2/hy2、anytls、ss）
sb-sync add node "hysteria2://password@host:port/?obfs=salamander&obfs-password=...#SelfHost"
```

查看当前清单（凭据自动打码）：

```bash
sb-sync list
```

移除（序号对应 `sb-sync list` 输出）：

```bash
sb-sync remove sub 1
sb-sync remove node 1
```

## 同步产出

```bash
sb-sync sync
```

单次 sync 完成四件事：

1. **更新底模**：拉取仓库 main 分支最新 `template.json`（失败自动回退本地缓存，再回退二进制内嵌版）
2. **拉取订阅**：抓取全部机场订阅并解析节点
3. **装配**：私有节点排最前，机场节点按订阅原序追加，填充 9 大策略组，合并 `local.json` 覆盖
4. **原子写入** `~/.config/sing-box/singbox.json`（上一份保留为 `singbox.json.bak`，任何失败不破坏现有产物）

## 验证

```bash
sb-sync check    # 零网络：产物结构、节点数、策略组、local 注入状态
sb-sync doctor   # 分层自检：配置 / DNS 解析链 / 直连·代理·CDN 计时
sb-sync profile  # 查看 SFM profiles 与产物的同源性（详见 01-mac-sfm.md）
```

`doctor` 输出示例：

```text
=== sb-sync doctor — 网络分层自检 ===

[配置] sing-box check: ✓ 通过
[配置] 系统解析器 198.18.0.2  ✓ 不在排除段

✓ DNS 解析链 (系统解析器→内核)  —  系统栈解析成功  (4ms)
✓ 直连站点 (baidu.com)      —  HTTP 200  (195ms)
✓ 代理站点 (google.com)     —  HTTP 204  (880ms)
✓ 图片 CDN (pbs.twimg.com)  —  HTTP 200  (899ms)
```

定位原则：DNS 行失败 = 解析链问题；直连慢 = 本地网络；代理/CDN 慢 = 代理链路。

## 设备私有覆盖（可选）

编辑 `~/.config/sing-box/local.json`（参考仓库 `config/sing-box/local.json.example`）：

```json
{
  "dns": {
    "servers": [{ "tag": "dns-internal", "type": "udp", "server": "192.168.6.1" }],
    "rules": [{ "domain_suffix": ["home.example.com"], "action": "route", "server": "dns-internal" }]
  },
  "route": {
    "rules": [{ "domain_suffix": ["home.example.com"], "outbound": "direct" }]
  }
}
```

规则：`dns.servers` 同 tag 覆盖、不同名前置；`dns.rules` 与 `route.rules` 置顶（优先命中）；
`outbounds` 追加。也可从文件安装：`sb-sync add local ./my-local.json`。

## 底模管理

```bash
sb-sync template update   # 手动拉最新底模
sb-sync template reset    # 丢弃缓存，回退二进制内嵌版
```

默认每次 sync 自动检查底模更新，通常无需手动执行。

## 常见问题

- **sync 报「没有任何节点来源」**：先执行 `sb-sync add sub` 或 `sb-sync add node`
- **sync 报订阅解析失败**：输出带行号，检查该行 URI 协议是否为 ss/hysteria2/hy2/anytls
- **产物校验警告「跳过」**：设备无内核 CLI 且 SFM 不在线时的正常提示，产物仍会写入（`.bak` 保底）
- **升级 sb-sync**：`mise install github:shelken/proxy@latest`；新 release 有 24h 冷却期，
  追平用 `mise install github:shelken/proxy@<版本号> --minimum-release-age 0d`
