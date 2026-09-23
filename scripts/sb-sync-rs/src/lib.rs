//! sb-sync 库根 — 客户端加密编码 + 服务端原生合并。
//!
//! 模块边界：crypto（X25519+AES-GCM）、config（YAML 校验与加密）、assemble（节点装配）、
//! server（HTTP + 官方 sing-box merge）、template（内嵌底模或远程下载）。

// 整个 crate 零警告 + 严格规则：本地与 CI 用同一套门禁，避免「本地能过 CI 不过」
#![forbid(unsafe_code)]
#![deny(warnings)]
#![deny(clippy::all, clippy::pedantic)]
// 生产代码不得 panic：错误一律向上返回
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#![deny(clippy::todo, clippy::unimplemented, clippy::dbg_macro)]
// 客户端 CLI 必须打印结果，服务端必须打日志，故不禁止 print_stdout/print_stderr
// pedantic 中与项目风格冲突、且不指向真实缺陷的规则
#![allow(clippy::missing_errors_doc, clippy::missing_panics_doc)]
#![allow(clippy::must_use_candidate, clippy::module_name_repetitions)]
#![allow(clippy::doc_markdown, clippy::cast_possible_truncation)]
#![allow(clippy::cast_precision_loss, clippy::cast_sign_loss)]
// 测试里 expect/unwrap 是断言失败语义，不属于生产 panic 风险
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

pub mod assemble;
pub mod config;
pub mod crypto;
pub mod node;
pub mod paths;
pub mod server;
pub mod template;
