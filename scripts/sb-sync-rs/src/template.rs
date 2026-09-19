//! 底模三级来源（远程 → 缓存 → 内嵌）与 HTTP 基础设施。

use crate::paths;
use serde_json::Value;
use std::io::Read;

/// 远程底模唯一信任源：仓库 main 分支（不接受任意 URL）。
pub const TEMPLATE_REMOTE_URL: &str =
    "https://raw.githubusercontent.com/shelken/proxy/main/config/sing-box/template.json";

/// HTTP GET（ureq，走系统 DNS 栈）。非 2xx 或网络错误返回 Err 文本。
pub fn http_get(url: &str) -> Result<String, String> {
    let res = ureq::get(url)
        .timeout(std::time::Duration::from_secs(15))
        .call()
        .map_err(|e| format!("HTTP 请求失败 {url}: {e}"))?;
    let mut body = String::new();
    res.into_reader()
        .take(10 * 1024 * 1024) // 10MB 上限，防异常响应撑爆内存
        .read_to_string(&mut body)
        .map_err(|e| format!("HTTP 响应读取失败: {e}"))?;
    Ok(body)
}

/// 拉取远程底模原文；失败返回 None（调用方决定回退层级）。
/// 坏内容（JSON 解析失败）视同失败。
pub fn fetch_remote_template() -> Option<String> {
    match http_get(TEMPLATE_REMOTE_URL) {
        Ok(text) => {
            if serde_json::from_str::<Value>(&text).is_ok() {
                Some(text)
            } else {
                None
            }
        }
        Err(_) => None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum TemplateSource {
    Embedded,
    Remote,
    Cache,
}

impl TemplateSource {
    pub fn as_str(self) -> &'static str {
        match self {
            TemplateSource::Embedded => "embedded",
            TemplateSource::Remote => "remote",
            TemplateSource::Cache => "cache",
        }
    }
}

/// 内嵌底模（编译期打包，出厂兜底）。
pub fn embedded_template() -> Value {
    serde_json::from_str(include_str!("../../../config/sing-box/template.json"))
        .expect("内嵌底模损坏（编译期产物错误）")
}

/// 底模解析顺序：
/// 1. remote 强制刷新（template update / sync 自动更新）
/// 2. 设备缓存（上次成功拉取的远程版）
/// 3. 二进制内嵌版（出厂兜底，永远可用）
pub fn load_template_for_sync(force_refresh: bool) -> Result<(Value, TemplateSource), String> {
    let cache_path = paths::template_cache_path();
    if force_refresh || !cache_path.exists() {
        if let Some(remote) = fetch_remote_template() {
            let parsed: Value = serde_json::from_str(&remote).map_err(|e| e.to_string())?;
            paths::write_json_atomic(&cache_path, &parsed)?;
            return Ok((parsed, TemplateSource::Remote));
        }
        if cache_path.exists() {
            eprintln!("[sb-sync] 远程底模拉取失败，使用本地缓存");
            return Ok((
                paths::read_json(&cache_path, None)?,
                TemplateSource::Cache,
            ));
        }
        eprintln!("[sb-sync] 远程底模拉取失败且无缓存，使用内嵌底模");
        return Ok((embedded_template(), TemplateSource::Embedded));
    }
    Ok((
        paths::read_json(&cache_path, None)?,
        TemplateSource::Cache,
    ))
}
