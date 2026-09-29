# proxy

个人自维护的代理配置仓库：一份权威分流规则源，一套标准化 sing-box 底模，加上 Loon 插件与设备侧订阅交付工具

## 功能

- **权威分流规则源**：上游清单（blackmatrix7 等）与个人规则在 `config/rules/index.yaml` 统一声明，编译为 sing-box `.srs`、Clash yaml 等产物并由 CI 发布到 `sing-box-rules` 分支供远程引用
- **标准化 sing-box 底模**：双入站、FakeIP DNS、分流策略组与内网穿透的完整骨架，策略组清单见底模自身
- **设备侧订阅交付（sbtools）**：本机订阅与节点加密成一条 URL，服务端装配后由 SFM 按间隔自动拉取，凭据零外泄
- **Loon 插件**：移动端与 macOS 端插件（去广告、自动化签到等），独立开关与幂等保证

## 快速上手

### 用户：在设备上接入（Mac + SFM）

装 sbtools（依赖 [mise](https://mise.jdx.dev)，无需本仓库源码）：

```bash
mise install github:shelken/proxy@latest
```

写 `~/.config/sing-box/config.yaml`：

```yaml
subs:
  - https://example.com/api/v1/client/subscribe?token=...
nodes:
  - hysteria2://password@host:port/?obfs=salamander&obfs-password=...#selfhost
```

生成订阅 URL（自动写剪切板，公钥从服务端实时获取）：

```bash
sbtools encode -s https://sub.example.com
```

把 URL 粘进 SFM 的 Remote Profile，之后由 SFM 按间隔自动拉取
逐步操作见[用户指南](./docs/user-guide/README.md)

### 自建：套用自己的规则与底模

`config/rules/index.yaml` 是规则清单，`config/sing-box/template.json` 是完整配置骨架，
它通过 `rule_set` 远程引用 `sing-box-rules` 分支上编译好的 `.srs`、按天自动更新
自用场景直接套用即可，换自己的规则产物时才需改这些地址；增删域名改 `config/rules/custom/*.list`，
或直接在 `index.yaml` 追加一项。开发环境搭建与测试命令见[贡献](#贡献)

## 核心配置

`config/rules/index.yaml` 是唯一需要手工维护的规则清单，顶层是 `tag: source` 映射：

```yaml
MyReject: config/rules/custom/MyReject.list
Apple-AI: https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Surge/Apple_AI/Apple_AI.list
"1024proxy": config/rules/custom/1024proxy.list
```

`source` 为仓库相对路径或 `http` 开头的 URL；出站去向由底模单方面决定。
字段约定、键排序与自定义列表语法见 [config/rules/README.md](./config/rules/README.md)

## 核心策略组

策略组定义在底模 `config/sing-box/template.json`，组名、默认出口与候选池以该文件为准（底模结构说明见 [docs/sbtools.md](./docs/sbtools.md)，面板端的切换操作见[用户指南](./docs/user-guide/01-mac-sfm.md)）

需要当前值时直接查：

```bash
jq -r '.outbounds[] | select(.type=="selector" or .type=="urltest") | "\(.tag) → \(.default // "首个命中节点")"' config/sing-box/template.json
```

## 目录索引

- `config/rules/`：分流规则源（`index.yaml` + `custom/`）与编译器 `scripts/rules-compile.ts`，详见其 [README](./config/rules/README.md)
- `config/sing-box/`：sing-box 标准底模与沙箱闭环套件
- `config/loon/`：Loon 配置文件与插件
- `scripts/sbtools-rs/`：sbtools Rust 源码（客户端编码 + 服务端装配）
- `docs/ARCH.md`：系统顶层架构
- `docs/sbtools.md`：sbtools 客户端与服务端架构、加密协议、配置说明
- `docs/user-guide/`：[用户指南](./docs/user-guide/README.md)
- `postmortems/`：疑难问题的排查记录

## 贡献

个人仓库，变更以自用为准。系统架构见 [docs/ARCH.md](./docs/ARCH.md)，全部可用命令见 [justfile](./justfile)

环境准备：

```bash
mise install
bun install
```

改完 `config/rules/` 下的清单或底模后，用这两条确认并重建规则产物（CI 也会在推送后做）：

```bash
just rules-check    # 校验清单 tag 集合与底模声明是否一致
just rules-build    # 全量编译各端产物
```

规则集装载与路由裁决的断言在 `config/sing-box/tests/loop.test.ts`，会创建 TUN、改写路由表，
**不在宿主机运行**，入口与沙箱 VM 生命周期见 justfile 的 `vm-*` / `test-sandbox` 系列命令
改动 `scripts/sbtools-rs/` 后的编译校验由 CI 承担（`.github/workflows/ci-sbtools.yml`）

## 许可证

MIT
