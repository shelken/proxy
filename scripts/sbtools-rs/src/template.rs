//! 底模来源与 HTTP 基础设施。
//!
//! 默认用编译期内嵌底模；客户端配置了 `template_url` 时改为下载该 URL 的底模。
//! 下载内容要进入 `sing-box merge`，因此必须比订阅更严格地校验。

use serde_json::Value;
use std::collections::HashMap;
use std::io::Read;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

/// 底模响应体上限。生产底模约 16KB，1MB 足够且能挡住超大响应。
const MAX_TEMPLATE_BODY: usize = 1024 * 1024;
const TEMPLATE_TIMEOUT_SECS: u64 = 10;
/// 远程底模的新鲜期：期内不重复下载。raw.githubusercontent.com 自身的 CDN 缓存也是 5 分钟，
/// 更短的新鲜期换不来更新的内容。
const TEMPLATE_FRESH: Duration = Duration::from_secs(300);
/// 缓存条目上限：`template_url` 由请求方指定，不设限等于让请求方撑大服务端内存。
const MAX_CACHED_TEMPLATES: usize = 8;

/// 网络层失败的错误前缀。`server::sub_failure` 按它把失败归为 502/504，
/// 与产生错误的位置共用同一份常量，改文案时分类不会悄悄失效。
pub const MSG_FETCH_FAILED: &str = "底模拉取失败";
pub const MSG_READ_FAILED: &str = "底模读取失败";

/// HTTP GET（ureq，走系统 DNS 栈）。非 2xx 或网络错误返回 Err 文本。
pub fn http_get(url: &str) -> Result<String, String> {
    let res = crate::clashapi::agent_with_timeout(Duration::from_secs(15))
        .get(url)
        .call()
        .map_err(|e| format!("HTTP 请求失败 {url}: {e}"))?;
    let mut body = String::new();
    std::io::Read::take(res.into_body().into_reader(), 10 * 1024 * 1024 + 1)
        .read_to_string(&mut body)
        .map_err(|e| format!("HTTP 响应读取失败: {e}"))?;
    if body.len() > 10 * 1024 * 1024 {
        return Err(format!("HTTP 响应超过 10MB 上限: {url}"));
    }
    Ok(body)
}

/// 底模实际来源，用于日志。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TemplateSource {
    /// 客户端配置的 `template_url` 刚下载所得
    Dynamic,
    /// 同一 `template_url` 新鲜期内的缓存，未下载
    Cache,
    /// 下载失败，使用同一 `template_url` 上次成功的底模
    Stale,
    /// 编译期内嵌底模
    Embedded,
}

impl TemplateSource {
    pub fn as_str(self) -> &'static str {
        match self {
            TemplateSource::Dynamic => "dynamic",
            TemplateSource::Cache => "cache",
            TemplateSource::Stale => "stale",
            TemplateSource::Embedded => "embedded",
        }
    }
}

/// 从底模/配置树读 fakeip server 的 `inet4_range`（无 fakeip server 时 None）。
pub fn fakeip_range_in(template: &Value) -> Option<&str> {
    template["dns"]["servers"]
        .as_array()
        .and_then(|servers| {
            servers
                .iter()
                .find(|s| s["type"].as_str() == Some("fakeip"))
        })
        .and_then(|s| s["inet4_range"].as_str())
}

/// 内嵌底模（编译期打包，出厂兜底）。
/// 解析失败只可能是编译期产物损坏，仍返回 Err 由调用方上报，不用 expect 直接 panic。
pub fn embedded_template() -> Result<Value, String> {
    serde_json::from_str(include_str!("../../../config/sing-box/template.json"))
        .map_err(|e| format!("内嵌底模损坏（编译期产物错误）: {e}"))
}

struct CachedTemplate {
    value: Value,
    fetched_at: Instant,
}

/// 远程底模缓存，按 URL 区分。
#[derive(Default)]
pub struct TemplateCache {
    entries: Mutex<HashMap<String, CachedTemplate>>,
}

impl TemplateCache {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, CachedTemplate>> {
        // 持锁期间没有会 panic 的代码；即便被毒化，缓存内容仍是完整的 Value
        self.entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.lock().len()
    }

    /// 新鲜期内直接返回缓存；否则下载。下载失败时用同一 URL 上次成功的底模（`Stale`），
    /// 从未成功过则报错：不换成内嵌底模或别的 URL 的缓存，那样节点与策略组会对不上。
    ///
    /// 下载期间不持锁，一个慢上游不会堵住其他请求。
    pub fn get_or_fetch(
        &self,
        url: &str,
        now: Instant,
        fetch: impl FnOnce(&str) -> Result<Value, String>,
    ) -> Result<(Value, TemplateSource), String> {
        let stale = {
            let entries = self.lock();
            match entries.get(url) {
                Some(c) if now.saturating_duration_since(c.fetched_at) < TEMPLATE_FRESH => {
                    return Ok((c.value.clone(), TemplateSource::Cache));
                }
                other => other.map(|c| c.value.clone()),
            }
        };
        match fetch(url) {
            Ok(value) => {
                let mut entries = self.lock();
                if !entries.contains_key(url)
                    && entries.len() >= MAX_CACHED_TEMPLATES
                    && let Some(oldest) = entries
                        .iter()
                        .min_by_key(|(_, c)| c.fetched_at)
                        .map(|(k, _)| k.clone())
                {
                    entries.remove(&oldest);
                }
                entries.insert(
                    url.to_string(),
                    CachedTemplate {
                        value: value.clone(),
                        fetched_at: now,
                    },
                );
                Ok((value, TemplateSource::Dynamic))
            }
            Err(e) => match stale {
                Some(value) => {
                    crate::logging::warn(&format!(
                        "底模下载失败，改用上次成功的同一 URL 底模: {e}"
                    ));
                    Ok((value, TemplateSource::Stale))
                }
                None => Err(e),
            },
        }
    }
}

static TEMPLATE_CACHE: LazyLock<TemplateCache> = LazyLock::new(TemplateCache::default);

/// 按需加载底模：给了 URL 就用远程底模（带缓存，见 [`TemplateCache`]），否则用内嵌底模。
///
/// 不回退到内嵌底模是有意的：用户显式指定了底模，静默换成另一份会让节点与策略组对不上，
/// 那种「看起来成功」比直接报错更难排查。
pub fn load_template(template_url: Option<&str>) -> Result<(Value, TemplateSource), String> {
    match template_url {
        None => Ok((embedded_template()?, TemplateSource::Embedded)),
        Some(raw) => {
            let url = validate_template_url(raw)?;
            TEMPLATE_CACHE.get_or_fetch(url.as_str(), Instant::now(), fetch_template)
        }
    }
}

/// 下载并严格校验远端底模（URL 已通过 `validate_template_url`）。
fn fetch_template(url: &str) -> Result<Value, String> {
    let res = crate::clashapi::agent_with_timeout(Duration::from_secs(TEMPLATE_TIMEOUT_SECS))
        .get(url)
        .call()
        .map_err(|e| format!("{MSG_FETCH_FAILED} {url}: {e}"))?;
    let mut body = String::new();
    std::io::Read::take(res.into_body().into_reader(), MAX_TEMPLATE_BODY as u64 + 1)
        .read_to_string(&mut body)
        .map_err(|e| format!("{MSG_READ_FAILED}: {e}"))?;
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

    fn tpl(tag: &str) -> Value {
        serde_json::json!({ "marker": tag })
    }

    /// 新鲜期内不再下载：上游变慢时，只有每个新鲜期的第一次请求受影响。
    #[test]
    fn fresh_cache_skips_download() {
        let cache = TemplateCache::default();
        let t0 = Instant::now();
        let calls = std::cell::Cell::new(0);
        let fetch = |_: &str| {
            calls.set(calls.get() + 1);
            Ok(tpl("v1"))
        };
        let (_, first) = cache
            .get_or_fetch("https://a.example/t.json", t0, fetch)
            .unwrap();
        let (v, second) = cache
            .get_or_fetch(
                "https://a.example/t.json",
                t0 + Duration::from_secs(60),
                fetch,
            )
            .unwrap();
        assert_eq!(
            (first, second),
            (TemplateSource::Dynamic, TemplateSource::Cache)
        );
        assert_eq!(v["marker"], "v1");
        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn expired_cache_downloads_again() {
        let cache = TemplateCache::default();
        let t0 = Instant::now();
        cache
            .get_or_fetch("https://a.example/t.json", t0, |_| Ok(tpl("v1")))
            .unwrap();
        let (v, src) = cache
            .get_or_fetch("https://a.example/t.json", t0 + TEMPLATE_FRESH, |_| {
                Ok(tpl("v2"))
            })
            .unwrap();
        assert_eq!(src, TemplateSource::Dynamic);
        assert_eq!(v["marker"], "v2");
    }

    /// 过期后重新下载失败：用同一 URL 上次成功的底模，来源标 stale，调用方据此告警。
    #[test]
    fn failed_refresh_falls_back_to_stale_copy_of_same_url() {
        let cache = TemplateCache::default();
        let t0 = Instant::now();
        cache
            .get_or_fetch("https://a.example/t.json", t0, |_| Ok(tpl("v1")))
            .unwrap();
        let (v, src) = cache
            .get_or_fetch("https://a.example/t.json", t0 + TEMPLATE_FRESH, |_| {
                Err("底模拉取失败: timeout: global".into())
            })
            .unwrap();
        assert_eq!(src, TemplateSource::Stale);
        assert_eq!(v["marker"], "v1");
    }

    /// 从未成功过就必须报错：不能换成别的底模（内嵌底模或别的 URL 的缓存）。
    #[test]
    fn failure_without_cached_copy_is_an_error() {
        let cache = TemplateCache::default();
        let t0 = Instant::now();
        cache
            .get_or_fetch("https://a.example/t.json", t0, |_| Ok(tpl("a")))
            .unwrap();
        let err = cache
            .get_or_fetch("https://b.example/t.json", t0, |_| {
                Err("底模拉取失败: x".into())
            })
            .unwrap_err();
        assert!(err.contains("底模拉取失败"), "实际: {err}");
    }

    /// template_url 由请求方指定，缓存条目必须有上限。
    #[test]
    fn cache_entries_are_bounded() {
        let cache = TemplateCache::default();
        let t0 = Instant::now();
        for i in 0..MAX_CACHED_TEMPLATES + 5 {
            cache
                .get_or_fetch(&format!("https://h{i}.example/t.json"), t0, |_| {
                    Ok(tpl("x"))
                })
                .unwrap();
        }
        assert_eq!(cache.len(), MAX_CACHED_TEMPLATES);
    }
}
