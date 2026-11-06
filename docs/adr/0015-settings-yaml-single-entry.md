# 日常维护收敛到 settings.yaml，底模由生成器装配

**日期**：2026-11-06

底模的输入从「`modules.yaml` 一张表加 `fragments/` 一层语义片段加 `rules/index.yaml` 清单」收敛为 `config/sing-box/settings.yaml` 一个日常入口，另有 `base.yaml`（三端共享的原生字段）与 `platforms/<角色>.yaml`（平台差异）。与设置相关的路由、DNS 规则由 `scripts/build-config.ts` 的 `makePolicy` 生成，再交给官方 `sing-box merge`。三份产物的形态与顺序语义不变，取代 [0013](0013-module-manifest-with-semantic-fragments.md) 的布局

## Context

- 0013 之后一个服务仍要改多处：清单、模块表的 `services`、三个角色列表、测试里的基准顺序，其中服务名、规则名与出站名靠手工保持一致
- 「清单声明」与「底模声明」两边各写一份，靠 `rules-check` 事后比对，才有了「清单里的 X 未在底模声明」这类报错
- 规则顺序与 DNS 伴生的引用本就是设置的函数，手写片段只是在重复推导结果

## Decision

- `settings.yaml` 的 `rules` 每条 `{ name, source, to }`，书写顺序即首匹配顺序，`groups` 定义出站分组。规则声明、路由引用与 `-dns` 伴生出自同一次生成，清单与底模无从漂移，`rules-check` 与 `index.yaml` 随之删除
- 生成器固定两段顺序：`to: reject` 在前，`to: download` 在 BT 之后。其余顺序就是书写顺序，顺序契约由 `config/sing-box/tests/lib/contracts.ts` 守
- DNS 与 QUIC 策略写在规则自己身上：`dns`（reject / lan / fakeip / direct-cn）与 `quic`（allow / reject）。生成器按策略分组，不认识任何具体规则名，改名、改去向、删除都只影响这一条规则
- 平台差异留在 `platforms/*.yaml` 的原生字段里。路由器的 `dns-in` 入口与 iOS 的 `ts-ep` 入口两条路由规则必须夹在 sniff 与 DNS 劫持之间，而 `merge` 对数组只追加，所以这两条仍由生成器按角色写入
- 路由规则直指的分组在订阅无匹配节点时被 sbtools 整组跳过，装配时让这类规则回退 `proxy` 再回退 `direct`，与 DNS detour 同一条回退链

## Consequences

- 新增服务只改 `settings.yaml` 与 `config/rules/custom/`，旧的片段与表条目不复存在
- 0006、0010、0012 里关于 `modules/`、`fragments/` 与 `modules.yaml` 的描述是当时的布局，决策本身仍成立；0014 的 DNS 归属决策不变
- 回退到 `proxy` 会改变「固定走自建」的语义，是为了避免内核启动失败的取舍
