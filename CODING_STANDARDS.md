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

- `template.json` 与 `template-ios.json` 由 `just template-build` 一并重建：前者从 `modules/` 合并，后者由 `modules/` 加 `modules-ios/` 合并（`modules-ios/` 的同名文件替换、其余新增），决策见 `docs/adr/0010`
- `modules/` 文件名前缀决定合并顺序，即 `route.rules` 与 `outbounds` 的数组顺序：`00`-`29` 为入站、DNS 与路由全局属性，`30`-`39` 为前置动作、私网守卫、拦截、QUIC 守卫、模式开关、BT 与下载分流、解析与核心出站组，`41`-`63` 为自有清单服务，`65`-`69` 为外部清单服务，`71`-`79` 为默认直连分组，`80` 为兜底规则，`90` 为收尾；每个服务对应独立文件，号段留空便于插队；新增服务只需新建文件并在 `index.yaml` 登记 rule_set
- 服务顺序的三条策略：**拦截 > 模式开关 > 服务分流**（`32-reject.json` 早于 `33-quic-guard.json`：QUIC 的国内豁免会把同属 `ChinaMax` 的统计域名判成直连，实测 `hm.baidu.com` 同属 `Advertising`、`loggw-ex.alipay.com` 同属 `MyReject`，见 `docs/adr/0008`）；`32-reject.json` 早于 `34-clash-mode.json` 与全部服务，否则 `global` 模式会连同广告与黑名单一起放行，按域名关键词分流的规则也会截胡本该 reject 的域名；自有清单默认排在外部清单之前，避免宽泛的上游清单抢占自有域名，分流类 `MyDirect` 与 `MyProxy` 排在所有服务规则之前（`40-my-rules.json`）；出站组默认 `direct` 的服务模块排到服务号段末尾，避免默认直连组抢占代理流量；理由见 `docs/adr/0007-order-service-rules-own-lists-first.md`
- BT 直连经 `torrent` 策略组下发（默认 `direct`，候选含 `selfhost` / `proxy`），识别只按协议嗅探（`protocol: bittorrent`），不依赖清单、端口与进程名；tracker 域名不单独建组，落 `final: proxy`，理由见 `docs/adr/0009`
- QUIC 守卫（UDP 443/80 `reject`）必须自带国内直连豁免（`ChinaMax` / `Lan` / `cftunnel` / `geoip-cn` 走 `direct`）并置 `no_drop: true`：豁免靠 `matchRule` 在匹配前调 `prepareMatchMetadata` 把 fakeip 还原为域名，`no_drop` 避免 30 秒内超过 50 次后从 ICMP 不可达退化为静默丢包
- 改动底模、出站与规则集前先查阅[配置文档](https://sing-box.sagernet.org/configuration/)与 [changelog](https://sing-box.sagernet.org/changelog)
- raw.githubusercontent.com 同一文件至少间隔 5 分钟再拉取，CDN 存在缓存，遇到旧内容或 404 先核实缓存
- `38-resolve.json` 包含 `action: resolve` 规则，让代理流量在本机按 v4 解析后再交给节点；排除清单必须覆盖所有默认直连规则集（出站为 direct 或默认 direct 的策略组），避免直连流量被远端解析器解析为海外 IP；该清单由底模推导并由 `config/sing-box/tests/template.test.ts` 断言
