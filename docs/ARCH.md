# 项目系统架构 (ARCH)

## 1. 仓库整体结构

```text
proxy/
├── scripts/
│   └── sb-sync-rs/       # sb-sync 设备侧同步 CLI（Rust 单二进制）
├── config/
│   ├── rules/            # 分流规则源 (自定义 .list 与上游 index.txt)
│   ├── sing-box/         # sing-box 生产底模 (template.json) 与沙箱测试套件
│   └── loon/             # Loon 配置与自动化插件 (plugins/)
├── .github/workflows/    # CI：tag v* 触发 sb-sync 编译发布
└── justfile              # 统一测试与运维指令入口
```

## 2. 链路一：设备侧配置交付链路 (Device Config Pipeline)

```mermaid
flowchart TD
    subgraph S1 ["1. 规则编译 (CI)"]
        R_SRC["规则清单 (config/rules/index.txt + custom/)"] --> GHA["build-rule-sets.yml\nbun scripts/rules-compile.ts build --all"]
        GHA --> R_BIN["各端产物\n(singbox 64 / clash 31 / plain 31)\n发布到 sing-box-rules 分支"]
    end

    subgraph S2 ["2. 设备侧装配 (sb-sync)"]
        TPL_R["远程底模 (main 分支)\n失败→缓存→内嵌, 三级回退"] --> ASM["sb-sync sync"]
        SUB["机场订阅 (store.json)"] --> ASM
        NODE["自建私有节点 (store.json)"] --> ASM
        LOCAL["设备 local 覆盖\n(~/.config/sing-box/local.json)"] --> ASM
        R_BIN -.->|rule_set 远程引用| ASM
        ASM -->|"原子写(tmp→校验→.bak→rename)"| CFG["~/.config/sing-box/singbox.json"]
    end

    subgraph S3 ["3. 运行环境消费"]
        CFG --> SFM["SFM (Local Profile)\n菜单栏开关 OFF→ON 重载"]
        CFG --> SANDBOX["Lima VM 隔离沙箱 (回归测试 / 路由探测)"]
    end
```

要点：

- **规则产物自动重建**：改 `index.txt` / `custom/**` / `template.json` 触发 CI 编译并发布，无需手工往 `sing-box-rules` 分支提交
- **清单与底模强一致**：CI 校验每个 tag 的 policy 与底模 `route.rules` 的去向一致，漂移即失败（底模是手写单一配置源，编译器只报错不改写）
- **装配全部本地化**：订阅抓取、URI 解析、策略组填充都在设备上完成，凭据零外泄
- **内核校验是可选依赖**：`SING_BOX` 环境变量 → PATH 上的 sing-box → SFM 面板在线探测 → 全无则跳过（`.bak` 回滚保底）
- **不耦合仓库目录**：底模来自远程 main 分支或二进制内嵌版，产物与状态在 `~/.config/sing-box/`

## 3. 链路二：运行时流量决策链路 (Runtime Traffic Pipeline)

```mermaid
flowchart LR
    IN["流量入站\n(TUN / Mixed 2080)"] --> SNIFF["协议嗅探\n(Host / SNI)"]

    SNIFF --> ROUTE{"路由裁决矩阵\n(route.rules)"}

    ROUTE -->|内网域名| OUT_DIR["直连 (direct)"]
    ROUTE -->|广告 / 隐私| OUT_REJ["阻断 (reject)"]
    ROUTE -->|OpenAI / Gemini / Dev 等| GROUP["分流策略组\n(Selectors)"]
    ROUTE -->|未命中 (兜底)| GROUP_PROXY["默认代理 (proxy)"]

    GROUP --> LEAF{"候选池决策"}
    GROUP_PROXY --> LEAF

    LEAF -->|Index 0 (首选)| N_SELF["自建节点 (SelfHost)"]
    LEAF -->|Index 1..N (备选)| N_AIRPORT["机场专线节点"]
```

## 4. 链路三：沙箱仿真与验证闭环 (Verification Loop)

```mermaid
sequenceDiagram
    participant Dev as 开发与配置调整
    participant ASM as 装配引擎 (endpoint.ts)
    participant VM as Lima VM 沙箱 (proxy-test)
    participant Probe as 探针 (just trace)

    Dev->>ASM: 输入订阅与自建节点
    ASM->>VM: 生成配置并推入沙箱 (规则集本地挂载)
    VM->>VM: 启动 sing-box 内核 (100ms 纯本地启动)
    Dev->>Probe: 发起目标探测 (如 api.openai.com)
    Probe->>VM: 向 127.0.0.1:2080 注入请求
    VM-->>Probe: 捕获内核日志 (嗅探 -> 规则 -> 策略组 -> 物理出口)
    Probe-->>Dev: 输出链路审计报告 (0 污染宿主网络)
```

## 5. 发布链路

```text
git tag v* → GitHub Actions (release-sb-sync.yml)
  → cargo test --release → cargo build --release
  → 上传 sb-sync-aarch64-apple-darwin 到 GitHub Release
  → mise [tools."github:shelken/proxy"] 按 v<semver> 拉取
```
