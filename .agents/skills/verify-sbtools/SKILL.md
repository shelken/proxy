---
name: verify-sbtools
description: 验证 sbtools 的 CLI 与 HTTP 服务。用于新二进制验收、配置加载回归、加密订阅闭环、日志跟踪和 trace 诊断验证。
---

# 验证 sbtools

在开发机运行。先读 [功能地图](features/README.md)，再选择用例。完整验收覆盖全部组，部分组通过不能称为全部功能通过。

## Launch

前置工具为 Bun、Cargo、Docker、Lima 和运行中的 `proxy-test` VM。Docker 已有 `rust:1-bookworm` 镜像，宿主 Cargo registry 已缓存依赖。VM 已有 `/opt/proxy-test/bin/bun`、`/opt/proxy-test/bin/sing-box`、Python、OpenSSL、curl 和 iproute2。VM 用户必须有无密码 sudo，可执行 `unshare`。缺少工具或缓存就停止，报告缺项，不安装、不拉镜像。

从仓库根运行：

```sh
RUN=".sandbox-artifacts/verification/$(date -u +%Y%m%dT%H%M%SZ)"
bun --no-env-file .agents/skills/verify-sbtools/helpers/verify.js launch --out "$RUN"
```

入口复制公开构建输入，离线构建 macOS 与 Linux 二进制，记录提交号、输入指纹和二进制 SHA-256。`manifest.json` 的 `phase` 为 `ready` 才能继续。不要使用版本号相同的旧二进制替代新构建。

每次运行使用唯一 VM 目录。离线、服务端和合成观测组各有独立网络、挂载及 PID 命名空间，只有 loopback，无默认路由。公网组仅在 VM 内运行，不创建 TUN、不更改 VM 路由。所有节点、订阅、HOME 和配置由用例生成。公网访问为公开模板与 `example.com`。

不要直接运行默认的 `just sandbox-loop`，它会读取个人配置。不要读取私人配置或 `.env`。不要连接宿主机 9090。只替换 HOME 不算网络隔离。

## Doctor

检查构建产物和来源，并将结果写入证据目录：

```sh
bun --no-env-file .agents/skills/verify-sbtools/helpers/verify.js doctor --out "$RUN"
```

要求两个实际二进制的哈希与 manifest 一致，当前源码指纹没有变化，两个平台的 `version` 输出一致。运行中的服务由各组自己启动，用实际 `/healthz` 或 `/version` 确认就绪。已有进程不属于本次运行，不借用它。

## Drive

执行全部组：

```sh
bun --no-env-file .agents/skills/verify-sbtools/helpers/verify.js drive --out "$RUN"
```

只验证对应地图时，用 `--suite offline`、`--suite server`、`--suite observability`、`--suite remote`、`--suite mac` 或逗号连接多个组。一次 drive 结束后会清理 VM 运行目录。再次 drive 先重新 launch 到新目录。

完整自动入口包含 launch、doctor、drive 和 cleanup：

```sh
bun --no-env-file .agents/skills/verify-sbtools/helpers/verify.js all
```

`--source` 指定另一份代码，`--vm` 指定已有 VM，`--build-dir` 指定可复用构建缓存。入口每次仍执行构建，不把缓存产物视为已验证。

## Evidence

保存 `manifest.json`、构建日志、`suite-*.log`、各组 `results-*.json`、实际内核和服务端日志、两份被测二进制、源码快照与用例快照。证据目录在 `.sandbox-artifacts/verification/`，Git 已忽略此目录。

CLI 记录命令、stdout、stderr 和退出码。HTTP 记录请求方法、端点、状态码与响应。订阅证明包含真实 encode URL 经真实 server 解密后返回的节点和 overlay。日志证明包含历史文件与新请求产生的内核日志。trace 证明包含实际 DNS、存续连接和静态规则。

自签名 TLS、无服务端、篡改密文和 fakeip 是负面对照。要求预期失败时仍报告其实际退出码。公网不可达是未通过或阻塞，不能按合成用例通过处理。`mac` 组核对实际剪切板 URL，并恢复原有数据类型和内容；原内容只在内存中保存，不写入证据。

报告每个功能组的实际结果、二进制 SHA-256、证据路径和未覆盖分支。复用产物时先跑 Doctor。

## Cleanup

```sh
bun --no-env-file .agents/skills/verify-sbtools/helpers/verify.js cleanup --out "$RUN"
```

用例只终止自己启动的进程。PID 命名空间退出时回收其子进程。入口删除自己的 VM 目录和自己创建的构建缓存，保留证据。launch 或 drive 出错后也执行 cleanup。清理后检查 manifest 与结果文件仍存在。

## Helpers

`helpers/verify.js` 是开发机入口。`helpers/isolate.py` 由入口在 VM 中执行，验证网络隔离后启动 Bun。`helpers/*.test.js` 直接调用实际二进制和官方内核。只有 `mac` 组在 macOS 宿主运行，由入口设置被测路径；其余测试不要在宿主机直接执行。

通过 `/maintain-verification-skill` 同步功能地图和用例。
