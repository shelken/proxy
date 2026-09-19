# proxy

个人自维护的跨平台代理配置、分流规则与设备侧配置同步工具

## 功能

- **统一底模**：全平台标准化 sing-box 底模，包含双入站、内网穿透与 10 大分流策略组
- **sb-sync 设备同步**：Rust 单二进制（约 2MB），任意 arm Mac 上一条命令完成底模更新、订阅装配、本地产出
- **分层网络自检**：`sb-sync doctor` 逐层定位 DNS / 直连 / 代理链路问题
- **纯本地沙箱验证**：基于 Lima VM 仿真双入站与路由表，毫秒级黑盒诊断分流链路
- **Loon 多端生态**：维护移动端与 macOS 配置，集成去广告与自动化签到插件

## 快速上手（设备侧，SFM 用户）

无需本仓库源码，一条命令安装（依赖 [mise](https://mise.jdx.dev)）：

```bash
mise install github:shelken/proxy@latest
```

初始化并添加节点来源：

```bash
sb-sync init
sb-sync add sub "https://example.com/api/v1/client/subscribe?token=..."
sb-sync add node "hysteria2://password@host:port/?obfs=salamander&obfs-password=...#SelfHost"
sb-sync sync
```

产物 `~/.config/sing-box/singbox.json` 导入 SFM（Local Profile），菜单栏开关 OFF→ON 重载。
导入与日常更新详见[用户指南：Mac+SFM](./docs/user-guide/01-mac-sfm.md)。

日常操作：

```bash
sb-sync sync    # 拉订阅 + 自动更新底模 + 原子产出（SFM 在线时会提示重载）
sb-sync check   # 零网络验证本地产物
sb-sync doctor  # 网络分层自检：配置 / DNS 解析链 / 直连·代理·CDN 计时
```

完整命令与配置说明见 `sb-sync --help`。

## 快速上手（开发机）

项目依赖通过 `mise` 与 `bun` 管理：

```bash
mise install
bun install
```

Rust 版 sb-sync 源码位于 `scripts/sb-sync-rs/`：

```bash
cd scripts/sb-sync-rs
cargo test        # 核心库测试
cargo build --release
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

## 目录索引

- `docs/user-guide/`：[用户指南](./docs/user-guide/README.md)（sb-sync CLI 同步等）
- `scripts/sb-sync-rs/`：sb-sync Rust 源码（设备侧同步 CLI）
- `config/sing-box/`：sing-box 标准底模与沙箱测试套件
- `config/rules/`：分流规则源清单与自定义列表
- `config/loon/`：Loon 配置文件与插件
- `docs/ARCH.md`：系统顶层架构文档

## 贡献

提交变更前确保测试通过：

```bash
just test
just test-sandbox
```

## 许可证

MIT
