//! sb-sync — 设备侧 sing-box 配置同步 CLI（任意 arm Mac 单二进制）。
//!
//! 职责：拉取通用底模 → 拉订阅/节点 → 本机装配 → 融合设备 local 覆盖 → 原子产出。
//! 不依赖仓库工作区：底模内嵌 + 远程固定源，配置与凭据全部落在 ~/.config/sing-box/。

pub mod assemble;
pub mod detect;
pub mod doctor;
pub mod node;
pub mod paths;
pub mod profile;
pub mod store;
pub mod template;

#[cfg(test)]
mod lib_tests;
