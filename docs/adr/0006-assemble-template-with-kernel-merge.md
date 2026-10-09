# 底模装配交给官方内核 merge，模块按服务切分

底模（`config/sing-box/template.json`）的拼装从仓库自带的 TypeScript 装配器改为内核自带的 `sing-box merge -C config/sing-box/modules`，同时把按内容类型切分的 8 个模块文件重排为「每个服务一个文件」：一个服务的路由规则、规则集声明与出站组放在一起

## Context

- 旧装配器（`scripts/template-build.ts`）逐 key 拼接数组并硬编码字段顺序，还带 4 处正则把 `["A"]`、`[".int.ooooo.space"]` 这类单元素数组压回单行，排版细节因此进入构建代码，改底模要先理解这套排版规则
- 一个服务被拆在 3 个文件里（`30-route-rules.json` 路由规则、`40-route-rule-sets.json` 规则集声明、`60-outbounds.json` 出站组），新增服务要同时改 3 处，漏一处是静默失效：规则命中却无出站组，流量落到兜底代理
- 内核的 `merge` 子命令本就是同一语义的官方实现：按路径排序读目录、数组拼接、对象递归合并、标量后者覆盖；服务端装配（`scripts/sbtools-rs/src/assemble.rs`）与客户端 overlay 已经在用它

## Decision

1. `just template-build` = `sing-box merge config/sing-box/template.json -C config/sing-box/modules`；`just template-check` 用内核重跑一遍并逐字节比对，与 CI 同口径
2. 删除 `scripts/template-build.ts` 与 `scripts/template-build.test.ts`，`template.json` 成为纯产物
3. 模块按「文件名前缀 = 合并顺序」组织：`00`-`31` 是全局与核心（入站、DNS、路由全局属性、前置规则、核心出站组），`41`-`69` 每个服务一个文件（号段留空便于插队），`70` http_clients，`80` 兜底规则，`90` experimental
4. 顺序语义显式化：文件名顺序同时决定 `route.rules`（首匹配优先，行为敏感）与 `outbounds`（客户端展示顺序）

## Consequences

- 装配代码从 246 行降到 0，排版细节不再由仓库代码维护，改底模只需理解「文件顺序 = 数组顺序」
- 新增服务 = 新建一个模块文件 + 在 `index.yaml` 登记规则集，一处改完
- `template.json` 变为内核规范形态：单元素数组写成标量、省略默认 `action: "route"`、时长写成 `1m0s`、`format` 依 `.srs` 后缀省略、补 `http_clients[].version: 2` 默认值；断言精确形态的测试改为形态无关断言，语义等价性用一次性比较脚本核对（归一化单元素数组、缺省字段、时长与 RR 串后，唯一差异是内核把默认值写全）
- 出站组在客户端的展示顺序随文件名变化，改为与路由规则顺序一致；`direct` / `dns-auto` / `selfhost` / `proxy` 与地区探测组仍排在最前
- 新增运行前置：`just template-build` 与 `template-check` 需要内核在 PATH 上（CI 由 mise 提供，与 `check-deprecated` 同一来源）
- 回滚方式：恢复 `scripts/template-build.ts` 与旧的按内容切分模块，重跑一次 `just template-build`
