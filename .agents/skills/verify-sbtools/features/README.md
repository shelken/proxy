# sbtools 功能验证地图

此地图列出用户入口与可观察的完成状态。验收新二进制时覆盖全部组，新增命令时同步对应条目。

## 运行前提

按 [SKILL.md](../SKILL.md) 完成 Launch 和 Doctor。用例只驱动本次启动的实例。所有配置均为合成数据。

## 证明规则

记录实际命令与结果。成功路径和失败对照分别报告。缺工具、网络不可达和未执行的入口不算通过。构建通过不代替功能验证。Cleanup 后证据必须仍可读。

## 功能

- [基础命令](core.md) 对应 `version`、帮助和 `keygen`，运行 `offline`、`mac`
- [加密订阅与服务端](subscription.md) 对应 `encode`、`server` 和 HTTP 端点，运行 `server`、`remote`、`mac`
- [配置检查](check.md) 对应 `check`，运行 `offline`、`remote`
- [查看配置](config.md) 对应 `config`，运行 `offline`、`observability`
- [查看日志](logs.md) 对应 `logs`，运行 `offline`、`observability`
- [链路诊断](trace.md) 对应 `trace`，运行 `offline`、`observability`、`remote`
