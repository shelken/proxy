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

- 三份底模 `template.json`、`template-ios.json`、`template-router.json` 是生成产物，由 `just template-build`（`scripts/build-config.ts`）重建，直接手改会在 `just template-check` 里报不一致。输入分三层：`config/sing-box/settings.yaml`（规则与分组，日常只改这里）、`base.yaml`（三端共享的原生字段）、`platforms/<角色>.yaml`（平台差异的原生字段），再由 `makePolicy` 生成与设置相关的路由、DNS 规则，最后交给 `sing-box merge`。决策见 `docs/adr/0015`
- 路由器底模不写任何设备数据（MAC、IP、secret），这些只放设备 overlay，见 `docs/adr/0014`
- 新增服务只改 `settings.yaml`：在 `groups` 加出站分组，在 `rules` 加一条 `{ name, source, to }`；本地规则列表放 `config/rules/custom/`。顺序、`rule_set` 声明与 `-dns` 伴生都由生成器产出，漏登记的 custom 列表会在 `rules-build` 时被警告为孤儿
- 规则顺序就是 `settings.yaml` 里 `rules` 的书写顺序，只有两段由生成器固定：`to: reject` 的规则最前，`to: download` 的规则在 BT 之后
- 三条顺序策略：**拦截 > 模式开关 > 服务分流**。reject 早于 QUIC 守卫，QUIC 的国内豁免会把同属 `ChinaMax` 的统计域名判成直连（实测 `hm.baidu.com` 同属 `Advertising`、`loggw-ex.alipay.com` 同属 `MyReject`，见 `docs/adr/0008`）；reject 早于 `clash_mode` 与全部服务规则，否则 `global` 模式会连同广告与黑名单一起放行；自有清单排在外部清单之前，避免宽泛的上游清单抢占自有域名，`MyDirect`、`MySelfhost`、`MyProxy` 排在所有服务规则之前，理由见 `docs/adr/0007-order-service-rules-own-lists-first.md`
- 顺序契约由 `config/sing-box/tests/lib/contracts.ts` 的断言守护，三份模板测试复用同一组断言
- 有 7 个规则名被 DNS 与 QUIC 规则按名字引用（见 `settings.yaml` 头注释），改名、删除或改去向不会报错，只会省略依赖它的规则，构建时打印 `WARN`
- 路由规则的出站指向的分组可能因订阅无匹配节点被整组跳过，sbtools 装配时会把这类规则回退到 `proxy`（再回退 `direct`）。新增直指某个节点分组的规则时，先确认它走这条回退
- BT 直连经 `torrent` 策略组下发（默认 `direct`，候选含 `selfhost` / `proxy`），识别只按协议嗅探（`protocol: bittorrent`），不依赖清单、端口与进程名；tracker 域名不单独建组，落 `final: proxy`，理由见 `docs/adr/0009`
- QUIC 守卫（UDP 443/80 `reject`）必须自带国内直连豁免（`ChinaMax`、`Lan`、`cftunnel`、`geoip-cn` 走 `direct`，固定四个名字，其他直连规则不在其中）并置 `no_drop: true`：豁免靠 `matchRule` 在匹配前调 `prepareMatchMetadata` 把 fakeip 还原为域名，`no_drop` 避免 30 秒内超过 50 次后从 ICMP 不可达退化为静默丢包
- 改动底模、出站与规则集前先查阅[配置文档](https://sing-box.sagernet.org/configuration/)与 [changelog](https://sing-box.sagernet.org/changelog)
- raw.githubusercontent.com 同一文件至少间隔 5 分钟再拉取，CDN 存在缓存，遇到旧内容或 404 先核实缓存
- `action: resolve` 规则让代理流量在本机按 v4 解析后再交给节点；排除清单必须覆盖所有默认直连规则集（出站为 direct 或默认 direct 的策略组），避免直连流量被远端解析器解析为海外 IP；该清单由 `makePolicy` 按最终去向推导，并由 `config/sing-box/tests/template.test.ts` 断言
