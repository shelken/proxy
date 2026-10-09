# 清单-底模契约

`config/rules/index.yaml` 声明的 tag 集合必须与 `config/sing-box/template.json`（底模）声明的规则集一致。用户改了一边忘了另一边时，构建期的校验会直接报出是哪个 tag 漂移

## Sub-features

- `contract-check`：`rules-compile.ts check` 交叉比对清单与底模，四条不变量：清单 tag 须在 `route.rule_set` 声明、须出现在 `route.rules`、DNS 引用推出的 `-dns` 伴生须已声明且不得被路由、底模不得声明「清单之外且非伴生」的 tag
- `contract-publish`：发布分支只包含清单产出的产物，底模引用的 URL 必然存在
- `contract-dns`：校验的是「底模 DNS 引用的 `-dns` 伴生已声明且未参与路由」，不检查伴生产物是否存在或能否域名化

## How to get to it (user POV)

- 改清单：`config/rules/index.yaml`
- 改底模：`config/sing-box/modules/*.json`（每个服务一个文件，文件名前缀决定规则顺序），再 `just template-build` 生成 `template.json`
- 校验：`just rules-check`（读清单与 `template.json` 双向交叉校验）或 `just verify`（其上再加底模装配、Rust 与模板测试）

## Driving it with verify.js

Preconditions: 已 `launch`

- 契约通过：`doctor` 会执行 `bun scripts/rules-compile.ts check`，失败即列出漂移的 tag
- 全量校验：`just verify` = `check-rust` + `check-template`（`template-check` + `check-singbox` + `check-deprecated` + `bun test config/sing-box/tests/template.test.ts`）+ `rules-check`；`template-check` 用内核 `sing-box merge` 重跑一遍并逐字节比对 `template.json`
- 发布侧核对：`gh api repos/shelken/proxy/contents/singbox?ref=sing-box-rules --jq length` 返回的是**文件数**（`.json` + `.srs` + 伴生，约为 tag 数的数倍），不是 tag 数

## Gotchas

- `rules-check` 校验 tag 集合的四种越界，但**不比出站去向**（direct / proxy / reject），去向由底模单方面决定，清单不重复声明
- `template.json` 由 `just template-build`（内核 `sing-box merge`）从 `modules/*.json` 生成；直接手改会在下一次构建被覆盖（`just template-check` 会先报出不一致）
- 内联规则集（代码里固定的 `zone-internal`）不是清单产物，不参与 DNS 伴生要求；当前公共底模没有使用它
- 发布 URL 指向 `sing-box-rules` 分支而非 `main`；改底模后必须等 CI 重新发布，否则 URL 仍指向旧产物
