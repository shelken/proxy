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
