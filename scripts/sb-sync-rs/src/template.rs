//! 底模来源与 HTTP 基础设施。
//! 服务端无状态：仅用编译期内嵌底模；底模更新 = 发新镜像。

use serde_json::Value;
use std::io::Read;

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

/// 内嵌底模（编译期打包，随镜像发布）。
pub fn embedded_template() -> Value {
    serde_json::from_str(include_str!("../../../config/sing-box/template.json"))
        .expect("内嵌底模损坏（编译期产物错误）")
}
