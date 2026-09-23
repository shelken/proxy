//! sb-sync 库根 — 客户端加密编码 + 服务端原生合并。
//!
//! 模块边界：crypto（X25519+AES-GCM）、config（YAML 校验与加密）、assemble（节点装配）、
//! server（HTTP + 官方 sing-box merge）、template（内嵌底模）。

pub mod assemble;
pub mod config;
pub mod crypto;
pub mod node;
pub mod paths;
pub mod server;
pub mod template;
