//! trace: 对指定域名做全链路探测（系统解析 / 内核 DNS 判定 / 路由判定 / 拨号证据 / 首字节耗时）。
//!
//! 报告是「第一行结论 + 一条因果链」：解析 → DNS → 拨号 → 路由 → 连通。
//! 事实收集（`collect_facts`，唯一的 IO 段）与文本渲染（`render`，纯函数）分开，
//! 渲染可以不碰网络地逐字单测。
//!
//! DNS 与路由判定只认内核 debug 日志流与 /connections，不做本地推演：
//! 内核视角即真相。日志关联靠请求号，`dns: match[N]` 行不带域名，
//! 由相邻的 exchange/exchanged 行回填归属。
//!
//! 与 `scripts/trace-route.ts`（沙箱侧）的分工：本模块跑在真机上，验证**当前部署**
//! 在真实网络环境下的表现；沙箱侧在 Lima VM 内用于**离线复现**配置裁决。两者被测
//! 对象不同，各自维护日志解析；改任一侧只需与内核实际日志格式对齐，不必互相同步。

use serde_json::Value;

mod log;
mod net;
mod probe;
mod report;

pub use report::trace;

/// 读取生效配置（统一 load_effective：客户端 YAML 的原生配置在 overlay 里）。
/// SFM 等磁盘不可达场景返回 None，调用方明示跳过，不算失败。
fn effective_config() -> Option<Value> {
    let eff = crate::config::load_effective(None).ok()?;
    Some(eff.overlay.unwrap_or(eff.root))
}
