# 内部 YAML AST 编译

`custom/*.yaml` 的紧凑字典语法经 `parseYamlAst` 解析为结构化 AST，再发射成三端产物：sing-box 源 JSON（官方 compile 成 `.srs`）、clash classical payload YAML、Loon / Surge 文本。用户看到的是同一份 YAML 语义在三个客户端上的等价表达。

## Sub-features

- `yaml-fields`：`domain` / `domain_suffix` / `domain_keyword` / `domain_regex` / `process_name` / `ip_cidr` / `source_ip_cidr` / `port` / `port_range` / `source_port` / `source_port_range` / `network`，外加特例 `ip_asn` 逐字段发射，同名键去重合并。
- `yaml-logical`：`logical` 子树（`and` / `or` / `not`）在 sing-box 端保留为树（`mode: not` 且仅一个子项时折叠为叶节点 + `invert: true`）、在 clash / plain 端格式化为单行。
- `yaml-norm`：连字符键名（含 `ip-asn`）等价下划线；字段值只接受字符串/数字（含数组），`null` / 布尔 / 映射对象 / 嵌套数组构建期报错。
- `yaml-logical-bound`：`logical` 叶节点须恰好一个字段、键须在白名单 `FIELD_ORDER` 内（故 `ip_asn` 在普通层合法、在逻辑叶子里会报错）、值须是单个标量——多元素数组与多字段叶子构建期报错，单元素数组会被解包为标量。
- `yaml-noresolve`：`ip_cidr` 的 `,no-resolve` 在 sing-box 端剥离，在 clash / plain 端保留；`source_ip_cidr` 不剥离（各端原样保留）。

## How to get to it (user POV)

- 编辑 `config/rules/custom/<Tag>.yaml`。
- 构建：`just rules-build-one <tag>` 或 `just rules-build`。
- 看产物：`config/rules/generated/singbox/<Tag>.json`（源 JSON）与 `.srs`、`config/rules/generated/clash/<Tag>.yaml`、`config/rules/generated/plain/<Tag>.list`。
- 单元入口：`bun test scripts/rules-compile.test.ts`。

## Driving it with verify.js

Preconditions: 已 `launch`。

- logical 树保留：`D2/Adult` 断言反编译后 `type: "logical"` 的规则数为 3。
- no-resolve 剥离：`D2/Hijacking` 断言反编译后 `ip_cidr` 的值都不含 `no-resolve`。
- 三端形态：`D1/clash-shape/Adult` 断言 clash 产物以 `payload:` 开头；`D1/plain/Adult` 断言 `.list` 非空。
- 字段边界（源码级）：`bun test scripts/rules-compile.test.ts` 覆盖非标量值、多字段逻辑叶子、多元素数组叶子的报错（单元素数组叶子合法）。

## Gotchas

- `.srs` 反编译出来的 `version` 是 sing-box 二进制格式版本，不是源 JSON 的 `version: 3`；不要拿它判定构建输入。
- `IP-ASN` 在 sing-box 端会被忽略（1.12 起移除行内匹配），其余两端保留；构建日志会出现 warn，不是失败。
- 单 tag 构建不清理 `config/rules/generated/`；跨 tag 判定必须整目录重跑。
- `logical` 叶节点的方言（如端口类型名）只对白名单单字段生效；多字段与多元素数组叶子直接报错，单元素数组则被静默解包为标量。
- `source_ip_cidr` 带 `,no-resolve` 时不会被剥离而进入 sing-box 源 JSON；当前 custom 无此用法，遇到时以 `sing-box check` 结果为准。
