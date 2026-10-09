# 服务规则排序：自有清单优先，默认直连靠后

`route.rules` 首匹配优先，服务之间的先后就是行为。本决策把「自有清单排在外部清单之前」「默认直连的分组排到最后」写进文件名前缀约定，并把 `30-route-base-rules.json` 按关注点拆成 5 个文件

## Context

- `github.com` 被上游的 `geosite:microsoft` 抢走：上游把 GitHub 整块归在微软名下（该清单 633 条后缀含 `github.com`、`github.io`、`githubusercontent.com`、`githubcopilot.com`、`github-production-*.s3.amazonaws.com`），而 `Microsoft` 规则排在自有的 `dev` 之前（`custom/dev.yaml` 里显式写了 `github.com`），于是 `github.com` 落进默认 `direct` 的 `microsoft` 组，`git` 直连被重置
- 排序机制在拆分后（`docs/adr/0006`）由文件名前缀决定，但服务之间没有任何可推理的约定：自有的 `grok` / `1024proxy` / `dev` / `ptcg` / `Japan` / `Adult` 夹在外部的 `Microsoft` / `PayPal` / `Apple` 之后
- 上游清单宽泛且每天刷新（`update_interval: 1d`），自有清单是「这些域名我要它走哪里」的显式声明，两者优先级不能靠偶然顺序
- `30-route-base-rules.json` 同时承担五件事：全局动作（`sniff` / `hijack-dns` / `clash_mode`）、守卫（私网直连、UDP 443/80 拒绝）、BT 直连、下载分流、拦截清单、解析前置，改一处要在 140 行里找位置

## Decision

1. 自有清单（`index.yaml` 指向 `config/rules/custom/`）的服务规则默认排在外部清单（`geosite:` / `geoip:`）之前；例外用文件名前缀单独安排
2. 出站组默认 `direct` 的服务模块排到服务号段最后（`71`-`79`），避免默认直连的宽泛组抢占代理流量；`MyDirect` 这类「永直连」的自有清单不适用，仍随自有清单排在前面
3. 服务号段扩到 `41`-`79`：自有 `41`-`63`、外部 `65`-`69`、默认直连 `71`-`79`，奇数编号为占用位、偶数为插队位
4. `30-route-base-rules.json` 按关注点拆分：`30` 只留全局动作与守卫，`32` BT 直连、`34` 下载分流（`download` 出站组一并移入）、`36` 拦截清单、`38` 解析前置各自成文件
5. 拦截类的 `MyReject` 纳入 `36-reject.json` 确保在解析前短路终结，分流类的 `MyDirect` / `MyProxy` 排在所有服务规则之前（`40-my-rules.json`）
6. 默认直连的规则集必须出现在 `38-resolve.json` 的排除清单里。该清单由底模推导（出站是 `direct`，或出站是默认 `direct` 的策略组）并由 `config/sing-box/tests/template.test.ts` 断言，`microsoft` / `paypal` / `apple` 按此纳入

## Consequences

- `github.com` 现在先命中 `dev`（第 22 条），不再落进 `microsoft` 组
- 拆分是纯文件重排：`template.json` 的规则集、出站组、规则集合与拆分前完全一致，只有数组顺序变化
- 排序变得可推理：看前缀就知道「自有 → 外部 → 默认直连 → 兜底」的顺序，新增服务只需挑号段
- 出站组在客户端的展示顺序随之变化：自有服务组在前，`microsoft` / `paypal` / `apple` 三个默认直连组移到最后
- 默认直连的 `microsoft` / `paypal` / `apple` 纳入解析排除清单后，它们的直连流量按本地解析（`default_domain_resolver: dns-local-system`）而不是代理侧的 Cloudflare；被切到代理时改由节点远端解析，可能走 v6（`#99` 的场景在这三个组上按需回归，这是「直连就近」与「代理必 v4」不可兼得的那条线）
- 回滚：恢复旧文件名前缀与旧的 `30-route-base-rules.json`，再 `just template-build`
