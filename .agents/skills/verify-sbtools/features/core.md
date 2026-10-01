# 基础命令

用户查看版本、命令用法或生成服务端密钥。

## Sub-features

- `version` 覆盖 `version`、`--version` 和 `-V`
- `usage` 覆盖无参数帮助与未知命令拒绝
- `keygen` 覆盖公私钥格式和独立生成

## How to get to it (user POV)

运行 `sbtools version`、`sbtools --version`、`sbtools -V`、`sbtools` 或 `sbtools keygen`。

## Driving it with verify-sbtools

Preconditions:

- Launch 与 Doctor 完成，`RUN` 指向本次证据目录

运行 `bun --no-env-file .agents/skills/verify-sbtools/helpers/verify.js drive --out "$RUN" --suite offline,mac`。

版本入口应返回相同版本和退出码 0。无参数显示帮助。未知命令退出 1。两次 keygen 产生格式正确且不同的密钥；服务端组再用生成的私钥启动实际服务，并核对 `/pubkey`。

## Gotchas

版本号不能证明源码相同。以 Doctor 的提交与哈希确认被测产物。生成的密钥仅用于夹具，不能复用为生产密钥。
