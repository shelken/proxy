# 清单-底模契约

`config/rules/index.yaml` 声明的 tag 集合必须与 `config/sing-box/template.json`（底模）声明的规则集一致。用户改了一边忘了另一边时，构建期的校验会直接报出是哪个 tag 漂移。

## Sub-features

- `contract-check`：`rules-compile.ts check` 比较清单 tag 与底模 `route.rule_set` 声明。
- `contract-publish`：发布分支只包含清单产出的产物，底模引用的 URL 必然存在。
- `contract-dns`：底模 DNS 规则引用的 `-dns` 规则集必须都有域名版产物。

## How to get to it (user POV)

- 改清单：`config/rules/index.yaml`。
- 改底模：`config/sing-box/modules/*.json`，再 `just template-build` 生成 `template.json`。
- 校验：`just rules-check`（只校验清单）或 `just verify`（含模板与契约）。

## Driving it with verify.js

Preconditions: 已 `launch`。

- 契约通过：`doctor` 会执行 `bun scripts/rules-compile.ts check`，失败即列出漂移的 tag。
- 全量校验：`just verify` 组合 `check-singbox` + `rules-check` + `template-build --check`。
- 发布侧核对：`gh api repos/shelken/proxy/contents/singbox?ref=sing-box-rules --jq length` 与清单 tag 数贴合。

## Gotchas

- `rules-check` 只比 tag 集合；出站去向（direct / proxy / reject）由底模单方面决定，清单不重复声明。
- `template.json` 由 `just template-build` 从 `modules/*.json` 生成；直接手改 `template.json` 会在下一次构建被覆盖。
- 内联声明（如 `zone-internal`）不是清单产物，不参与 DNS 伴生要求。
- 发布 URL 指向 `sing-box-rules` 分支而非 `main`；改底模后必须等 CI 重新发布，否则 URL 仍指向旧产物。
