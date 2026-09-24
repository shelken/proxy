# sb-sync 客户端指南

面向使用任意 arm Mac 的用户。目标：装好 sb-sync，把本机配置加密成一条订阅 URL 交给 SFM。

前置条件只有两个：macOS（Apple Silicon）与 [mise](https://mise.jdx.dev)。不需要本仓库源码。

服务端形态（`sb-sync server`）由部署者维护，见 [sb-sync 架构](../sb-sync.md)。
本机只需要使用 `encode`（与部署时用一次的 `keygen`）；连接异常时用 `sb-sync trace <域名>` 现场诊断。

## 安装

```bash
mise install github:shelken/proxy@latest
```

安装后验证：

```bash
sb-sync version
```

无 mise 的设备，从 [Releases](https://github.com/shelken/proxy/releases) 下载
`sb-sync-aarch64-apple-darwin`，加执行权限后放入 PATH 即可。

## 写配置

配置文件默认 `~/.config/sing-box/config.yaml`，可用 `-c` 指定其它路径：

```yaml
subs:
  - https://example.com/api/v1/client/subscribe?token=...
nodes:
  - hysteria2://password@host:port/?obfs=salamander&obfs-password=...#SelfHost
overlay: |
  {
    "log": { "level": "warn" },
    "dns": { "strategy": "prefer_ipv6" }
  }
```

| 字段 | 必填 | 说明 |
| :--- | :--- | :--- |
| `subs` | 二选一 | 机场订阅 URL 列表 |
| `nodes` | 二选一 | 私有节点 URI，支持 `ss` / `hysteria2` / `hy2` / `anytls` |
| `overlay` | 否 | 原生 sing-box JSON，覆盖在底模之上 |
| `template_url` | 否 | 远程底模地址（仅 https），替代服务端内嵌底模 |

写法要点：

- 未知字段会直接报错，拼错字段不会被静默忽略
- `subs` 与 `nodes` 至少一个非空
- `overlay` 顶层必须是 JSON Object
- `overlay` 与 `template_url` 下载的底模都不得含 `certificate_path` / `key_path` /
  `private_key_path` / `config_path`，需要证书时改为内联内容

## 生成订阅 URL

```bash
sb-sync encode -s https://sub.example.com
```

服务端地址是 `-s/--server` 选项，不写进配置：同一份 YAML 可以指向不同服务端。
`-s` 与 `-c` 顺序无关，两个都是具名选项，不认位置参数。

命令会做三件事：

1. 本地校验 YAML（含 `template_url` 合法性），配置写错在本地立刻报错
2. 从 `https://sub.example.com/pubkey` 取服务端公钥
3. 用该公钥加密配置，把 URL 写入剪切板并打印

然后把 URL 粘进 SFM 的 Remote Profile，详见 [01-mac-sfm.md](./01-mac-sfm.md)。

配置改动后重新执行 `encode`，并把新 URL 覆盖进 SFM（旧 URL 里是旧的密文，不会自动更新）。

## 安全边界

- 加密用 X25519 + HKDF-SHA256 + AES-256-GCM，每次 `encode` 用新的临时密钥对
- 本机只持有服务端公钥（非机密），服务端私钥只在服务端
- 订阅与节点信息在传输前已加密，服务端只解密自己的私钥能解的密文
- `overlay` 会进入服务端的 `sing-box merge`，故路径引用字段被拒（防服务器任意文件读取）

## 常见问题

| 报错 | 原因 |
| :--- | :--- |
| `YAML 解析失败: unknown field` | 配置里有未知字段或拼错 |
| `subs 与 nodes 至少需要一个非空列表` | 两类来源都空 |
| `服务端地址必须以 http(s):// 开头` | 参数忘了带协议 |
| `template_url 仅支持 https` | 底模地址必须是 https |
| `template_url 不得指向内网地址` | 内网与云元数据地址被拒 |
| `HTTP 请求失败 .../pubkey` | 服务端不可达或地址写错 |

**升级 sb-sync**：`mise install github:shelken/proxy@latest`；新 release 有 24h 冷却期，
追平用 `mise install github:shelken/proxy@<版本号> --minimum-release-age 0d`