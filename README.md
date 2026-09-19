# proxy

个人自维护的跨平台代理配置、分流规则与无状态交付系统

## 功能

- **统一底模**：全平台标准化 sing-box 底模，包含双入站、内网穿透与 9 大分流策略组
- **单 URL 无状态装配**：单条 URL 动态注入自建节点与机场订阅，服务端零会话、零留存
- **纯本地沙箱验证**：基于 Lima VM 仿真双入站与路由表，毫秒级黑盒诊断分流链路
- **Loon 多端生态**：维护移动端与 macOS 配置，集成去广告与自动化签到插件

## 快速上手

### 1. 环境准备

项目依赖通过 `mise` 与 `bun` 管理：

```bash
mise install
bun install
```

### 2. 配置本地私有凭据

在本地创建 `.env` 文件（不入版本库）：

```bash
SUB_URL="https://example.com/api/v1/client/subscribe?token=..."
NODE_URI="hysteria2://password@host:port/?obfs=salamander&obfs-password=...#SelfHost"
```

### 3. 本地装配与端点拉起

校验生成产物或启动无状态装配服务：

```bash
# 装配配置并通过内核语法校验
just verify-endpoint .env /tmp/singbox.json

# 启动本地无状态装配端点
just serve 8080 127.0.0.1
```

客户端订阅链接配置：

```text
http://127.0.0.1:8080/darwin?sub=<订阅URL>&node=<节点URI>
```

### 4. 沙箱全链路路由探测

在隔离的 Lima VM 沙箱中探测流量走向，不污染宿主机网络：

```bash
# 探测兜底分流
just trace google.com

# 探测业务分流
just trace api.openai.com

# 探测内网穿透
just trace foo.ooooo.space
```

## 核心策略组规范

底模位于 `config/sing-box/template.json`，核心策略组与默认出口如下：

| 策略组 Tag | 默认出口 | 候选池规则 |
| :--- | :--- | :--- |
| `proxy` | `SelfHost` | 自建私有节点首发，机场专线节点全量追加 |
| `openai` | `SelfHost` | 优先自建节点，备选港、日、台、美节点 |
| `gemini` | `openai` | 优先跟随 OpenAI 分组，备选日本节点 |
| `dev` | `SelfHost` | 优先自建节点，备选香港节点 |
| `adultnsfw` | `SelfHost` | 优先自建节点，备选直连与专用节点 |
| `appleai` | `direct` | 优先直连，备选自建节点与主代理 |
| `japansite` | `proxy` | 优先跟随主代理，备选日本节点 |
| `opencode` | `proxy` | 优先跟随主代理，备选全量节点 |

## 目录索引

- `config/sing-box/`：sing-box 标准底模与沙箱测试套件
- `config/rules/`：分流规则源清单与自定义列表
- `config/loon/`：Loon 配置文件与插件
- `scripts/`：无状态装配引擎与沙箱探针
- `docs/`：系统顶层架构文档

## 贡献

提交变更前确保测试通过：

```bash
just test
just test-sandbox
```

## 许可证

MIT
