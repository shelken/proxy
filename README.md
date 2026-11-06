# proxy

个人自维护的代理配置仓库：一份权威分流规则源，一套标准化 sing-box 底模，加上 Loon 插件与设备侧订阅交付工具

## 功能

- **权威分流规则源**：上游原生 `geosite:`/`geoip:` 引用与个人规则在 `config/sing-box/settings.yaml` 统一声明，编译为 sing-box `.srs`、Clash yaml 等产物并由 CI 发布到 `sing-box-rules` 分支供远程引用
- **标准化 sing-box 底模**：双入站、FakeIP DNS、分流策略组与内网穿透的完整骨架，策略组清单见底模自身
- **设备侧订阅交付**：本机订阅与节点加密成一条 URL，服务端装配后由 SFM 按间隔自动拉取，凭据零外泄
- **Loon 插件**：移动端与 macOS 端插件，具备独立开关与幂等保证

## 快速上手

### 用户：在设备上接入（Mac + SFM）

安装 sbtools，依赖 [mise](https://mise.jdx.dev)，无需本仓库源码：

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

生成订阅 URL，公钥从服务端实时获取，输出自动写入剪切板：

```bash
sbtools encode -s https://sub.example.com
```

把 URL 粘进 SFM 的 Remote Profile，之后由 SFM 按间隔自动拉取
逐步操作见[用户指南](./docs/user-guide/README.md)

### 自建：套用自己的规则与底模

`config/sing-box/settings.yaml` 登记规则与分组，三份底模（`template.json` 等）由它生成，通过 `rule_set` 远程引用 `sing-box-rules` 分支上编译好的 `.srs`，按天自动更新
自用场景直接套用即可，换自己的规则产物时才需改这些地址；增删域名改 `config/rules/custom/*.yaml`，新增规则在 `settings.yaml` 的 `rules` 追加一项后执行 `just template-build`，开发环境搭建与测试命令见[贡献](#贡献)

## 核心配置

`config/sing-box/settings.yaml` 是日常唯一需要手工维护的入口，`rules` 登记规则与去向，`groups` 定义出站分组：

```yaml
groups:
  dev:
    options: [selfhost, proxy, "(?i)(港|HK|Hong)"]
    default: selfhost
rules:
  - { name: dev, source: ../rules/custom/dev.yaml, to: dev }
  - { name: ChinaMax, source: geosite:cn, to: direct }
```

`source` 为本地 YAML、`geosite:x`、`geoip:x` 或外部 `.srs` 的 URL，`to` 为去向或分组名；字段含义见该文件头注释
自定义列表语法见 [config/rules/README.md](./config/rules/README.md)

## 核心策略组

策略组定义在 `config/sing-box/settings.yaml`（业务分组）与 `base.yaml`（固定出站），生成结果见 `template.json`，底模结构说明见 [docs/sbtools.md](./docs/sbtools.md)，面板端的切换操作见[用户指南](./docs/user-guide/01-mac-sfm.md)

需要当前值时直接查：

```bash
jq -r '.outbounds[] | select(.type=="selector" or .type=="urltest") | "\(.tag) → \(.default // "首个命中节点")"' config/sing-box/template.json
```

## 目录索引

- `config/rules/`: 自定义规则列表与编译器 `scripts/rules-compile.ts`，详见其 [README](./config/rules/README.md)
- `config/sing-box/`: 底模输入（`settings.yaml`、`base.yaml`、`platforms/`）、生成的三份底模与沙箱闭环套件
- `config/loon/`: Loon 配置文件与插件
- `scripts/sbtools-rs/`: sbtools Rust 源码，负责客户端编码与服务端装配
- `docs/ARCH.md`: 系统顶层架构
- `docs/sbtools.md`: sbtools 客户端与服务端架构、加密协议、配置说明
- `docs/user-guide/`: [用户指南](./docs/user-guide/README.md)
- `postmortems/`: 疑难问题的排查记录

## 贡献

个人仓库，变更以自用为准，系统架构见 [docs/ARCH.md](./docs/ARCH.md)，全部可用命令见 [justfile](./justfile)

环境准备：

```bash
mise install      # 装 sing-box (prek 由系统提供, 不在项目声明)
mise run setup    # 装 git hook，每个克隆跑一次
```

修改 `config/sing-box/settings.yaml`、`base.yaml`、`platforms/` 或 `config/rules/custom/` 后，用这三条命令重建并确认：

```bash
just template-build    # 重新生成三份底模
just template-check    # 校验底模与输入一致
just rules-build       # 全量编译各端产物
```

规则集装载与路由裁决的断言在 `config/sing-box/tests/loop.test.ts`，会创建 TUN、改写路由表，**不在宿主机运行**，入口与沙箱 VM 生命周期见 justfile 的 `vm-*` 与 `test-sandbox` 命令
改动 `scripts/sbtools-rs/` 后的编译校验由 CI 统一执行

## 许可证

MIT
