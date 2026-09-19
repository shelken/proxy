//! 内核校验探测链：SING_BOX 环境变量 → PATH 上的 sing-box → SFM 面板在线探测 → 全无则跳过。
//!
//! 语义边界：前两级能对产物文件执行真实校验（内核 CLI 的 check 子命令）；
//! 第三级 SFM 在线探测只提供内核版本信息——libbox 的 CheckConfig 是进程内库函数，
//! 面板 API 无 dry-run 端点，无法远程校验文件。

use std::process::Command;

/// 探测到的校验通道。
pub enum Kernel {
    /// 内核 CLI 可用，返回可执行文件路径。
    Cli(String),
    /// SFM 面板在线（附版本文本），但无法远程校验文件。
    PanelOnline(String),
    /// 无任何通道：跳过校验。
    None,
}

/// 执行探测链。
pub fn detect() -> Kernel {
    if let Ok(path) = std::env::var("SING_BOX") {
        if !path.is_empty() {
            return Kernel::Cli(path);
        }
    }
    if let Ok(output) = Command::new("which").arg("sing-box").output() {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                return Kernel::Cli(path);
            }
        }
    }
    if let Some(version) = probe_sfm_panel() {
        return Kernel::PanelOnline(version);
    }
    Kernel::None
}

/// SFM 面板在线探测：GET 127.0.0.1:9090/version，返回 "sing-box x.y.z" 文本。
fn probe_sfm_panel() -> Option<String> {
    let res = ureq::get("http://127.0.0.1:9090/version")
        .timeout(std::time::Duration::from_secs(2))
        .call()
        .ok()?;
    let mut body = String::new();
    std::io::Read::read_to_string(&mut res.into_reader(), &mut body).ok()?;
    let body: serde_json::Value = serde_json::from_str(&body).ok()?;
    let raw = body["version"].as_str().unwrap_or("?");
    // 面板可能自带 "sing-box " 前缀，避免 "sing-box sing-box 1.14.1" 重复
    Some(if raw.starts_with("sing-box") {
        raw.to_string()
    } else {
        format!("sing-box {raw}")
    })
}

/// 对配置文件执行内核语法校验。返回 Ok(()) 表示通过或已跳过（warn 文本在第二个元素）。
pub fn validate(path: &std::path::Path) -> (Result<(), String>, Option<String>) {
    match detect() {
        Kernel::Cli(bin) => match Command::new(&bin).args(["check", "-c"]).arg(path).output() {
            Ok(out) if out.status.success() => (Ok(()), None),
            Ok(out) => {
                let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
                let msg = if msg.is_empty() {
                    String::from_utf8_lossy(&out.stdout).trim().to_string()
                } else {
                    msg
                };
                (
                    Err(if msg.is_empty() { "sing-box check 未知失败".into() } else { msg }),
                    None,
                )
            }
            Err(e) => (Err(format!("sing-box 执行失败: {e}")), None),
        },
        Kernel::PanelOnline(v) => (
            Ok(()),
            Some(format!("SFM 在线（{v}），跳过文件级校验（面板不支持 dry-run）")),
        ),
        Kernel::None => (Ok(()), Some("未检测到内核 CLI / SFM，跳过产物校验".to_string())),
    }
}
