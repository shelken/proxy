# 分流规则源 (Rules)

本目录为分流规则源的定义与自定义列表目录

## 结构

```text
config/rules/
├── index.yaml         # 规则清单索引
├── custom/            # 自定义规则列表 (*.yaml)
└── generated/         # 本地规则编译产物 (*.srs / *.yaml / *.list, 已 gitignore)
```

## 清单索引 (index.yaml)

顶层是 `tag: source` 映射，value 有两种形态：

```yaml
Advertising: geosite:category-ads-all            # 外部原生引用
geoip-cn: geoip:cn
OpenAI: config/rules/custom/OpenAI.yaml          # 内部自定义规则
"1024proxy": config/rules/custom/1024proxy.yaml
```

- **key**：规则集标识，对应底模里的 `rule_set` 标签
- **value**：`geosite:x` 与 `geoip:x` 走外部原生镜像，其余为仓库相对路径的本地结构化 YAML

键按 ASCII 忽略大小写排序，同字母大小写相邻。数字开头的 tag 一律加引号，
避免 YAML 把纯数字键解析成数字。

出站去向由底模 `route.rules` 单方面决定，清单不重复声明；`just rules-check` 只校验清单 tag 集合与底模声明的规则集一致

## 自定义规则格式 (custom/*.yaml)

结构化字典，同名键的值自动去重合并，连字符键名与下划线等价：

```yaml
rules:
  - domain_suffix:
      - example.com
  - domain_keyword:
      - ads
  - ip_cidr:
      - 10.0.0.0/8,no-resolve
  - port: 443
  - port_range:
      - 6881:6889
  - logical:
      - mode: and
        rules:
          - mode: or
            rules:
              - domain_suffix: online
              - domain_suffix: site
          - domain_keyword: assets-
```

可用字段见 `scripts/rules-compile.ts` 的 `FIELD_ORDER`，另有 `ip_asn` 与 `logical`
未知字段构建期直接报错，不静默丢弃；字段值只能是字符串或数字及其数组，其他类型一律报错

`logical` 叶节点只接受 `FIELD_ORDER` 内的单个字段、单个标量值，键名连字符与
下划线等价，多字段或数组叶子构建期报错。`network` 在 mihomo 端输出 `NETWORK`，
在 Loon / Surge 端输出 `PROTOCOL`。DNS 伴生副本会保留叶子全为域名字段的逻辑树。

## 二进制编译产物

沙箱与生产运行加载预编译二进制 `.srs` 规则集，存放于 `generated/singbox/`。
离线运行时，沙箱通过本地挂载 `.srs` 避免网络下载超时。

## 构建

```bash
just rules-build       # 全量构建
just rules-build-one OpenAI
just rules-check       # 只校验清单与底模是否漂移
```

编译器是 `scripts/rules-compile.ts`，按 source 形态走两条最短路径：

| source | singbox | clash | plain |
| :--- | :--- | :--- | :--- |
| `geosite:x` / `geoip:x` | 直接镜像 meta-rules-dat 的 `.srs` | 直接镜像 mihomo 原生 `.yaml` | 直接镜像上游原始 `.list` |
| `custom/*.yaml` | AST → 源 JSON → 官方 `rule-set compile` 成 `.srs` | classical payload YAML | Loon / Surge 文本 |

两类 plain 的行格式不同：

- 内部 `.list` 是 `TYPE,VALUE` 规则行，供 Loon 与 Surge 以 RULE-SET 引用
- 外部 `.list` 是上游原始形态，每行 `+.domain.com` 通配域名，供 mihomo 与 Loon 的 DOMAIN-SET 引用

外部镜像零解析零编译，内部 YAML 经 AST 结构化发射。产物 `generated/` 已
gitignore，本地可随时重建；生产消费的是下面这条发布链路。

### 自动发布

`.github/workflows/build-rule-sets.yml` 在两类时机触发：

- **推送**：清单、自定义规则、底模、编译器与测试变更时触发
- **定时**：每日定时触发，同步上游 meta-rules-dat 资产更新

定时那一档是必需的：meta-rules-dat 上游的 geosite/geoip 数据与内部 YAML 无关地
持续更新，只靠仓库文件变更触发的话，上游新增的规则永远进不来。

流程是运行单元测试 → 校验清单与底模一致 → 全量构建 → 推送至 `sing-box-rules` 分支
发布步骤仅在默认分支上执行，PR 仅执行测试与构建，产物以 artifact 留存，不覆盖生产分支

底模以 `update_interval: 1d` 远程引用该分支的 `.srs`，无需手动提交产物
分支每次发布均为无父提交的整棵树快照，容器与设备次日自动拉取新规则

### DNS 伴生规则集

DNS 规则在拿到响应前仅按查询名判定，IP 类条目在 DNS 规则中无法判定，因此每个清单 tag 均额外产出 `-dns` 副本，供 DNS 规则引用

- 内部 YAML：从 AST 过滤出仅含域名条目的子集
- 外部 `geosite:`：上游仅包含域名条目，`-dns` 副本直接复用主产物
- 外部 `geoip:`：IP 集合在 DNS 阶段无判定语义，不产出 `-dns` 伴生

全量产出而非只产被底模引用的那几个：设备 overlay 在运行期可以引用任意清单的
`-dns` 副本，构建期无法枚举。只构建被引用的两份，等于让 overlay 只能用底模已经
用过的规则集，新增引用必然拿到一个从未发布过的 URL，内核启动即 FATAL。

若列表不包含域名条目，`-dns` 副本产出空规则集，内核正常接受空规则集
