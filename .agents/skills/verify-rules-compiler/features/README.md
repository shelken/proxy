# rules-compiler 验证地图

本目录是 rules-compiler（`scripts/rules-compile.ts`）用户可见行为的验证源。驱动前先读本索引，再按对应功能文件执行。

## Baseline preconditions

- 从仓库根运行，工作区干净（`git status --porcelain` 为空）或已知的未提交改动已记录。
- `proxy-test` VM 处于 Running（`just vm-start`），且能通过 `limactl shell --workdir /work proxy-test` 进入。
- Launch 会在宿主联网重跑全量构建（33 个 tag），用同一份 `generated/` 供所有功能文件使用。
- 产物只以本次 launch 生成的为准；不要复用别的运行留下的 `generated/`。
- 不要驱动 `just sandbox-loop` 起的服务端，它牵入个人订阅；本地图只用 `verify.js` 在 VM 内直接起 sing-box。

## Driving conventions

- 每条 recipe 都从同一份 `$RUN` 证据目录出发；`launch` 一次，之后 `doctor` + `drive` 可重复执行。
- 把命令当字面量执行，不要改写 tag 名、路径或引号。
- 产物断言一律以 `sing-box rule-set decompile` 后的 JSON 为准，不以文件名、大小或本地文本猜测为准。
- 内核断言（D3）只在 VM 内跑；宿主机上起 `sing-box run` 需要 TUN 与 sudo，会破坏在用网络，禁止。

## Proof and skip reporting

- 记录用户动作与结果状态：命令、stdout/stderr、退出码、内核日志裁决行。
- 产物证明包含 `manifest.json` 的 SHA-256 与 `decompiled/*.json`。
- 内核证明包含 `kernel.log` 里的 `match[N] rule_set=<tag>` 与两条路径（命中 / 未命中）的结果。
- 记录每条断言使用的 tag 与入口。
- 跳过某个入口点时报告尝试的命令与未满足的前置条件，不要当成已验证。
- 闸门产物不可达（HTTP 非 200）或 VM 不可达视为未通过或阻塞，不能按通过处理。

## Feature entry contract

每个功能文件以 H1 标题与一段用户可见行为描述开头，随后固定四个 H2，顺序如下。

1. `Sub-features` 列出短 ID 与每条行为一行。
2. `How to get to it (user POV)` 列出全部用户入口。
3. `Driving it with verify.js` 以 `Preconditions:` 开头，用带标签的条目把用户动作与确切命令、可观察结果配对。
4. `Gotchas` 列出会浪费或作废一次验证的陷阱。

## Features

- [外部规则镜像](./external-mirror.md)：`geosite:x` / `geoip:x` 直接镜像 meta-rules-dat 三端原生资产。
- [内部 YAML AST 编译](./custom-yaml.md)：`custom/*.yaml` → AST → 三端产物（含 logical 树、端口范围、no-resolve）。
- [清单-底模契约](./manifest-contract.md)：`index.yaml` 的 tag 集合与 `template.json` 声明一致。
- [DNS 伴生产物](./dns-companion.md)：`-dns` 规则集的产出与省略规则。
- [沙箱内核命中](./sandbox-kernel.md)：VM 内 sing-box 加载 `.srs` 并按规则路由。
