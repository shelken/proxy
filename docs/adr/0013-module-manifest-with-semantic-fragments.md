# 模块装配改为一张表加一层语义片段

> 状态：已被 [0015](0015-settings-yaml-single-entry.md) 取代

**日期**：2026-11-05

底模的模块布局从「一个共享目录加两个变体目录（iOS、路由器）共 39 个文件，文件名前缀决定合并顺序、变体目录的同名文件替换表达差异」改为「`config/sing-box/modules.yaml` 一张表 + `config/sing-box/fragments/` 一层语义片段」。顺序不再由文件名前缀表达，而由表里 `roles.<role>` 列表的条目顺序声明；平台差异不再靠同名替换，每个角色一份自己的列表；能力开关由「条目不在列表里」表达。产物形态与顺序语义不变，三份 template 逐字节不变

## Context

- 旧布局把「顺序」写在三个地方：文件名前缀（`30-` 早于 `32-`）、目录名（变体目录的同名文件替换）、以及两者的合并结果。要回答「iOS 的拦截规则排在第几条」，得先在脑子里把两个目录按文件名合并成一条隐含序列——这条序列没有任何地方写出来
- 「号段留空便于插队」把插入位置变成约定：改一次顺序要重命名一串文件，重命名又可能撞号，且改名后的顺序不写进任何契约
- 一个服务的信息拆在三处（`41-gemini.json` 的规则、清单定义、出站组），其中「服务名」与 `outbound` 两个字段手工同步；实测 15/15 恒等，但没有任何断言约束它们一致
- 「某个模块文件改了却没生效」是静默的：文件与产物之间没有可读的映射，只能靠读 `sing-box merge` 的结果反推
- 内核合并的真实语义是「同一层按路径字典序拼接，标量取字典序最早者」，这层语义只写在文档里，布局本身不表达它

## Decision

1. `config/sing-box/modules.yaml` 一张表：`services` 每行一个服务（`rule_set`、`outbound`、selector 的候选与默认值）、`catalog` 成组出现的规则集声明、`roles` 每个平台一份条目列表
2. `config/sing-box/fragments/base|ios|router/` 一层语义片段：片段只是配置片段，自身不含顺序信息
3. 顺序只由 `roles` 列表的条目顺序决定；平台差异 = 该角色列表里换了哪个片段、多了哪几条；能力开关 = 条目不列入
4. `scripts/modules-build.ts` 把表物化成「序号前缀的扁平目录」再交给 `sing-box merge`；产物形态（字段顺序、单元素数组、默认值省略）仍完全由内核决定
5. 变体的「同名替换」语义取消：三个角色各自是一份显式列表，`fragments/<平台>/` 只提供片段内容
6. 契约测试从「断言变体目录的文件名集合」改为「断言 roles 条目序列」：`tests/lib/manifest.ts` 存基准顺序与每个变体的注册补丁

## Consequences

- 「顺序」第一次有了唯一的、机器可读的真源：插队 = 在列表里挪一行，不再重命名文件，也不再需要号段留空
- 与 ADR-0006 的「装配代码从 246 行降到 0」并存：这次新增了 160 行 TypeScript，但性质与那次删掉的装配器不同——旧装配器逐 key 拼接数组、硬编码字段顺序，还带 4 处正则把单元素数组压回单行；新脚本只做「读表 → 写片段 → 调内核」，不排序、不排版、不自己拼 JSON 文本，最终形态仍由 `sing-box merge` 决定。代价是装配不再是零代码，脚本本身变成要维护、要理解的资产；产物也不再能从输入直接推出来，必须跑一次内核
- 位置约束从文件名搬进测试：基准顺序（mac 的 36 条）与两个变体的注册补丁是显式常量，任何重排都会在 `bun test` 里显示成 diff，逼一次复核。实测把 `clash-mode` 挪到 `reject` 之前，顺序断言与 ADR-0008 的语义断言会同时变红
- 手工同步的重复消失：服务条目按 `outbound` 查表，「服务名」不再与 `outbound` 并存
- `fragments/` 下没人引用的片段、表里 `services` / `catalog` 没被任何角色引用的条目都是死条目，由孤儿断言一起拦下。改片段名不是「只改表里一处」：`tests/lib/manifest.ts` 的 `MAC_ORDER` 要同步，变体片段还要改各自测试里 `IOS_DIFF` / `ROUTER_DIFF` 的 `fragments`、`replace` 与 `insertAfter`（后两者里也记着变体片段的路径；只改 `fragments` 会让 `applyPatch` 产出旧 key，`assertRoleOrder` 变红）
- 产物多一条不变量：每个产物里 `route.rules[].rule_set` 引用的 tag 必须已在该产物的 `route.rule_set` 里声明。`catalog` 把「声明」与「引用」拆成两个条目之后，删掉 `{ catalog: X }` 而留下用它的规则片段会做出「引用未声明的 tag」这种产物，而内核 check 与 merge 都退出码 0（实测）。底模 `template.json` 侧 `just rules-check` 会读它并报「清单里的 X 未在底模 route.rule_set 声明」，且 `config/sing-box/**` 已在它的触发面里；但 `rules-check` 不读两个变体产物，变体侧只有这条不变量能拦
- 代价：新增服务要改 5 处：`modules.yaml` 的 `services` 一行、三个角色列表（Mac / iOS / 路由器）各一条 `{ service: <outbound> }`、`tests/lib/manifest.ts` 里 `MAC_ORDER` 一条。漏条目或错位都会被 `assertRoleOrder` 拦下（变体的期望值是 `MAC_ORDER` 加注册补丁，不是另抄一份），反方向的残留由孤儿断言盖住
- 代价：变体侧仍是整份片段拷贝，不是对 base 片段的引用或补丁。`base/experimental.json` 与 `router/experimental.json` 只差一个标量（`external_controller` 的监听地址），`inbounds` 在三份产物里各有一份拷贝。这是改动前就有的形态（旧的 `modules-router/90-experimental.json` 同样是整份拷贝），本决策既没引入也没消除；「改 base 不传播到变体」目前没有断言，唯一提示是 `just template-build` 打印的「未变化」——base 改了而变体那份没跟着改时，对应产物会报未变化
- 历史 ADR（0006 / 0007 / 0008 / 0009 / 0011）里的号段文件名按当时的事实保留，不再回改。旧文件与新片段**不是**逐条改名：`10-dns.json` 对应 `base/dns-policy.json`（规则集声明挪进表里的 `catalog.dns`）、11 个出站文件并成 `base/outbound-groups.json`、`41`–`69` 的 15 个服务文件并进表里的 `services`、`40-my-rules.json` 改名 `base/own-lists.json`，其余多数是同名去号段；现状以 `config/sing-box/fragments/` 与 `modules.yaml` 为准
- 回滚：本决策是纯结构重构，三份产物逐字节不变，`git revert` 落地它的提交即可（被删的三个模块目录与变体合并脚本随该提交一并恢复）
