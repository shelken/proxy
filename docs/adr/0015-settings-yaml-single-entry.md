# 平台模板引入共用段，分组与分流收敛到 settings.yaml

> 状态：取代 [0013](0013-module-manifest-with-semantic-fragments.md) 的布局

**日期**：2026-11-06

底模的输入从「`modules.yaml` 一张表加 `fragments/` 一层语义片段加 `rules/index.yaml` 清单」改为三类文件：`config/sing-box/platforms/<角色>.yaml` 是各平台完整的 sing-box 模板（YAML，结构与 JSON 一致），`shared.yaml` 是三个平台共用的段，`settings.yaml` 是分组与分流。模板里用 `$include: 名字` 引入共用段与 `settings.yaml` 生成的内容，由 `scripts/build-config.ts` 展开后交给官方 `sing-box merge` 规范化。三份产物的形态与顺序语义不变

## Context

- 0013 之后一个服务仍要改多处：清单、模块表的 `services`、三个角色列表、测试里的基准顺序，服务名、规则名与出站名靠手工保持一致
- 「清单声明」与「底模声明」两边各写一份，靠 `rules-check` 事后比对
- 日常只改两类东西：分组，和规则到分组的对应。三个平台在这两类上完全相同，不同的只是入站、Tailscale、DNS 入口这类管道
- 先后试过把顺序写进生成器的数组、给规则加 `dns` 与 `quic` 字段、用 `@x` 展开骨架。前两种把策略藏进代码或让接口持续增长，第三种让一份完整的配置没有任何文件能从头读到尾

## Decision

- 每个平台一份完整模板，从上到下就是内核执行的顺序。共用的段只在 `shared.yaml` 里写一份，位置由模板决定，所以 iOS 的 `preferred_by` 可以夹在 `route-intake` 与 `route-policy` 之间
- `$include` 有两种写法：数组里的 `- { $include: 名字 }` 换成这一段的全部元素，对象里的 `$include: 名字` 把这一段的字段并进来，模板里的同名字段优先。`settings.yaml` 生成的三段是 `groups`、`rule-sets`、`services`
- `settings.yaml` 只有 `groups` 与 `rules{name,source,to}`。所有出站分组，包括 `selfhost`、`proxy`、地区组、`torrent`、`download`，都在 `groups` 里，客户端面板显示的顺序就是 `groups` 的书写顺序。接口不再增加字段，除非是日常常用的
- `rule_set` 里写规则名，引用 `settings.yaml` 的那条规则，DNS 里还可以写它的 `-dns` 伴生，伴生的声明自动生成。写去向名（`reject`、`download`、`direct`）则引入去向落在它的全部规则，`direct` 沿分组默认值解析到最终直连。引用不存在的名字时构建报错并点名
- 「只有 `rule_set` 加动作」的规则已完整路由了所引入的规则，其余规则按 `settings.yaml` 的顺序追加在 `services`
- `route-policy` 里的 QUIC 直连名单与 DNS 规则按名字引用具体规则，名字写在 YAML 里，不在代码里

## Consequences

- 新增服务只改 `settings.yaml` 与 `config/rules/custom/`。新增拦截或下载规则集也只改 `settings.yaml`，因为引入点是去向名
- 删除或改名被 `shared.yaml` 引用的规则（`MyProxy`、`ChinaMax`、`Lan` 等）时，要同时改 `shared.yaml`，构建不会静默通过
- 三个平台的 `route-intake`、`route-policy` 不再重复，平台间只有各自的管道不同
- 0006、0010、0012 里关于 `modules/`、`fragments/` 与 `modules.yaml` 的描述是当时的布局，决策本身仍成立，0014 的 DNS 归属决策不变
- 路由规则直指的分组在订阅无匹配节点时被 sbtools 整组跳过，装配时让这类规则回退 `proxy` 再回退 `direct`，与 DNS detour 同一条回退链，回退会改变「固定走自建」的语义，是为了避免内核启动失败的取舍
