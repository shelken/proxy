# 项目系统架构 (ARCH)

## 1. 仓库整体结构

```text
proxy/
├── config/
│   ├── rules/            # 分流规则源 (自定义 .list 与上游 index.txt)
│   ├── sing-box/         # sing-box 生产底模 (template.json) 与沙箱测试套件
│   └── loon/             # Loon 配置与自动化插件 (plugins/)
├── scripts/
│   ├── endpoint.mjs      # 单 URL 无状态配置装配引擎
│   └── trace-route.mjs   # 沙箱全链路路由诊断探针
├── .github/workflows/    # CI 自动化构建 (规则集离线编译为 .srs)
└── justfile              # 统一测试与运维指令入口
```

---

## 2. 链路一：配置与规则交付链路 (Asset & Config Pipeline)

```mermaid
flowchart TD
    subgraph S1 ["1. 规则编译 (CI / 定时任务)"]
        R_SRC["规则源 (config/rules/)"] --> GHA["GitHub Actions 编译器"]
        GHA --> R_BIN["二进制规则集 (*.srs)\n(发布于 sing-box-rules 分支)"]
    end

    subgraph S2 ["2. 无状态端点装配 (endpoint.mjs)"]
        INPUT_SUB["商业机场订阅 (SUB_URL)"] --> ASM["装配引擎"]
        INPUT_NODE["自建私有节点 (NODE_URI)"] --> ASM
        TPL["架构底模 (template.json)"] --> ASM
        R_BIN -.->|远程引用 / 本地映射| ASM
        ASM --> CFG["单一自包含配置 (JSON)"]
    end

    subgraph S3 ["3. 运行环境消费"]
        CFG --> HOST["生产客户端 (macOS / iOS / 路由器)"]
        CFG --> SANDBOX["Lima VM 隔离沙箱 (回归测试 / 路由探测)"]
    end
```

---

## 3. 链路二：运行时流量决策链路 (Runtime Traffic Pipeline)

```mermaid
flowchart LR
    IN["流量入站\n(TUN tun0 / Mixed 2080)"] --> SNIFF["协议嗅探\n(Host / SNI)"]
    
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

---

## 4. 链路三：沙箱仿真与验证闭环 (Verification Loop)

```mermaid
sequenceDiagram
    participant Dev as 开发与配置调整
    participant ASM as 装配引擎 (endpoint.mjs)
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
