# 变体接口用能力文件，不用整份拷贝

**日期**：2026-11-04

变体（`modules-ios/`、`modules-router/`）与共享底模的接口从「整份文件同名替换」收窄成「能力文件 + 同名空集弃用」：底模按可独立变化的事实拆文件，变体不要哪一份就在自己的目录放同名空集文件。取代 [0012](0012-router-template-for-side-router.md) 里「同名整份替换」那段机制

## Context

- 合并语义是「`modules/` 为底，变体目录同名替换、其余新增」（`scripts/merge-variant-template.sh`），删不掉条目，于是「这个角色不要这一片」原先只能靠整份拷贝表达
- 拷贝的代价是静默漂移：底模改一条规则，各份拷贝要逐份跟改，跟漏了没有任何检查会发现。`modules-router/90-experimental.json`（为一个标量付的整份文件）就是这么留下来的
- 反例约束：iOS 的 `dns.rules` 首条必须是 ts-ep 入站拒绝（[0010](0010-ios-template-with-embedded-tailscale.md)），所以共享底模里「部署域静态应答」那一份的位置被卡在 `09-tailscale-dns.json` 与 `10-dns.json` 之间

## Decision

底模按可独立变化的事实拆文件，变体不要某一份，就在变体目录放同名空集文件，写显式空集而不是 `{}`，让「不要这一份」在文件里读得出来。本次拆出 `modules/10-dns-deployment.json`（部署域静态应答）与 `modules/10-dns-lan-resolver.json`（本网解析器定义），路由变体用同名空集弃用两份；变体目录里除真有对象差异的 `00-inbounds.json` 与 `29-dns-in.json` 之外不再有共享文件

配套的前提是把本网解析器的 tag 在共享底模与三个角色之间统一为 `dns-lan`：没有任何规则需要为改 tag 而抄文件，剩下的差异才只有「哪几份能力存在」

## Consequences

- 文件名次序就是数组次序，改名等于改合并结果；约定与两个能力文件的位置写进 `CODING_STANDARDS.md`，动手前用 `just template-build` 对照三份产物
- 路由侧弃用部署域静态应答的前提与回退见 [0014](0014-deployment-domain-dns-on-main-router.md)
- mac / iOS 的产物只随 tag 改名变化，数组次序不动
- 发到设备的配置由订阅 URL 里的 overlay 与从 `main` 拉的底模合并而成，两者不原子推进：底模先走、overlay 未重铸时 `sing-box check` 会失败并保留旧配置，表现为不收敛而不是掉线
