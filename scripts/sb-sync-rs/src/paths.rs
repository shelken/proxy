//! 路径布局与基础 JSON 读写。

use std::fs;
use std::path::{Path, PathBuf};

pub fn sb_sync_dir() -> PathBuf {
    dirs_home().join(".config").join("sing-box")
}

pub fn store_path() -> PathBuf {
    sb_sync_dir().join("store.json")
}

pub fn local_path() -> PathBuf {
    sb_sync_dir().join("local.json")
}

pub fn state_path() -> PathBuf {
    sb_sync_dir().join("state.json")
}

pub fn template_cache_path() -> PathBuf {
    sb_sync_dir().join("template.json")
}

pub fn output_path() -> PathBuf {
    sb_sync_dir().join("singbox.json")
}

/// HOME 解析：launchd 定时环境 HOME 一定存在；缺失即 fail-fast。
fn dirs_home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .expect("HOME 环境变量未设置")
}

/// 读 JSON 文件；不存在返回 fallback；存在但损坏 fail-fast（与 TS 版语义一致）。
pub fn read_json<T: serde::de::DeserializeOwned>(path: &Path, fallback: Option<T>) -> Result<T, String> {
    if !path.exists() {
        return match fallback {
            Some(v) => Ok(v),
            None => Err(format!("文件不存在: {}", path.display())),
        };
    }
    let text = fs::read_to_string(path)
        .map_err(|e| format!("读取失败 {}: {e}", path.display()))?;
    serde_json::from_str(&text)
        .map_err(|e| format!("配置文件损坏，请修复后重试: {} ({e})", path.display()))
}

/// JSON 原子写：tmp + rename。
pub fn write_json_atomic<T: serde::Serialize>(path: &Path, data: &T) -> Result<(), String> {
    let tmp = path.with_extension(format!("tmp.{}", std::process::id()));
    let text = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
    fs::write(&tmp, text + "\n").map_err(|e| format!("写入失败 {}: {e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| format!("rename 失败 {}: {e}", path.display()))?;
    Ok(())
}
