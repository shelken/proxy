---
name: verify-rules-compiler
description: 验证规则编译管道（外部 meta-rules-dat 镜像 + 内部 custom YAML AST）。用于 PR 变更回归、三端产物形态核对、清单-底模契约、沙箱内核规则命中验证。
---

# 验证 rules-compiler

在开发机运行；内核行为断言在 `proxy-test` Lima VM 内完成。先读 [功能地图](features/README.md)，再选择用例。部分组通过不能称为全部功能通过。

## Launch

前置：Bun、`limactl`、运行中的 `proxy-test` VM（`just vm-start`）。VM 需有 `/opt/proxy-test/bin/sing-box` 与仓库挂载（`$HOME` 映射到只读的 `/host-home`）。缺一即停止并报告，不安装、不拉镜像。

编译在宿主完成且会联网拉上游清单，所以 Launch 需要网络。

```sh
RUN=".sandbox-artifacts/verification/$(date -u +%Y%m%dT%H%M%SZ)"
bun --no-env-file .agents/skills/verify-rules-compiler/helpers/verify.js launch --out "$RUN"
```

launch 执行 `bun scripts/rules-compile.ts build --all`（33 个 tag），并把 commit、`index.yaml`/`template.json` 指纹与全部产物的 SHA-256 写入 `manifest.json`。`phase` 为 `ready` 才能继续。不要用旧 `generated/` 冒充本次构建。

不要直接跑 `just sandbox-loop`：它取 CI 产物并起 sbtools 服务端，会牵入个人订阅；规则验证不需要它。

## Doctor

```sh
bun --no-env-file .agents/skills/verify-rules-compiler/helpers/verify.js doctor --out "$RUN"
```

核对 manifest 就绪、HEAD 未漂移、产物哈希未变、`rules-compile.ts check` 契约通过、VM 可达且 VM 内 sing-box 与仓库挂载可见。任一失败就停，先修再 drive。

## Drive

```sh
bun --no-env-file .agents/skills/verify-rules-compiler/helpers/verify.js drive --out "$RUN"
```

四组断言：

- **D1 三端产物形态**：抽样 tag 的 `.srs` / `.yaml` / `.list` 存在且非空；clash 产物以 `payload:` 开头。
- **D2 语义（VM 内）**：`sing-box rule-set decompile` 把 `.srs` 反编译为 JSON，断言内部 AST 的 logical 树、`no-resolve` 在 sing-box 端被剥离、外部镜像的 IP 段规模。
- **D4 DNS 伴生产物**：internal 有 `-dns.json` + `-dns.srs`、geosite 伴生与主产物字节相同且无中间 JSON、geoip 不产伴生；`Lan-dns` 反编译后只含 domain 类字段（`Lan` 主产物作对照组）。
- **D3 内核命中（VM 内）**：起 sing-box 加载生成的 `.srs`，断言 `javdb.com` 命中 `rule_set=Adult` 被 block、`example.com` 未命中走 `final=direct`。

全流程入口（launch → doctor → drive → cleanup）：

```sh
bun --no-env-file .agents/skills/verify-rules-compiler/helpers/verify.js all
```

## Evidence

证据落在 `--out` 目录（默认 `.sandbox-artifacts/verification/<UTC 时间戳>`，Git 已忽略）：

- `manifest.json`：commit、源指纹、全部产物 SHA-256
- `build.log`：全量构建输出
- `doctor.log`：就绪检查结果
- `decompiled/<tag>.json`：`.srs` 反编译后的 JSON
- `kernel.log`：VM 内 sing-box 启动、命中裁决、清理记录
- `results.json`：每条断言的 id / ok / detail

证明标准：D3 必须走真实内核——项目自己编译的 `.srs` + 官方 sing-box，不是内部 setter 或测试专用端点；命中与未命中两条路径都要看到，且以内核日志里的 `match[N] rule_set=<tag>` 裁决行为准。产物正确性以 `decompile` 后的 JSON 为准，不以文件名或大小为准。

## Cleanup

```sh
bun --no-env-file .agents/skills/verify-rules-compiler/helpers/verify.js cleanup --out "$RUN"
```

只终止自己启动的 sing-box（按 `/work/rule-verify/config.json` 路径匹配，用 `rule-verif[y]` 正则避免 `pkill -f` 命中本身），并删除 VM 临时目录。证据不删。`all` 与每次失败迭代后都会执行 cleanup。

## Helpers

`helpers/verify.js` 是唯一入口：子命令 `launch` / `doctor` / `drive` / `cleanup`，以及组合 `all`。它不读个人配置、不启动 sbtools、不改宿主网络；内核断言全部在 VM 内。通过 `/maintain-verification-skill` 同步功能地图。
