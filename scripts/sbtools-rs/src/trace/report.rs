//! 报告：事实结构 + 渲染（纯函数）+ 流程。
//!
//! `collect_facts` 是唯一的 IO 段；`render` 只把事实排成「第一行结论 + 因果链」，
//! 逐字单测不碰网络；`trace` 串起两者并给出退出码。

use super::log::{capture_decisions, route_target};
use super::net::{is_excluded, is_fakeip};
use super::probe::{ConnMatch, http_first_byte, live_attribution, system_resolve};

/// 拨号解析证据：成功不展示，只上报失败与「已发起未见结果」。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
enum DialFact {
    #[default]
    None,
    Failed(String),
    Initiated,
}

/// 一次探测收集到的全部事实。渲染（`render`）只看这些字段，不碰网络。
#[derive(Debug, Clone, Default)]
struct Facts {
    domain: String,
    /// 系统解析结果；None 表示解析失败/超时
    resolved_ip: Option<String>,
    /// 系统解析是否落在 fakeip 段（采集时判定，渲染不读 $HOME）
    resolved_fakeip: bool,
    /// Some(controller) 表示控制面不可达，内核相关段全部跳过
    kernel_unreachable: Option<String>,
    dns_match: Option<String>,
    router_match: Option<String>,
    conn: Option<ConnMatch>,
    dial: DialFact,
    /// 目标 IP 落在 tun 的 route_exclude_address 内（不经路由判定）
    target_excluded: bool,
    /// HTTPS 首字节：(成功, 毫秒)
    https: (bool, u128),
}

/// 收集事实（唯一的 IO 段）：系统解析、内核日志流、/connections 探针、HTTPS 首字节。
fn collect_facts(domain: &str, controller: &str) -> Facts {
    let mut facts = Facts {
        domain: domain.to_string(),
        ..Facts::default()
    };

    if let Some(ip) = system_resolve(domain) {
        facts.resolved_fakeip = is_fakeip(&ip);
        facts.resolved_ip = Some(ip);
    }

    if crate::clashapi::reachable(controller) {
        let decisions = capture_decisions(controller, domain);
        facts.router_match = decisions.router_match;
        facts.dial = match (&decisions.dial_failure, &decisions.dial_lookup) {
            (Some(raw), _) => DialFact::Failed(raw.clone()),
            (None, Some(_)) => DialFact::Initiated,
            (None, None) => DialFact::None,
        };
        facts.dns_match = decisions.dns_match;
        facts.target_excluded = facts.resolved_ip.as_deref().is_some_and(is_excluded);
        facts.conn = live_attribution(domain, controller);
    } else {
        facts.kernel_unreachable = Some(controller.to_string());
    }

    facts.https = http_first_byte(&format!("https://{domain}/"));
    facts
}

/// 从 `dns: match[N] <条件> => route(<server>)` 或 `=> predefined(...)` 解析
/// `(条件串, server 展示串)`。只认内核 debug 日志。
fn parse_dns_match(raw: &str) -> (String, String) {
    let after = raw.split("match[").nth(1).unwrap_or(raw);
    let cond = after
        .split_once(']')
        .map_or("", |(_, rest)| rest.split(" => ").next().unwrap_or(rest))
        .trim()
        .to_string();
    let server = if let Some(inner) = raw.split("=> predefined(").nth(1) {
        let ip = inner
            .split("IN A ")
            .nth(1)
            .map(|s| s.trim_matches(|c: char| !(c.is_ascii_digit() || c == '.')))
            .filter(|s| !s.is_empty());
        ip.map_or_else(|| "predefined".to_string(), |ip| format!("predefined {ip}"))
    } else if let Some(s) = raw.split("=> route(").nth(1) {
        s.split(')').next().unwrap_or(s).to_string()
    } else {
        raw.split("=> ").nth(1).unwrap_or("route").to_string()
    };
    (cond, server)
}

/// 规则串里 ` => ` 之前的条件部分，去内核日志的 `router: match[N] ` 前缀。
fn rule_condition(raw: &str) -> String {
    let head = raw.split(" => ").next().unwrap_or(raw);
    head.split("match[")
        .nth(1)
        .and_then(|s| s.split_once(']').map(|(_, rest)| rest))
        .unwrap_or(head)
        .trim()
        .to_string()
}

/// 拨号失败行里的错误码（`lookup failed for <domain>: (exchange4: NXDOMAIN | ...)`）。
fn dial_failure_code(raw: &str) -> String {
    raw.split("exchange4: ")
        .nth(1)
        .and_then(|s| {
            s.split(|c: char| c.is_whitespace() || c == '|' || c == ')')
                .next()
        })
        .filter(|s| !s.is_empty())
        .unwrap_or("lookup failed")
        .to_string()
}

/// 路由行与其中的出站。来源优先级：存续连接 > 内核路由日志 > route_exclude_address
/// 说明 > 未捕获。
fn route_row(f: &Facts) -> (String, Option<String>) {
    if let Some(m) = &f.conn
        && let Some(outbound) = m.chains.first()
    {
        return (
            format!(
                "路由   {} → {}   链路 {}",
                rule_condition(&m.rule),
                outbound,
                m.chains.join(" → ")
            ),
            Some(outbound.clone()),
        );
    }
    if let Some(raw) = &f.router_match
        && let Some(target) = route_target(raw)
    {
        return (
            format!("路由   {} → {target}", rule_condition(raw)),
            Some(target.to_string()),
        );
    }
    if f.target_excluded {
        return (
            "路由   未经路由判定（目标在 route_exclude_address 内，直连）".to_string(),
            None,
        );
    }
    (
        "路由   未捕获   没有存续连接，也没抓到日志".to_string(),
        None,
    )
}

/// 把事实渲染成报告文本与失败段数。纯函数：不碰网络、不读磁盘。
fn render(f: &Facts) -> (String, u8) {
    let (route_line, route_outbound) = if f.kernel_unreachable.is_some() {
        (String::new(), None)
    } else {
        route_row(f)
    };

    let mut failures = 0u8;
    let mut lines: Vec<String> = Vec::new();

    match &f.resolved_ip {
        Some(ip) if f.resolved_fakeip => lines.push(format!("解析   {ip}   fakeip，由内核接管")),
        Some(ip) => lines.push(format!("解析   {ip}   真实 IP")),
        None => {
            lines.push("解析   ✗ 解析失败/超时".to_string());
            failures += 1;
        }
    }

    if f.kernel_unreachable.is_some() {
        failures += 1;
        lines.push("内核   ✗ 不可达，已跳过 DNS / 路由 / 链路".to_string());
    } else {
        lines.push(match &f.dns_match {
            Some(raw) => {
                let (cond, server) = parse_dns_match(raw);
                format!("DNS    {server}   ← {cond}")
            }
            None => "DNS    未捕获   命中缓存，或日志级别不是 debug".to_string(),
        });
        match &f.dial {
            DialFact::Failed(raw) => {
                failures += 1;
                lines.push(format!(
                    "拨号   ✗ lookup failed: {}",
                    dial_failure_code(raw)
                ));
                lines.push(
                    "       拨号解析不经 dns.rules，只认 route.default_domain_resolver".to_string(),
                );
            }
            DialFact::Initiated => lines.push("拨号   · 已发起，未观察到结果".to_string()),
            DialFact::None => {}
        }
        lines.push(route_line);
    }

    let (ok, ms) = f.https;
    if ok {
        if f.kernel_unreachable.is_some() {
            lines.push(format!(
                "连通   HTTPS 首字节 {ms}ms（内核不可达，路径未确认）"
            ));
        } else {
            lines.push(format!("连通   HTTPS 首字节 {ms}ms"));
            if ms > 3000 {
                lines.push("  ⚠ 超过 3s — 结合上方 DNS 与路由定位延迟根因".to_string());
            }
        }
    } else {
        failures += 1;
        let kind = if ms < 1000 {
            format!("立即失败 {ms}ms（拨号被拒，不是超时）")
        } else {
            format!("超时 {ms}ms")
        };
        lines.push(format!("连通   ✗ {kind}"));
    }

    let conclusion = if f.resolved_ip.is_none() {
        "系统解析失败".to_string()
    } else if let Some(controller) = &f.kernel_unreachable {
        format!("内核不可达（{controller}）")
    } else if matches!(f.dial, DialFact::Failed(_)) {
        "拨号解析失败".to_string()
    } else if !ok {
        let kind = if ms < 1000 { "立即失败" } else { "超时" };
        let hint = if f.resolved_fakeip {
            "（系统解析为 fakeip）"
        } else {
            ""
        };
        format!("HTTPS 失败 {kind} {ms}ms{hint}")
    } else {
        match route_outbound.as_deref() {
            Some("direct") => format!("直连，HTTPS {ms}ms"),
            Some(outbound) => format!("经 {outbound} 出站，HTTPS {ms}ms"),
            None => "通，但路由判定未捕获".to_string(),
        }
    };

    let mark = if failures == 0 { "✓" } else { "✗" };
    let mut text = format!("{}  {mark} {conclusion}\n\n", f.domain);
    for line in &lines {
        text.push_str(line);
        text.push('\n');
    }
    (text, failures)
}

/// 执行一次全链路探测并打印报告；返回是否全部通过（任一 ✗ 段即 false）。
pub fn trace(domain: &str, controller: &str) -> bool {
    let facts = collect_facts(domain, controller);
    let (text, failures) = render(&facts);
    print!("{text}");
    failures == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    /// 五个验收场景的渲染逐字比对。事实全部合成，渲染不碰网络。
    fn assert_render(facts: &Facts, expected: &str) {
        let (text, _) = render(facts);
        assert_eq!(text, expected);
    }

    #[test]
    fn render_scenario_a_proxy() {
        assert_render(
            &Facts {
                domain: "app.example.test".into(),
                resolved_ip: Some("198.18.0.13".into()),
                resolved_fakeip: true,
                dns_match: Some("dns: match[2] query_type=[A AAAA] => route(dns-fakeip)".into()),
                conn: Some(ConnMatch {
                    rule: "rule_set=MyProxy => route(proxy)".into(),
                    chains: vec!["proxy".into(), "selfhost".into(), "vps-hy2".into()],
                }),
                https: (true, 230),
                ..Facts::default()
            },
            "app.example.test  ✓ 经 proxy 出站，HTTPS 230ms\n\n\
解析   198.18.0.13   fakeip，由内核接管\n\
DNS    dns-fakeip   ← query_type=[A AAAA]\n\
路由   rule_set=MyProxy → proxy   链路 proxy → selfhost → vps-hy2\n\
连通   HTTPS 首字节 230ms\n",
        );
    }

    #[test]
    fn render_scenario_b_direct_cn() {
        assert_render(
            &Facts {
                domain: "cn.example.test".into(),
                resolved_ip: Some("203.0.113.8".into()),
                dns_match: Some(
                    "dns: match[1] rule_set=ChinaMax-dns => route(dns-direct-cn)".into(),
                ),
                conn: Some(ConnMatch {
                    rule: "rule_set=ChinaMax => route(direct)".into(),
                    chains: vec!["direct".into()],
                }),
                https: (true, 35),
                ..Facts::default()
            },
            "cn.example.test  ✓ 直连，HTTPS 35ms\n\n\
解析   203.0.113.8   真实 IP\n\
DNS    dns-direct-cn   ← rule_set=ChinaMax-dns\n\
路由   rule_set=ChinaMax → direct   链路 direct\n\
连通   HTTPS 首字节 35ms\n",
        );
    }

    #[test]
    fn render_scenario_c_dial_failure() {
        assert_render(
            &Facts {
                domain: "photo.int.example.test".into(),
                resolved_ip: Some("192.168.1.46".into()),
                dns_match: Some(
                    "dns: match[0] domain_suffix=.int.example.test => predefined(NOERROR,*. 3600 IN A 192.168.1.46)"
                        .into(),
                ),
                dial: DialFact::Failed(
                    "dns: lookup failed for photo.int.example.test: (exchange4: NXDOMAIN | exchange6: NXDOMAIN)"
                        .into(),
                ),
                target_excluded: true,
                https: (false, 8),
                ..Facts::default()
            },
            concat!(
                "photo.int.example.test  ✗ 拨号解析失败\n",
                "\n",
                "解析   192.168.1.46   真实 IP\n",
                "DNS    predefined 192.168.1.46   ← domain_suffix=.int.example.test\n",
                "拨号   ✗ lookup failed: NXDOMAIN\n",
                "       拨号解析不经 dns.rules，只认 route.default_domain_resolver\n",
                "路由   未经路由判定（目标在 route_exclude_address 内，直连）\n",
                "连通   ✗ 立即失败 8ms（拨号被拒，不是超时）\n",
            ),
        );
    }

    #[test]
    fn render_scenario_d_kernel_unreachable() {
        assert_render(
            &Facts {
                domain: "app.example.test".into(),
                resolved_ip: Some("104.21.0.1".into()),
                kernel_unreachable: Some("127.0.0.1:9090".into()),
                https: (true, 310),
                ..Facts::default()
            },
            "app.example.test  ✗ 内核不可达（127.0.0.1:9090）\n\n\
解析   104.21.0.1   真实 IP\n\
内核   ✗ 不可达，已跳过 DNS / 路由 / 链路\n\
连通   HTTPS 首字节 310ms（内核不可达，路径未确认）\n",
        );
    }

    #[test]
    fn render_scenario_e_uncaptured_route() {
        assert_render(
            &Facts {
                domain: "app.example.test".into(),
                resolved_ip: Some("198.18.0.13".into()),
                resolved_fakeip: true,
                https: (true, 230),
                ..Facts::default()
            },
            "app.example.test  ✓ 通，但路由判定未捕获\n\n\
解析   198.18.0.13   fakeip，由内核接管\n\
DNS    未捕获   命中缓存，或日志级别不是 debug\n\
路由   未捕获   没有存续连接，也没抓到日志\n\
连通   HTTPS 首字节 230ms\n",
        );
    }
}
