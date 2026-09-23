# 分流规则源 (Rules)

本目录为分流规则源的定义与自定义列表目录

## 结构

```text
config/rules/
├── index.txt          # 规则清单索引
├── custom/            # 自定义规则列表 (*.list)
└── generated/         # 本地规则编译二进制缓存 (*.srs, 已 gitignore)
```

## 清单索引 (index.txt)

采用三列格式，以竖线 `|` 分隔：

```text
tag|policy|source
```

- **tag**：规则集标识，对应底模里的 `rule_set` 标签
- **policy**：目标分流策略，对应出站策略组标签（如 `direct`, `reject`, `proxy`, `openai`, `gemini` 等）
- **source**：本地文件路径（仓库相对路径）或远端上游下载链接（以 `http` 开头）

## 自定义规则格式 (custom/*.list)

支持标准分流语法，空行与 `#` 开头注释将被忽略：

```text
DOMAIN,example.com
DOMAIN-SUFFIX,example.com
DOMAIN-KEYWORD,example
DOMAIN-REGEX,^regex\..+
IP-CIDR,10.0.0.0/8,no-resolve
IP-CIDR6,2001:db8::/32
SRC-IP-CIDR,10.1.0.0/16
SRC-PORT,1234
DST-PORT,443
PROCESS-NAME,curl
GEOIP,cn
```

## 二进制编译产物

沙箱与生产运行加载预编译二进制 `.srs` 规则集，存放于 `generated/singbox/`。
离线运行时，沙箱通过本地挂载 `.srs` 避免网络下载超时。

## 构建

```bash
just rules-build       # 编译全部（联网拉上游清单）
just rules-build-one OpenAI
just rules-check       # 只校验清单与底模是否漂移
```

编译器是 `scripts/rules-compile.ts`，把清单转成三种客户端产物：

| 客户端 | 产物 | 形态 |
| :--- | :--- | :--- |
| `singbox` | `generated/singbox/*.json` + `.srs` | 源规则 JSON，再用官方 `sing-box rule-set compile` 编成二进制 |
| `clash` | `generated/clash/*.yaml` | mihomo classical provider 的 payload |
| `plain` | `generated/plain/*.list` | 原样文本，供 Loon / Surge 按 URL 引用 |

产物 `generated/` 已 gitignore，本地可随时重建；生产消费的是下面这条发布链路。

### 自动发布

`.github/workflows/build-rule-sets.yml` 在下列文件变更时触发：
`index.txt`、`custom/**`、`template.json`、编译器与测试自身。
流程是跑单元测试 → 校验清单与底模一致 → 全量构建 → force push 到 `sing-box-rules` 分支。

底模以 `update_interval: 1d` 远程引用该分支的 `.srs`，所以**不再需要手工往分支提交产物**。
分支每次都是整棵树快照（无父提交），容器与设备次日自动拿到新规则。

### 支持的源语法

| 源语法 | sing-box 字段 |
| :--- | :--- |
| `DOMAIN` / `DOMAIN-SUFFIX` / `DOMAIN-KEYWORD` / `DOMAIN-REGEX` | `domain` / `domain_suffix` / `domain_keyword` / `domain_regex` |
| `IP-CIDR` / `IP-CIDR6` | `ip_cidr` |
| `SRC-IP-CIDR` | `source_ip_cidr` |
| `SRC-PORT` / `DST-PORT` / `DEST-PORT` | `source_port` / `port` |
| `PROCESS-NAME` / `NETWORK` | `process_name` / `network` |
| `AND` / `OR` / `NOT` 逻辑表达式 | `type: logical`，`NOT` 转 `invert` |

省略写法会还原：`.example.com` 等同 `DOMAIN-SUFFIX,example.com`，裸域名等同 `DOMAIN`。

下列类型 sing-box 无法表达，**跳过并写进 `generated/unsupported/`**：
`USER-AGENT`、`URL-REGEX`（TLS 嗅探拿不到）、`IP-ASN`、`SRC-GEOIP`、`SRC-IP-ASN`
（geoip 族行内匹配已在 1.12.0 移除）、`IN-PORT`（内核实为 inbound tag）、`PROTOCOL`
（Loon 取值与内核 protocol/network 语义交叉，不猜）。

`GEOIP` / `GEOSITE` 不跳过：整份列表只有这类引用时，产物退化为对 SagerNet
`sing-geoip` / `sing-geosite` 预编译规则集的引用。

### DNS 伴生规则集

DNS 规则在拿到响应前只能按查询名判定，IP 类条目在 DNS 规则里没有可判定语义
（内核 1.14 起废弃、1.16 移除）。因此底模 `dns.rules` 引用到的清单会额外产出一份
只含域名条目的 `-dns` 副本（当前是 `ChinaMax-dns`）。
一份没有域名条目的列表被 DNS 规则引用时，构建直接失败。
