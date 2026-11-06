# 设置-底模契约

三份底模由 `config/sing-box/settings.yaml` + `base.yaml` + `platforms/` 生成，规则声明、路由引用与 `-dns` 伴生出自同一次生成，不会漂移。构建期校验会直接报出是哪条规则、哪个名字出了问题

## Sub-features

- `contract-generate`：`scripts/build-config.ts --check` 重算三份产物并与磁盘逐字节比对，不一致时报出首个差异字节
- `contract-settings`：`settings.yaml` 的校验覆盖规则名重复、去向无效、来源不存在、分组默认值不在候选里、`tag` 与产物名冲突
- `contract-anchor`：DNS 与 QUIC 规则按名字引用的 7 个锚点改名或改去向时，生成器打印 `WARN` 并省略依赖它的规则（`inactiveAnchors`）
- `contract-publish`：发布分支只包含 `settings.yaml` 产出的产物，底模引用的 URL 必然存在

## How to get to it (user POV)

- 改规则与分组：`config/sing-box/settings.yaml`，本地列表在 `config/rules/custom/`
- 改原生字段：`config/sing-box/base.yaml` 与 `config/sing-box/platforms/`
- 生成：`just template-build`
- 校验：`just template-check` 或 `just verify`（其上再加 Rust 与模板结构测试）

## Driving it with verify.js

Preconditions: 已 `launch`

- 契约通过：`doctor` 会执行 `bun scripts/build-config.ts --check`，失败即列出漂移位置
- 全量校验：`just verify` = `check-rust-fast` + `check-rust-test` + `check-template`（`template-check` + `check-singbox` + `check-deprecated` + `bun test` 三个模板结构测试）+ `check-rules`
- 发布侧核对：`gh api repos/shelken/proxy/contents/singbox?ref=sing-box-rules --jq length` 返回的是**文件数**（`.json` + `.srs` + 伴生，约为规则数的数倍），不是规则数

## Gotchas

- 生成器不校验出站组是否有节点，空组由 sbtools 装配时处理：整组跳过，直指它的路由规则与 DNS detour 回退 `proxy`
- 三份 template 是生成产物，直接手改会在下一次构建被覆盖（`just template-check` 会先报出不一致）
- 发布 URL 指向 `sing-box-rules` 分支而非 `main`；改规则后必须等 CI 重新发布，否则 URL 仍指向旧产物
