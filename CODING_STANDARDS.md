# 开发规范

## 通用

- 动手前先找参考实现：Loon 与脚本类需求先检索 GitHub，例如 [chavyleung/scripts](https://github.com/chavyleung/scripts/)
- 代理软件配置面向最新版本编写：先查阅最新文档，不使用标记废弃的配置项
- 仓库保持公开：不写入节点与凭据
- 调用目标网站接口限于用户允许的范围，不做穷举探测

## 沙箱

- 网络行为与规则测试只在沙箱 VM 内跑
- 用真实数据验证，重点看实际节点与规则的出口、速度、延迟变化
- 宿主机不建 TUN、不改路由表，不改动本机在用的规则
- 测试用 bun，入口见 `justfile`
- 工具走 mise，不在本地或容器临时安装包

## sing-box 与规则

- `template.json`、`template-ios.json` 与 `template-router.json` 由 `just template-build`（`scripts/modules-build.ts`）一次重建：读 `config/sing-box/modules.yaml`，按 `roles.<角色>` 列表把片段物化成临时目录，再交给 `sing-box merge`。片段内容在 `config/sing-box/fragments/{base,ios,router}/`，决策见 `docs/adr/0013`；路由器底模不写任何设备数据（MAC、IP、secret），这些只放设备 overlay
- 顺序在 `modules.yaml` 的 `roles` 列表里，不在文件名里：`roles.mac` 是基准顺序，`roles.ios` 与 `roles.router` 在它之上换片段、加片段；插队 = 在列表里挪一行。片段改名要连着改：`config/sing-box/tests/lib/manifest.ts` 的 `MAC_ORDER`，变体片段还要改各自测试里 `IOS_DIFF` / `ROUTER_DIFF` 的 `fragments`、`replace` 与 `insertAfter`（后两者里也记着变体片段的路径，只改 `fragments` 会让 `applyPatch` 产出旧 key）。每个平台**没有**哪些能力，由「条目不在该角色的列表里」表达；关掉一个能力要同时删掉清单声明（`{ catalog: X }`）与用它的规则片段，登记在 `config/rules/index.yaml` 的 tag 还要从清单里删掉，否则 `just rules-check` 会报「清单里的 X 未在底模 route.rule_set 声明」。只删声明会做出「规则引用未声明的 rule_set tag」的产物：变体侧内核 `check` 与 `merge` 对它都退出码 0，只有产物测试的不变量能拦；底模 `template.json` 侧 `just rules-check` 也能报出同一条
- 新增服务 = 改 5 处：`modules.yaml` 的 `services` 里加一行（`rule_set`、`outbound`、selector 的候选与默认值），三个角色列表各加一条 `{ service: <outbound> }`，`config/sing-box/tests/lib/manifest.ts` 的 `MAC_ORDER` 加一条；配套在 `config/rules/index.yaml` 登记 rule_set。漏条目或错位都会被 `assertRoleOrder` 拦下（变体的期望值是 `MAC_ORDER` 加注册补丁），表里留下没人引用的条目则由孤儿断言拦下
- 服务顺序的三条策略由角色列表的条目顺序兑现：**拦截 > 模式开关 > 服务分流**（`base/reject.json` 早于 `base/quic-guard.json`：QUIC 的国内豁免会把同属 `ChinaMax` 的统计域名判成直连，实测 `hm.baidu.com` 同属 `Advertising`、`loggw-ex.alipay.com` 同属 `MyReject`，见 `docs/adr/0008`）；`base/reject.json` 早于 `base/clash-mode.json` 与全部服务条目，否则 `global` 模式会连同广告与黑名单一起放行，按域名关键词分流的规则也会截胡本该 reject 的域名；自有清单默认排在外部清单之前，避免宽泛的上游清单抢占自有域名，分流类 `MyDirect` 与 `MyProxy`（`base/own-lists.json`）排在所有服务条目之前；出站组默认 `direct` 的服务条目排到服务段末尾，避免默认直连组抢占代理流量；理由见 `docs/adr/0007-order-service-rules-own-lists-first.md`
- 顺序改动会被测试抓住：`config/sing-box/tests/lib/manifest.ts` 存着基准顺序与两个变体的注册补丁，任何重排都会在 `bun test` 里显示成 diff（实测把 `clash-mode` 挪到 `reject` 之前会同时打红顺序断言与 ADR-0008 的语义断言）
- merge 语义陷阱：同一层按路径字典序拼接，**标量取字典序最早者的那一份**。往前面插一个也写同一个标量的片段会静默夺权——不报错、不改数组结构，只把取值换掉；给已有能力补片段前先确认它写不写标量
- BT 直连经 `torrent` 策略组下发（默认 `direct`，候选含 `selfhost` / `proxy`），识别只按协议嗅探（`protocol: bittorrent`），不依赖清单、端口与进程名；tracker 域名不单独建组，落 `final: proxy`，理由见 `docs/adr/0009`
- QUIC 守卫（UDP 443/80 `reject`）必须自带国内直连豁免（`ChinaMax` / `Lan` / `cftunnel` / `geoip-cn` 走 `direct`）并置 `no_drop: true`：豁免靠 `matchRule` 在匹配前调 `prepareMatchMetadata` 把 fakeip 还原为域名，`no_drop` 避免 30 秒内超过 50 次后从 ICMP 不可达退化为静默丢包
- 改动底模、出站与规则集前先查阅[配置文档](https://sing-box.sagernet.org/configuration/)与 [changelog](https://sing-box.sagernet.org/changelog)
- raw.githubusercontent.com 同一文件至少间隔 5 分钟再拉取，CDN 存在缓存，遇到旧内容或 404 先核实缓存
- `base/resolve.json` 包含 `action: resolve` 规则，让代理流量在本机按 v4 解析后再交给节点；排除清单必须覆盖所有默认直连规则集（出站为 direct 或默认 direct 的策略组），避免直连流量被远端解析器解析为海外 IP；该清单由底模推导并由 `config/sing-box/tests/template.test.ts` 断言
