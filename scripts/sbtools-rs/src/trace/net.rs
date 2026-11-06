//! 网段运算：Ipv4Cidr、fakeip 池与 tun `route_exclude_address` 判定。
//!
//! fakeip 段告诉报告「系统解析结果是假 IP」；exclude 段区分「目标不进 TUN 所以
//! 没有路由日志」与「没抓到」。两者都优先读生效配置，退回内嵌底模。

use crate::template;
use serde_json::Value;

use super::effective_config;

/// fakeip 池（从底模 `dns-fakeip` 的 inet4_range 读）。落在这个段的 A 记录是假 IP，
/// 不是真实解析结果，拨号必然失败。
struct Ipv4Cidr {
    net: std::net::Ipv4Addr,
    prefix: u32,
}

impl Ipv4Cidr {
    /// fakeip 段优先读生效配置（legacy JSON/overlay 里声明的段；merge 对数组是追加，
    /// 声明了新段时以内核实际生效的那份为准）；磁盘不可得（SFM）再退回内嵌底模；
    /// 都没有才用 sing-box 默认段。只读底模的旧写法在用户改段后会静默误判假 IP。
    fn resolve() -> Self {
        if let Some(cfg) = effective_config()
            && let Some(spec) = fakeip_range_from(&cfg)
        {
            return spec;
        }
        let fallback = || Self {
            net: std::net::Ipv4Addr::new(198, 18, 0, 0),
            prefix: 15,
        };
        let Ok((template, _)) = template::load_template(None) else {
            return fallback();
        };
        template::fakeip_range_in(&template)
            .and_then(parse_cidr4)
            .unwrap_or_else(fallback)
    }
}

/// 从（合并后的）配置树读 fakeip inet4_range。无 fakeip server 时 None。
fn fakeip_range_from(cfg: &Value) -> Option<Ipv4Cidr> {
    template::fakeip_range_in(cfg).and_then(parse_cidr4)
}

/// 解析 `198.18.0.0/15` 形态的 IPv4 CIDR。只有一个消费点，不值得引 ipnet。
fn parse_cidr4(spec: &str) -> Option<Ipv4Cidr> {
    let (addr, prefix) = spec.split_once('/')?;
    let prefix: u32 = prefix.trim().parse().ok()?;
    if prefix > 32 {
        return None;
    }
    let net: std::net::Ipv4Addr = addr.trim().parse().ok()?;
    let mask = if prefix == 0 {
        0
    } else {
        u32::MAX << (32 - prefix)
    };
    Some(Ipv4Cidr {
        net: std::net::Ipv4Addr::from(u32::from(net) & mask),
        prefix,
    })
}

/// 读一次 fakeip 段（生效配置优先，底模兜底），进程内复用。
static FAKEIP_RANGE: std::sync::LazyLock<Ipv4Cidr> = std::sync::LazyLock::new(Ipv4Cidr::resolve);

fn prefix_mask(prefix: u32) -> u32 {
    if prefix == 0 {
        0
    } else {
        u32::MAX << (32 - prefix)
    }
}

/// tun 入站的 `route_exclude_address`。目标落这些段时流量根本不进 TUN，内核
/// 不会产生路由判定日志——这是「直连」而非「未捕获」，报告必须分得开。
/// 段优先读生效配置（legacy JSON/overlay 声明的段），退回内嵌底模；与 fakeip 段同一纪律。
static EXCLUDE_ADDRESS: std::sync::LazyLock<Vec<Ipv4Cidr>> = std::sync::LazyLock::new(|| {
    if let Some(cfg) = effective_config() {
        let from_cfg = exclude_ranges_in(&cfg);
        if !from_cfg.is_empty() {
            return from_cfg;
        }
    }
    template::load_template(None)
        .ok()
        .map(|(t, _)| exclude_ranges_in(&t))
        .unwrap_or_default()
});

/// 从配置树收集 tun 入站的 `route_exclude_address`。纯函数，单测与 LazyLock 共用，
/// 测试不得走 LazyLock（那会读本机 $HOME，随宿主配置漂移）。
fn exclude_ranges_in(root: &Value) -> Vec<Ipv4Cidr> {
    root["inbounds"]
        .as_array()
        .map(|inbounds| {
            inbounds
                .iter()
                .filter(|ib| ib["type"].as_str() == Some("tun"))
                .flat_map(|ib| {
                    ib["route_exclude_address"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|v| v.as_str())
                })
                .filter_map(parse_cidr4)
                .collect()
        })
        .unwrap_or_default()
}

pub(super) fn is_excluded(ip: &str) -> bool {
    EXCLUDE_ADDRESS.iter().any(|c| in_range(ip, c))
}

pub(super) fn is_fakeip(ip: &str) -> bool {
    in_range(ip, &FAKEIP_RANGE)
}

/// 纯判定。is_fakeip/is_excluded 走 LazyLock 会读本机 $HOME，测试必须用纯函数
/// 配显式来源（底模/合成配置），否则随宿主配置漂移。
fn in_range(ip: &str, r: &Ipv4Cidr) -> bool {
    let Ok(a) = ip.parse::<std::net::Ipv4Addr>() else {
        return false;
    };
    u32::from(a) & prefix_mask(r.prefix) == u32::from(r.net)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// fakeip 段从底模读取，与 `config/sing-box/template.json` 的 inet4_range 绑定；
    /// 底模改了段而 trace 还写死 198.18/15 会静默误判。
    #[test]
    fn fakeip_range_matches_template() {
        let (template, _) = template::load_template(None).expect("底模应可加载");
        let spec = template::fakeip_range_in(&template).expect("底模应有 fakeip inet4_range");
        let parsed = parse_cidr4(spec).expect("inet4_range 应是合法 CIDR");
        assert_eq!(parsed.prefix, 15);
        assert_eq!(parsed.net, std::net::Ipv4Addr::new(198, 18, 0, 0));
        // 走纯函数 + 底模显式来源，不走 is_fakeip（LazyLock 会读本机 $HOME）
        assert!(in_range("198.18.0.13", &parsed));
        assert!(in_range("198.19.255.255", &parsed));
        assert!(!in_range("198.20.0.1", &parsed));
    }

    /// fakeip 段优先读生效配置：overlay 改了段，判断必须跟着配置走。
    #[test]
    fn fakeip_range_prefers_effective_config() {
        let cfg = serde_json::json!({
            "dns": {"servers": [{"type": "fakeip", "inet4_range": "10.111.0.0/16"}]}
        });
        let range = fakeip_range_from(&cfg).expect("应读出配置里的段");
        assert_eq!(range.net, std::net::Ipv4Addr::new(10, 111, 0, 0));
        assert_eq!(range.prefix, 16);
        // 无 fakeip server → None，调用方回落底模
        assert!(fakeip_range_from(&serde_json::json!({})).is_none());
    }

    /// tun 入站的 route_exclude_address 决定「直连所以没有路由日志」；
    /// 底模改了段而 trace 还写死会静默误判。
    #[test]
    fn exclude_address_matches_template() {
        // 走纯函数 + 底模显式来源，不走 is_excluded（LazyLock 会读本机 $HOME）
        let (template, _) = template::load_template(None).expect("底模应可加载");
        let ranges = exclude_ranges_in(&template);
        assert!(
            ranges.iter().any(|r| in_range("192.168.69.46", r)),
            "内网段应命中 exclude"
        );
        assert!(ranges.iter().any(|r| in_range("10.1.2.3", r)));
        assert!(ranges.iter().all(|r| !in_range("8.8.8.8", r)));
        assert!(
            ranges.iter().all(|r| !in_range("198.18.0.13", r)),
            "fakeip 段不在 exclude 内"
        );
    }
}
