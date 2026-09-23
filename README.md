# proxy

个人自维护的跨平台代理配置、分流规则与设备侧配置同步工具

## 功能

- **统一底模**：全平台标准化 sing-box 底模，包含双入站、内网穿透与 22 大分流策略组
- **sb-sync 双形态**：Rust 单二进制。客户端 `encode` 把本机 YAML 加密成一条订阅 URL；服务端 `server` 解密后装配节点并调用官方 sing-box merge 产出配置
- **凭据零外泄**：订阅与节点只经服务端公钥加密传输，密钥材料不出本机
- **纯本地沙箱验证**：基于 Lima VM 仿真双入站与路由表，毫秒级黑盒诊断分流链路
- **Loon 多端生态**：维护移动端与 macOS 配置，集成去广告与自动化签到插件

## 快速上手（客户端）

无需本仓库源码，一条命令安装（依赖 [mise](https://mise.jdx.dev)）：

```bash
mise install github:shelken/proxy@latest
```

写配置 `~/.config/sing-box/config.yaml`：

```yaml
subs:
  - https://example.com/api/v1/client/subscribe?token=...
nodes:
  - hysteria2://password@host:port/?obfs=salamander&obfs-password=...#SelfHost
```

生成订阅 URL（自动写剪切板，公钥从服务端实时获取）：

```bash
sb-sync encode -s https://sub.example.com
```

把 URL 粘进 SFM 的 Remote Profile，之后由 SFM 按间隔自动拉取。
详见[用户指南：Mac+SFM](./docs/user-guide/01-mac-sfm.md)。

## 快速上手（开发机）

项目依赖通过 `mise` 与 `bun` 管理：

```bash
mise install
bun install
```

Rust 版 sb-sync 源码位于 `scripts/sb-sync-rs/`。编译校验由远程 CI 承担
（`.github/workflows/ci-sb-sync.yml`：fmt + clippy 严格规则 + 测试 + 镜像构建）：

```bash
cd scripts/sb-sync-rs
cargo run -- keygen
```

测试：

```bash
just test          # 宿主机全部测试
just test-sandbox  # Lima VM 沙箱网络行为测试
```

## 核心策略组规范

底模位于 `config/sing-box/template.json`，核心策略组与默认出口如下：

| 策略组 Tag | 默认出口 | 候选池规则 |
| :--- | :--- | :--- |
| `SelfHost`（urltest） | 自动测速最快 | 私有节点（tag 匹配 `vps`/`hy2`/`SelfHost`），每 2 分钟测速 |
| `proxy` | `SelfHost` | 自建私有节点首发，机场专线节点全量追加 |
| `openai` | `SelfHost` | 优先自建节点，备选港、日、台、美节点 |
| `gemini` | `openai` | 优先跟随 OpenAI 分组，备选日本节点 |
| `dev` | `SelfHost` | 优先自建节点，备选香港节点 |
| `adultnsfw` | `SelfHost` | 优先自建节点，备选直连与专用节点 |
| `appleai` | `direct` | 优先直连，备选自建节点与主代理 |
| `ptcg` | `SelfHost` | 优先自建节点，备选主代理与直连，日本节点正则匹配 |
| `japansite` | `proxy` | 优先跟随主代理，备选日本节点 |
| `opencode` | `proxy` | 优先跟随主代理，备选全量节点 |
| `zai` | `proxy` | z.ai（智谱 GLM）家族域名，优先跟随主代理 |
| `hk` | 首个命中节点 | 地区组：名称匹配香港正则，无节点时兜底 `proxy` |
| `jp` | 首个命中节点 | 地区组：名称匹配日本正则，无节点时兜底 `proxy` |
| `us` | 首个命中节点 | 地区组：名称匹配美国正则，无节点时兜底 `proxy` |
| `tw` | 首个命中节点 | 地区组：名称匹配台湾正则，无节点时兜底 `proxy` |
| `sg` | 首个命中节点 | 地区组：名称匹配新加坡正则，无节点时兜底 `proxy` |
| `kr` | 首个命中节点 | 地区组：名称匹配韩国正则，无节点时兜底 `proxy` |
| `microsoft` | `proxy` | Microsoft 域名（blackmatrix7），可切直连 |
| `apple` | `direct` | Apple 域名（blackmatrix7），直连优先，与 `appleai` 互不重叠 |
| `paypal` | `direct` | PayPal 域名（blackmatrix7），直连优先 |
| `grok` | `proxy` | Grok (xAI) 域名，来源 Loon 个人规则 |
| `1024` | `proxy` | 域名关键词 `1024proxy`，来源 Loon 个人规则 |
| `tailscale` | `proxy` | Tailscale 场景组，暂无域名规则，按需切换 |

## 目录索引

- `docs/user-guide/`：[用户指南](./docs/user-guide/README.md)
- `docs/sb-sync.md`：sb-sync 客户端与服务端架构、加密协议、配置说明
- `scripts/sb-sync-rs/`：sb-sync Rust 源码（客户端编码 + 服务端装配）
- `config/sing-box/`：sing-box 标准底模与沙箱测试套件
- `config/rules/`：分流规则源清单与自定义列表（编译器 `scripts/rules-compile.ts`）
- `config/loon/`：Loon 配置文件与插件
- `docs/ARCH.md`：系统顶层架构文档

## 贡献

提交变更前确保测试通过：

```bash
just test
just test-sandbox
```

改动 `config/rules/` 下的清单或底模后，用这两条确认并重建规则产物：

```bash
just rules-check    # 校验清单 policy 与底模路由是否一致
just rules-build    # 全量编译各端产物（CI 也会在推送后自动做这件事）
```

## 许可证

MIT
