# 建立统一规则 AST 驱动多端编译，自定义规则迁移为结构化 YAML

为彻底消除本地编译器维护复杂文本正则与括号状态机的沉重负担，实施“外部规则原生镜像分发，内部规则紧凑 YAML 编译”的双轨解耦架构。外部公共规则统一选用 MetaCubeX (meta-rules-dat) 等原生多端支持的生态源由 CI 镜像分发；内部私有规则全量迁移为声明式 YAML，由极简编译器结构化导出至 sing-box (.srs / -dns.srs)、Mihomo (Clash) 与 Loon (Plain)。

## Context

此前 `scripts/rules-compile.ts` 直接对源纯文本行进行逐行字符串正则切分与括号状态机分析。随着分流需求复杂化（如 Download 规则集涉及大量进程匹配、特征端口、端口范围及防 Fake-IP 伴生提取），纯文本格式在跨端对齐时暴露出多重矛盾：
1. **语法表达能力不对称**：单行文本难以自然表达复杂嵌套逻辑或区分单端口与端口范围；
2. **多端差异适配成本高**：Loon、Mihomo 与 sing-box 在端口字段（`DST-PORT` vs `DEST-PORT` vs `port` / `port_range`）及进程名（`.exe` 后缀匹配）上存在底层实现差异；
3. **维护复杂度高**：手写嵌套括号与多级逻辑解析器代码冗长，且难以直接支持结构化扩展。

## Decision

1. **外部规则生态对齐**：外部通用规则不再在本地做跨端语法转译，改由 CI 镜像拉取 MetaCubeX 等原生支持多端的成熟规则源资产，并在发布分支统一归集分发，彻底剥离外部复杂的方言兼容负担；
2. **内部规则声明式 YAML**：本地自定义规则全量从 `custom/*.list` 迁移为 `custom/*.yaml`，采用紧凑字典 AST 语法，天然支持数组、端口范围（`port_range`）与进程匹配；
3. **内部编译器极端收敛**：`scripts/rules-compile.ts` 彻底废弃所有文本行 split 与括号状态机代码，仅保留针对 `custom/*.yaml` 的结构化映射输出：
   - `emitSingbox`：结构化映射为 sing-box 源 JSON，原生支持 `port_range`，官方 compile 为 `.srs`，并自动过滤生成 `-dns` 伴生；
   - `emitClash`：输出 Mihomo classical yaml payload；
   - `emitPlain`：输出 Loon / Surge 标准文本列表；
4. **降级策略**：不支持的特性记录至 `generated/unsupported/`，保持与现有发布和观测体系兼容。
## Consequences

- 彻底消灭文本拼装与括号解析代码，编译器规模大幅缩减，结构稳定可控；
- 本地规则原生支持多进程、端口范围与结构化类型，无需在模板或底模中打特例补丁；
- 外部规则依托成熟多端社区镜像，摆脱单端文本转译的语法不兼容痛点。
