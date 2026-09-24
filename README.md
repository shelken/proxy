# proxy

个人自维护的代理配置仓库：一份权威分流规则源，一套标准化 sing-box 底模，加上 Loon 插件与设备侧订阅交付工具。

## 功能

- **权威分流规则源**：上游清单（blackmatrix7 等）与个人规则在 `config/rules/index.txt` 统一声明，是各端产物的唯一来源
- **标准化 sing-box 底模**：双入站、FakeIP DNS、23 大分流策略组，含内网穿透
- **多客户端产物**：规则编译为 `.srs` / clash yaml 等格式，由 CI 自动发布到 `sing-box-rules` 分支供远程引用
- **Loon 插件**：移动端与 macOS 端插件（去广告、自动化签到等），独立开关与幂等保证
- **设备侧订阅交付（sb-sync）**：本机订阅与节点加密成一条 URL，服务端装配后由 SFM 按间隔自动拉取，凭据零外泄
- **沙箱验证**：Lima VM 内仿真双入站与路由表，黑盒诊断分流链路

## 快速上手

本仓库产出的配置可直接被客户端引用。以 sing-box 为例：

**1. 确认规则是否满足需求**

分流规则在 `config/rules/`。检查 `index.txt` 里的 `tag|policy|source` 清单，
需要增删域名时改 `custom/*.list`，或直接在 `index.txt` 追加一行。

**2. 拿到底模**

`config/sing-box/template.json` 是完整配置骨架，含双入站与 23 个策略组。
它通过 `rule_set` 远程引用 `sing-box-rules` 分支上编译好的 `.srs`，按天自动更新；
自用场景直接套用即可，换自己的规则产物时才需改这些地址。

**3. 在设备上交付（Mac + SFM）**

装 sb-sync（依赖 [mise](https://mise.jdx.dev)，无需本仓库源码）：

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
sb-sync encode -s https://sub.example.com
```

把 URL 粘进 SFM 的 Remote Profile，之后由 SFM 按间隔自动拉取。
逐步操作见[用户指南](./docs/user-guide/README.md)。

## 核心配置

`config/rules/index.txt` 是唯一需要手工维护的规则清单，三列以竖线分隔：

```text
tag|policy|source
MyReject|reject|config/rules/custom/MyReject.list
Apple-AI|appleai|https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Surge/Apple_AI/Apple_AI.list
```

| 列 | 说明 |
| :--- | :--- |
| `tag` | 规则集标识，也是底模里的 `rule_set` tag |
| `policy` | 目标出站策略组；`reject` 会编译成 `action: reject` |
| `source` | 仓库相对路径读本地文件，`http` 开头则按 URL 拉取 |

自定义列表（`custom/*.list`）支持 `DOMAIN` / `DOMAIN-SUFFIX` / `DOMAIN-KEYWORD` /
`DOMAIN-REGEX` / `IP-CIDR` / `IP-CIDR6` / `SRC-IP-CIDR` / `SRC-PORT` / `DST-PORT` /
`PROCESS-NAME` / `GEOIP` 等标准分流语法。详见 [config/rules/README.md](./config/rules/README.md)。

## 核心策略组

底模 `config/sing-box/template.json` 定义 23 个策略组（selector / urltest）。全部组都开了 `interrupt_exist_connections`，切换节点即掐断该组存量连接，长连接立刻在新节点重拨。无匹配节点的组在装配阶段整体不产出，不会让内核因缺 tag 而启动失败。

组名、默认出口与候选池以底模为准，直接查当前值：

```bash
# 全部策略组及其默认出口（无 default 表示取组内首个命中节点）
jq -r '.outbounds[] | select(.type=="selector" or .type=="urltest") | "\(.tag) → \(.default // "首个命中节点")"' config/sing-box/template.json

# 单个组的候选池（outbounds 里是节点名正则，装配时展开为实际节点）
jq '.outbounds[] | select(.tag=="openai")' config/sing-box/template.json
```

## 目录索引

- `config/rules/`：分流规则源（`index.txt` + `custom/`）与编译器 `scripts/rules-compile.ts`，详见其 [README](./config/rules/README.md)
- `config/sing-box/`：sing-box 标准底模与沙箱闭环套件
- `config/loon/`：Loon 配置文件与插件
- `scripts/sb-sync-rs/`：sb-sync Rust 源码（客户端编码 + 服务端装配）
- `docs/ARCH.md`：系统顶层架构
- `docs/sb-sync.md`：sb-sync 客户端与服务端架构、加密协议、配置说明
- `docs/user-guide/`：[用户指南](./docs/user-guide/README.md)
- `postmortems/`：疑难问题的排查记录
## 贡献

个人仓库，变更以自用为准。提交前确保测试通过：

```bash
mise install
bun install

just test                   # 宿主机全部测试（Loon 插件 + 底模装配脚本）
just run-test cmcc          # 按关键字过滤
just check-singbox          # 校验生产底模引用的规则集与结构
just trace google.com       # 沙箱内追踪指定域名的分流与真实出口
```

改动 `config/rules/` 下的清单或底模后，用这两条确认并重建规则产物：

```bash
just rules-check    # 校验清单 policy 与底模路由是否一致
just rules-build    # 全量编译各端产物（CI 也会在推送后自动做这件事）
```

沙箱 VM 生命周期与网络行为测试会创建 TUN、改写路由表，**不在宿主机运行**：

```bash
just vm-create      # 一次性创建 Lima VM
just vm-start
just test-sandbox   # 引导闭环 + 在 VM 内跑全部网络行为测试
just test-loop      # 只跑闭环断言（引导已完成时用）
just vm-stop
```

`test-sandbox` 会先自动取当前 HEAD 的 Linux 产物、在 VM 内起服务端并取回它实际响应的
配置，再驱动内核做规则集装载与 19 个命中断言（12 个独占规则集 + 7 个共用规则集）。产物需先由
`gh workflow run release-sb-sync.yml --ref <分支>` 构建（或已存在的同名分支构建）。

Rust 部分（`scripts/sb-sync-rs/`）的编译校验由远程 CI 承担
（`.github/workflows/ci-sb-sync.yml`：fmt + clippy 严格规则 + 测试 + 镜像构建）。
## 许可证

MIT
