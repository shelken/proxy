//! 底模来源与 HTTP 基础设施。
//!
//! 默认用编译期内嵌底模；客户端配置了 `template_url` 时改为下载该 URL 的底模。
//! 下载内容要进入 `sing-box merge`，因此必须比订阅更严格地校验。

use serde_json::Value;
use std::io::Read;
use std::time::Duration;

/// 底模响应体上限。生产底模约 16KB，1MB 足够且能挡住超大响应。
const MAX_TEMPLATE_BODY: usize = 1024 * 1024;
const TEMPLATE_TIMEOUT_SECS: u64 = 10;

/// HTTP GET（ureq，走系统 DNS 栈）。非 2xx 或网络错误返回 Err 文本。
pub fn http_get(url: &str) -> Result<String, String> {
    let res = ureq::get(url)
        .timeout(Duration::from_secs(15))
        .call()
        .map_err(|e| format!("HTTP 请求失败 {url}: {e}"))?;
    let mut body = String::new();
    res.into_reader()
        .take(10 * 1024 * 1024) // 10MB 上限，防异常响应撑爆内存
        .read_to_string(&mut body)
        .map_err(|e| format!("HTTP 响应读取失败: {e}"))?;
    Ok(body)
}

/// 底模实际来源，用于日志。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TemplateSource {
    /// 客户端配置的 `template_url` 下载所得
    Dynamic,
    /// 编译期内嵌底模
    Embedded,
}

impl TemplateSource {
    pub fn as_str(self) -> &'static str {
        match self {
            TemplateSource::Dynamic => "dynamic",
            TemplateSource::Embedded => "embedded",
        }
    }
}

/// 内嵌底模（编译期打包，出厂兜底）。
/// 解析失败只可能是编译期产物损坏，仍返回 Err 由调用方上报，不用 expect 直接 panic。
pub fn embedded_template() -> Result<Value, String> {
    serde_json::from_str(include_str!("../../../config/sing-box/template.json"))
        .map_err(|e| format!("内嵌底模损坏（编译期产物错误）: {e}"))
}

/// 按需加载底模：给了 URL 就下载（失败即请求失败，不静默回退），否则用内嵌底模。
///
/// 不回退是有意的：用户显式指定了底模，静默换成另一份会让节点与策略组对不上，
/// 那种「看起来成功」比直接报错更难排查。
pub fn load_template(template_url: Option<&str>) -> Result<(Value, TemplateSource), String> {
    match template_url {
        None => Ok((embedded_template()?, TemplateSource::Embedded)),
        Some(url) => Ok((fetch_template(url)?, TemplateSource::Dynamic)),
    }
}

/// 下载并严格校验远端底模。
fn fetch_template(raw_url: &str) -> Result<Value, String> {
    let url = validate_template_url(raw_url)?;
    let res = ureq::get(url.as_str())
        .timeout(Duration::from_secs(TEMPLATE_TIMEOUT_SECS))
        .call()
        .map_err(|e| format!("底模拉取失败 {url}: {e}"))?;
    let mut body = String::new();
    res.into_reader()
        .take(MAX_TEMPLATE_BODY as u64 + 1)
        .read_to_string(&mut body)
        .map_err(|e| format!("底模读取失败: {e}"))?;
    if body.len() > MAX_TEMPLATE_BODY {
        return Err(format!("底模响应超过 {}KB 上限", MAX_TEMPLATE_BODY / 1024));
    }
    let value: Value =
        serde_json::from_str(&body).map_err(|e| format!("底模不是合法 JSON: {e}"))?;
    if !value.is_object() {
        return Err("底模顶层必须是 JSON Object".into());
    }
    // 底模同样会进 sing-box merge，路径引用字段会内联服务器文件，必须与 overlay 同级拦截
    crate::config::reject_path_fields(&value).map_err(|e| format!("底模校验失败: {e}"))?;
    Ok(value)
}

/// 底模 URL 校验：仅 https，拒绝指向本机/内网的 IP 字面量。
///
/// 载荷用服务端公钥加密，而公钥经 `/pubkey` 公开，因此任何能访问 `/sub` 的人都能
/// 指定这个 URL。不设限就等于把服务端当成 SSRF 跳板（例如打云元数据端点）。
/// 客户端 `encode` 也调用它，让非法 URL 在本地就报错，不必等服务端往返。
pub fn validate_template_url(raw_url: &str) -> Result<url::Url, String> {
    let parsed =
        url::Url::parse(raw_url.trim()).map_err(|e| format!("template_url 解析失败: {e}"))?;
    if parsed.scheme() != "https" {
        return Err(format!(
            "template_url 仅支持 https，当前: {}",
            parsed.scheme()
        ));
    }
    match parsed.host() {
        Some(url::Host::Ipv4(ip)) if is_blocked_v4(ip) => {
            Err(format!("template_url 不得指向内网地址: {ip}"))
        }
        Some(url::Host::Ipv6(ip)) if is_blocked_v6(ip) => {
            Err(format!("template_url 不得指向内网地址: {ip}"))
        }
        Some(_) => Ok(parsed),
        None => Err("template_url 缺少主机名".into()),
    }
}

fn is_blocked_v4(ip: std::net::Ipv4Addr) -> bool {
    ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || ip.is_documentation()
}

fn is_blocked_v6(ip: std::net::Ipv6Addr) -> bool {
    ip.is_loopback() || ip.is_unspecified() || ip.is_unique_local()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_template_has_router_skeleton() {
        let tpl = embedded_template().expect("内嵌底模");
        assert!(tpl["outbounds"].is_array());
        assert!(tpl["route"].is_object());
    }

    #[test]
    fn no_template_url_uses_embedded() {
        let (_, src) = load_template(None).unwrap();
        assert_eq!(src, TemplateSource::Embedded);
    }

    /// 显式指定的底模拉不到就必须失败，不能静默换成内嵌底模：
    /// 换掉之后节点与策略组会对不上，比直接报错更难排查。
    #[test]
    fn configured_template_url_failure_is_not_silently_fallback() {
        let err = load_template(Some("https://192.0.2.1/template.json")).unwrap_err();
        assert!(err.contains("内网") || err.contains("失败"), "实际: {err}");
    }

    #[test]
    fn template_url_requires_https() {
        for url in [
            "http://example.com/t.json",
            "file:///etc/passwd",
            "ftp://example.com/t.json",
        ] {
            let err = validate_template_url(url).unwrap_err();
            assert!(err.contains("https"), "{url} 应被拒，实际: {err}");
        }
    }

    /// SSRF：载荷公钥公开，任何能访问 /sub 的人都能塞 URL，必须挡住内网字面量
    #[test]
    fn template_url_rejects_internal_addresses() {
        for url in [
            "https://127.0.0.1/t.json",
            "https://10.0.0.5/t.json",
            "https://192.168.1.1/t.json",
            "https://169.254.169.254/latest/meta-data/", // 云元数据端点
            "https://[::1]/t.json",
            "https://[fd00::1]/t.json",
            "https://0.0.0.0/t.json",
        ] {
            let err = validate_template_url(url).unwrap_err();
            assert!(err.contains("内网"), "{url} 应被拒，实际: {err}");
        }
    }

    #[test]
    fn template_url_accepts_public_dns_name() {
        assert!(validate_template_url("https://example.com/t.json").is_ok());
        assert!(validate_template_url("  https://raw.githubusercontent.com/a/b.json  ").is_ok());
        assert!(validate_template_url("https://93.184.216.34/t.json").is_ok());
    }
}
