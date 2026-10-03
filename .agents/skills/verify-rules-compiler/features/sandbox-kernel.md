# 沙箱内核命中

生成的 `.srs` 在真实 sing-box 内核里加载后，必须按规则做出正确的路由裁决。用户看到的是内核 debug 日志里的 `match[N] rule_set=<tag>` 与对应的出站结果。

## Sub-features

- `kernel-load`：sing-box `check` 与 `run` 接受生成的配置与 `.srs`，无解析错误。
- `kernel-hit`：属于某 tag 的域名命中该 `rule_set` 并执行对应 action。
- `kernel-miss`：不属于任何 `rule_set` 的流量落到 `final` 出站。
- `kernel-isolation`：断言在 VM 内完成，不触碰宿主在用网络。

## How to get to it (user POV)

- 规则集级验证（本 skill 的方式）：`D3` 组在 VM 内用项目自己生成的 `.srs` 起最小内核，不拉 CI 产物、不起 sbtools、不读个人配置。
- 内置端到端测试：`just test-sandbox` 会先跑 `just sandbox-loop`（`gh run download` 拉 CI 产物 + 起 sbtools 服务端，可能读取 `~/.config/sing-box/config.yaml`），再把 `config/sing-box/tests/` 拷到 VM 的 `/work/sing-box/tests` 运行；不适合作为本 skill 的常规验证路径。
- DNS 策略对照：`just test-dns`（进程内合成上游，只读 `template.json`，不依赖服务端产物）。
- 单域名全链路：`just trace <domain>`、`just dns-observe`——二者读 `.env` 的 `SUB_URL` / `NODE_URI`，缺失即 throw，并同样会 bootstrap（拉 CI 产物）。

## Driving it with verify.js

Preconditions: 宿主联网（`launch` 要拉上游清单）；VM `proxy-test` 已 `just vm-create` 并 `just vm-start`；VM 内需免密 sudo。

- 启动就绪：`D3/check` 与 `D3/ready` 断言配置通过 `sing-box check` 且内核进入 started。
- 命中路径：`D3/hit` 断言 `javdb.com`（属 Adult 的 `domain_suffix`）在日志里命中 `rule_set=Adult` 且被 block（curl 非 0 退出）。
- 未命中路径：`D3/miss` 断言 `example.com` 未命中规则集，走 `final=direct`（HTTP 200）。
- 原始证据：`kernel.log` 含启动日志、两条 curl 结果与 `grep match` 的裁决行。

## Gotchas

- 域名规则命中依赖 sniff：TUN 入站只看得到 IP，没有 sniff action 时域名规则不会命中（D3 用 mixed 入站且配置了 `{ action: "sniff" }`）。
- 宿主机禁止跑 `sing-box run`：需要 TUN 与 sudo，会破坏在用网络；只在 VM 内跑。
- `curl` 经代理访问被 block 的目标会以非 0 退出（如 35/56），这不是环境故障，是命中结果。
- 内核日志级别必须是 `debug` 才有 `router: match` 行；`info` 下看不到裁决。
- 只终止本次启动的实例（按自己的配置路径匹配），不要 `pkill -f sing-box` 波及他人在跑的实例。
