# 删除 TS 装配器，消除与 Rust 的双实现

重构后服务端装配由 Rust `assemble.rs` 承担，而 `scripts/endpoint.ts` 仍是同一语义的第二套实现，被沙箱配置生成与 `trace` 调试共同使用。两者需人工保持同步，已出现过「Rust 修了 TS 漏修」的漂移。删除 TS 实现，沙箱与调试工具改为消费服务端真实产物

## Consequences

- 装配语义只有一处事实来源，漂移风险消失
- 沙箱不再能脱离服务端独立生成配置，运行前需先取得 Linux 二进制
- `local.json` 本地覆盖链路随之废弃。Rust 侧的本机覆盖已由客户端 `overlay` 承担
- `endpoint.test.ts` 覆盖的断言语义需先移植到 Rust 单测或沙箱，不可静默丢弃
