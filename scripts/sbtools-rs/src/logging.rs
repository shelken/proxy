//! 日志：每行 `<UTC 时间> <级别> <正文>`，写 stderr。
//!
//! 正文一律经 [`scrub`]：错误文本可能夹带订阅地址或节点 URI，仓库与日志都不能出现它们。

use regex::Regex;
use std::sync::LazyLock;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    Info,
    Warn,
    Error,
}

impl Level {
    fn as_str(self) -> &'static str {
        match self {
            Level::Info => "INFO",
            Level::Warn => "WARN",
            Level::Error => "ERROR",
        }
    }
}

const HIDDEN_LINK: &str = "[链接已隐藏]";

/// 任何 `scheme://…`：订阅地址的 token 在 query 里，节点凭据在 userinfo 或 base64 里，
/// 不判断形态，整段替换。
static LINK: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r#"[A-Za-z][A-Za-z0-9+.\-]*://[^\s'"<>）)]*"#).ok());

pub fn scrub(text: &str) -> String {
    match LINK.as_ref() {
        Some(re) => re.replace_all(text, HIDDEN_LINK).into_owned(),
        None => text.to_string(),
    }
}

/// 自 1970-01-01 起的天数 → (年, 月, 日)。Howard Hinnant 的 civil_from_days。
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(month <= 2), month, day)
}

/// RFC3339，UTC，毫秒精度。
pub fn timestamp(now: SystemTime) -> String {
    let millis = now
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_millis()).ok())
        .unwrap_or(0);
    let secs = millis.div_euclid(1000);
    let (y, mo, d) = civil_from_days(secs.div_euclid(86_400));
    let rem = secs.rem_euclid(86_400);
    format!(
        "{y:04}-{mo:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60,
        millis.rem_euclid(1000)
    )
}

pub fn format_line(now: SystemTime, level: Level, msg: &str) -> String {
    format!("{} {} {}", timestamp(now), level.as_str(), scrub(msg))
}

pub fn log(level: Level, msg: &str) {
    eprintln!("{}", format_line(SystemTime::now(), level, msg));
}

pub fn info(msg: &str) {
    log(Level::Info, msg);
}

pub fn warn(msg: &str) {
    log(Level::Warn, msg);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn at(secs: u64, millis: u32) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(secs) + Duration::from_millis(u64::from(millis))
    }

    #[test]
    fn timestamp_is_rfc3339_utc_with_millis() {
        assert_eq!(timestamp(at(0, 0)), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            timestamp(at(1_794_132_672, 345)),
            "2026-11-08T10:11:12.345Z"
        );
        // 闰日
        assert_eq!(timestamp(at(1_709_251_199, 7)), "2024-02-29T23:59:59.007Z");
    }

    #[test]
    fn line_has_time_level_and_message() {
        let line = format_line(at(1_794_132_672, 0), Level::Warn, "GET /sub -> 400");
        assert_eq!(line, "2026-11-08T10:11:12.000Z WARN GET /sub -> 400");
    }

    /// 订阅地址与节点 URI 夹在错误文本里时，日志不得带出 token 与凭据。
    #[test]
    fn scrub_hides_subscription_urls_and_node_uris() {
        let msg = "订阅拉取失败 https://airport.example/api/v1/client/subscribe?token=SECRET-TOKEN: timeout; \
                   节点 hy2://user:SECRET-PASS@192.0.2.1:443?sni=a#n 无效 (ss://SECRET-B64@h:1)";
        let out = scrub(msg);
        for leak in [
            "SECRET-TOKEN",
            "SECRET-PASS",
            "SECRET-B64",
            "airport.example",
        ] {
            assert!(!out.contains(leak), "泄漏 {leak}: {out}");
        }
        assert!(out.contains("timeout"), "原因必须保留: {out}");
        assert!(out.contains("无效"), "原因必须保留: {out}");
    }
}
