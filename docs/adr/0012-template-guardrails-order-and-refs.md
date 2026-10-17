# 底模护栏：顺序契约、引用闭合与变异验证

**日期**：2026-10-18

底模的结构正确性从「若干字段存在性断言」升级为三层可执行契约：跨模板共用的顺序契约、tag 引用闭合、以及对断言自身的变异验证。`just template-build` 改为一次重建两份产物

## Context

PR #127 引入 iOS 底模时，实测暴露了现有防线的三个真实缺口。三处都在本仓库复现过：

- `sing-box check` 只做 `box.New`，不 `Start()`（`cmd/sing-box/cmd_check.go`）。tag 引用解析发生在启动阶段（如 `route/rule/rule_item_preferred_by.go` 的 `Start`）。对 `template-ios.json` 施加 10 类破坏，`check` 只拦住 1 类（悬空 `default_domain_resolver`），`outbound`、`rule_set`、`route.final`、`server`、`inbound`、`dns.servers[].endpoint` 全部放行
- 既有 iOS 测试对其中 4 类破坏（`outbound`、`rule_set`、`server`、`route.final` 悬空）8 项全过。断言只查字段存在时，把值改成不存在的 tag 不会被发现
- 结构断言曾被内核 merge 的默认值省略掩盖：取默认值的布尔字段与 `action: route` 不写进产物，早期断言因此恒真
- `just template-check` 与 CI 的 verify 步骤是两份手写 shell，语义容易漂移；改动 `modules/` 时人还得记住跑第二条命令同步 iOS 产物

## Decision

1. **引用闭合**（`config/sing-box/tests/lib/contract.ts` 的 `assertRefsClosed`）。对 `route.rules[].outbound / preferred_by / inbound / server / rule_set`、`dns.rules[].server / preferred_by / inbound / rule_set`、`dns.servers[].endpoint`、`route.final`、`dns.final`、`route.default_domain_resolver` 逐项断言目标已声明。endpoint 可同时充当出站与入站，故 `outbound` / `preferred_by` / `inbound` 的合法目标是 outbounds ∪ endpoints
2. **顺序契约**（`ROUTE_ORDER` / `DNS_ORDER`）。Mac 与 iOS 共用同一张锚点表，iOS 独有条目用 `only: "ios"` 标注。**只收录有证据证明必须如此的顺序**，每条锚点带 `why` 字段指向 ADR、尸检或沙箱实测；指不出证据的顺序属于实现自由，不写进契约。同一谓词命中多条规则时（如两条 DNS 劫持）用 `first: true` 锚定首条命中
3. **变异验证**（`scripts/verify-assertions.ts`）。把底模目录复制到临时位置，对副本施加 11 类已知有害改动，断言必须失败。两处自检：未施加变异时基线必须通过；每个变异必须真的改变内容或产生新文件，否则说明字段路径失效、脚本在空跑
4. **iOS 差异面白名单**（`IOS_MODULE_WHITELIST`）。`modules-ios/` 的文件集合必须等于白名单，新增 iOS 模块须同步登记，防止差异面无声扩大
5. **build 单入口**。`just template-build` 一次重算两份产物，用 `cmp` 区分「重算了」与「真的变了」，只报告后者。判定方式为两侧都重建而非按改动范围推断：`modules-ios/` 覆盖 `modules/` 的同名文件，改动归属需要模拟合并才能判断，而重建成本约 300ms，推断逻辑本身会引入新 bug
6. **职责分离**。`template-check` 只校验产物与 modules 一致、内核 check、废弃写法；`template-test` 跑结构契约测试；`template-mutation` 跑变异验证。变异验证只进 `just verify` 与 CI，不进 pre-commit：它要跑十余次真实测试，秒级成本不适合每次提交
7. **CI 与本地同一套语义**。CI 的 verify 步骤改为调用 `just check-template` 与 `just template-mutation`，不再在 workflow 里手写 merge/diff/check 脚本

## Consequences

- 修掉 4 类此前完全无人拦的悬空引用，以及「顺序被改乱但内核照收」这一类
- 改底模顺序若违反契约，会看到具体锚点与它的依据，而不是一条无语境的 diff
- 合法重排需同时更新契约并说明理由。这是故意的：顺序就是行为
- 新增 iOS 模块多一步白名单登记，换来差异面始终可见
- `just check-template` 从约 686ms 降到约 490ms：去掉 `check -D`（check 不 `Start()`，不碰 `state_directory` 与 `cache.db`，实测不产生任何文件）、合并重复的 `check-singbox` 与 `check-deprecated`、每份产物只 merge 一次
- `check-deprecated` 的检查对象从 `modules/` 源文件变为两份产物。merge 不改字段名，废弃字段检测等价；单独调用该 recipe 时也覆盖 iOS
- 变异验证约 10 秒，只在 `just verify` 与 CI 出现
- 回滚：删除 `contract.ts`、`order-contract.test.ts`、`verify-assertions.ts`，`justfile` 恢复 `template-build` / `template-ios-build` 两条命令，CI 恢复手写 verify 步骤
