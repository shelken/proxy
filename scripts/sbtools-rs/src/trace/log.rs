//! 内核日志捕获：`absorb_line` 状态机与 `/logs?level=debug` 流监听。
//!
//! 每个请求的各阶段日志带同一个 `[<id> <ms>]` 前缀，而 `dns: match[N]` 行不带域名，
//! 只能靠请求号与相邻 exchange/exchanged 行回填的域名关联。后台流量（缓存刷新）
//! 的判定不得算到目标域名头上。

use serde_json::Value;
use std::io::{BufRead, BufReader};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// 从日志 payload 里取请求号：`[254349897 4ms] router: ...` → `254349897`。
///
/// 内核每个请求的各阶段日志带同一个请求号，这是把「DNS 判定」与「路由判定」
/// 归到同一个域名的唯一依据：`dns: match[N]` 行本身不带域名。
fn request_id(payload: &str) -> Option<&str> {
    let open = payload.find('[')?;
    let rest = &payload[open + 1..];
    let id = rest.split_whitespace().next()?;
    id.chars().all(|c| c.is_ascii_digit()).then_some(id)
}

/// 从一行日志里抽域名（嗅探行、DNS exchange/lookup 行都带）。
fn domain_in_line(payload: &str) -> Option<String> {
    if let Some(idx) = payload.find("domain: ") {
        let host = payload[idx + "domain: ".len()..]
            .split(|c: char| c.is_whitespace() || c == ',')
            .next()?;
        let host = host.trim_matches(|c: char| c == '.' || c == ':');
        if !host.is_empty() {
            return Some(host.to_string());
        }
    }
    for key in [
        "dns: exchanged A ",
        "dns: exchange ",
        "dns: lookup domain ",
        "lookup succeed for ",
    ] {
        if let Some(idx) = payload.find(key) {
            let host = payload[idx + key.len()..]
                .split_whitespace()
                .next()?
                .trim_matches(|c: char| c == '.' || c == ':');
            if !host.is_empty() {
                return Some(host.to_string());
            }
        }
    }
    None
}

/// 决策行里 `=> route(x)` 的目标 server/outbound 名。
pub(super) fn route_target(decision: &str) -> Option<&str> {
    decision
        .split("=> route(")
        .nth(1)
        .map(|t| t.trim_end_matches(')'))
}

/// 内核决策捕获结果
#[derive(Default, Clone, Debug)]
pub(super) struct KernelDecisions {
    pub(super) dns_match: Option<String>,
    pub(super) router_match: Option<String>,
    /// 拨号解析失败证据行（`lookup failed for <domain>: ...`）
    pub(super) dial_failure: Option<String>,
    /// 拨号解析成功行（`lookup succeed for <domain>: ...`）
    dial_success: Option<String>,
    /// 拨号解析发起行（`dns: lookup domain <domain>`）。
    /// 这行存在而整条链路无 dns: match，就是「拨号走 default_domain_resolver、
    /// 不经 dns.rules」的直接证据。
    pub(super) dial_lookup: Option<String>,
    /// 最近一条无 id DNS 行确立的域名。Clash API `/dns/query` 的日志不带请求号，
    /// 而 `dns: match[N]` 行本身不带域名（只带 query_type / domain_suffix，
    /// `domain_in_line` 认不出），只能回填上一条 exchange/exchanged 行确立的域名。
    /// 无前缀查询并发交错时会误归属，是该兜底的已知上限。
    recent_dns_domain: Option<String>,
}

/// 处理一行日志：确认它是否属于目标域名，是则把决策/证据写进 `guard`。
///
/// 返回 true 表示目标请求已收齐所需信息，可停止监听。
fn absorb_line(
    payload: &str,
    target: &str,
    wanted_ids: &mut Vec<String>,
    guard: &mut KernelDecisions,
) -> bool {
    // here-doc 这类多行载荷会整体命中域名与决策子串，被拼成一行收下。
    // 真内核日志每条只有一行，换行即非内核日志。
    if payload.contains('\n') {
        return false;
    }
    // Clash API `/dns/query` 触发的日志没有请求号：该端点用 context.Background()
    // 起 Exchange，内核只在 ctx 带 ID 时才写 `[<id> <ms>]` 前缀。缺前缀的行只能
    // 凭域名归属判断，丢不得。
    let id = request_id(payload).map(str::to_string);
    let matches_target = domain_in_line(payload).as_deref() == Some(target);

    // 嗅探行确立该请求号属于目标域名
    if payload.contains("router: sniffed protocol") {
        if let (Some(id), true) = (id.as_ref(), matches_target)
            && !wanted_ids.contains(id)
        {
            wanted_ids.push(id.clone());
        }
        return false;
    }
    let owned = if let Some(id) = id.as_ref() {
        // DNS/拨号行：带域名，做最后一道确认
        if matches_target && !wanted_ids.contains(id) {
            wanted_ids.push(id.clone());
        }
        wanted_ids.contains(id)
    } else {
        // 无 id 的 DNS 行自带域名时记下归属。`dns: match[N]` 行本身不带域名
        // （只带 query_type / domain_suffix，`domain_in_line` 认不出），靠上一条
        // exchange/exchanged 行确立的域名回填；留一手的是同一查询的相邻行。
        if let Some(d) = domain_in_line(payload) {
            guard.recent_dns_domain = Some(d);
        }
        guard.recent_dns_domain.as_deref() == Some(target)
    };
    if !owned {
        return false;
    }

    if payload.contains("dns: match[") && guard.dns_match.is_none() {
        if let Some(idx) = payload.find("dns: match[") {
            guard.dns_match = Some(payload[idx..].to_string());
        }
    } else if payload.contains("router: match[")
        && !payload.contains("=> sniff")
        && guard.router_match.is_none()
    {
        if let Some(idx) = payload.find("router: match[") {
            guard.router_match = Some(payload[idx..].to_string());
        }
    } else if payload.contains("lookup failed for ") && guard.dial_failure.is_none() {
        guard.dial_failure = Some(payload.trim().to_string());
    } else if payload.contains("lookup succeed for ") && guard.dial_success.is_none() {
        guard.dial_success = Some(payload.trim().to_string());
    } else if payload.contains("dns: lookup domain ") && guard.dial_lookup.is_none() {
        guard.dial_lookup = Some(payload.trim().to_string());
    }
    guard.router_match.is_some() && (guard.dns_match.is_some() || guard.dial_failure.is_some())
}

/// 从内核 debug 日志流实时捕获针对指定域名的 DNS 与路由决策。
///
/// 关联依据是请求号而非「第一条 match」：内核每个请求的各阶段日志带同一个
/// `[<id> <ms>]` 前缀，而 `dns: match[N]` 行不带域名。直接取第一条 match 会把
/// 后台流量（如缓存刷新）的判定算到目标域名头上。
pub(super) fn capture_decisions(controller: &str, domain: &str) -> KernelDecisions {
    let decisions = Arc::new(Mutex::new(KernelDecisions::default()));
    let stop = Arc::new(AtomicBool::new(false));

    let dec_clone = Arc::clone(&decisions);
    let stop_clone = Arc::clone(&stop);
    let ctrl = controller.to_string();
    let target = domain.to_string();

    // 启动日志流监听线程
    let handle = std::thread::spawn(move || {
        let url = format!("http://{ctrl}/logs?level=debug");
        let Ok(resp) = crate::clashapi::agent_with_timeout(Duration::from_secs(4))
            .get(&url)
            .call()
        else {
            return;
        };
        let body = resp.into_body();
        let reader = BufReader::new(body.into_reader());
        // 只认「域名已确认为目标」的请求号：嗅探行先确立 id→域名 映射
        let mut wanted_ids: Vec<String> = Vec::new();
        for line in reader.lines() {
            if stop_clone.load(Ordering::Relaxed) {
                break;
            }
            let Ok(l) = line else { continue };
            let Ok(v) = serde_json::from_str::<Value>(&l) else {
                continue;
            };
            let Some(payload) = v["payload"].as_str() else {
                continue;
            };
            let Ok(mut guard) = dec_clone.lock() else {
                continue;
            };
            if absorb_line(payload, &target, &mut wanted_ids, &mut guard) {
                break;
            }
        }
    });

    // 等待监听器就绪
    std::thread::sleep(Duration::from_millis(200));

    // 触发 1: 发送 DNS 查询
    let dom = domain.to_string();
    let ctrl_dns = controller.to_string();
    let _ = crate::clashapi::agent_with_timeout(Duration::from_secs(2))
        .get(&format!("http://{ctrl_dns}/dns/query?name={dom}&type=A"))
        .call();

    // 触发 2: 发送 HTTPS 流量，触发内核 route 判定
    let dom_http = domain.to_string();
    std::thread::spawn(move || {
        let _ = crate::clashapi::agent_with_timeout(Duration::from_secs(3))
            .get(&format!("https://{dom_http}/"))
            .call();
    });

    // 等待决策捕获。只等拨号解析的收尾行（成功或失败）：它是本工具要报的关键证据，
    // 且晚于 match 行到达；等满 1.2s 即收工，不能只等两个 match 就停，否则会在
    // 证据行落地前掐掉监听。
    let start = Instant::now();
    while start.elapsed() < Duration::from_millis(1200) {
        if let Ok(guard) = decisions.lock()
            && (guard.dial_failure.is_some() || guard.dial_success.is_some())
        {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }

    stop.store(true, Ordering::Relaxed);
    // 不 join：reader 卡在无新行时的 read_line，join 会一直等到流的整体超时。
    // stop 置位后线程自行退出，进程结束即回收。
    drop(handle);

    decisions.lock().map(|g| g.clone()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn request_id_extracts_leading_bracket_number() {
        assert_eq!(
            request_id("[254349897 4ms] router: sniffed protocol: tls, domain: kelee.one"),
            Some("254349897")
        );
        assert_eq!(request_id("no bracket here"), None);
        assert_eq!(request_id("[abc 4ms] x"), None);
    }

    #[test]
    fn domain_in_line_reads_sniff_exchange_and_lookup() {
        assert_eq!(
            domain_in_line("router: sniffed protocol: tls, domain: kelee.one"),
            Some("kelee.one".to_string())
        );
        assert_eq!(
            domain_in_line("dns: exchanged A ntp.ubuntu.com. 600 IN A 198.18.0.2"),
            Some("ntp.ubuntu.com".to_string())
        );
        assert_eq!(
            domain_in_line("dns: lookup succeed for kelee.one: 104.21.33.74"),
            Some("kelee.one".to_string())
        );
        assert_eq!(
            domain_in_line("dns: match[2] query_type=[A AAAA] => route(dns-fakeip)"),
            None
        );
    }

    #[test]
    fn route_target_extracts_outbound() {
        assert_eq!(
            route_target("router: match[20] rule_set=[ChinaMax Lan] => route(direct)"),
            Some("direct")
        );
        assert_eq!(route_target("router: match[1] => sniff"), None);
    }

    /// 关联的核心契约：同请求号的行才归到目标域名，别的域名（后台缓存刷新）不能污染。
    #[test]
    fn absorb_line_ignores_other_domains_by_request_id() {
        let mut ids = Vec::new();
        let mut g = KernelDecisions::default();
        // 后台 ntp 请求：嗅探行域名不匹配 → 不登记
        absorb_line(
            "[111 0ms] router: sniffed protocol: udp, domain: ntp.ubuntu.com",
            "prometheus.ooooo.space",
            &mut ids,
            &mut g,
        );
        // 同 id 的 dns 决策行 → 必须被忽略，否则就是把别人的判定算到目标头上
        absorb_line(
            "[111 1ms] dns: match[2] query_type=[A AAAA] => route(dns-fakeip)",
            "prometheus.ooooo.space",
            &mut ids,
            &mut g,
        );
        assert!(
            g.dns_match.is_none(),
            "别的域名的判定被误收: {:?}",
            g.dns_match
        );

        // 目标域名的嗅探行 → 登记 id
        absorb_line(
            "[222 0ms] router: sniffed protocol: tls, domain: prometheus.ooooo.space",
            "prometheus.ooooo.space",
            &mut ids,
            &mut g,
        );
        absorb_line(
            "[222 4ms] router: match[20] rule_set=[ChinaMax Lan MyDirect] => route(direct)",
            "prometheus.ooooo.space",
            &mut ids,
            &mut g,
        );
        assert!(
            g.router_match
                .as_deref()
                .unwrap_or("")
                .contains("route(direct)")
        );

        // 拨号解析失败证据行
        absorb_line(
            "[222 5ms] dns: lookup failed for prometheus.ooooo.space: (exchange4: NXDOMAIN | exchange6: NXDOMAIN)",
            "prometheus.ooooo.space",
            &mut ids,
            &mut g,
        );
        assert!(g.dial_failure.as_deref().unwrap_or("").contains("NXDOMAIN"));
    }

    /// 拨号解析的三行证据（发起 / 成功 / 失败）都要能抓到，且互不覆盖。
    /// 这是报告里「出站拨号解析」段的唯一数据来源。
    #[test]
    fn absorb_line_captures_dial_path_evidence() {
        let mut g = KernelDecisions::default();

        // 发起行：它存在而链路无 dns: match，就是「拨号不经 dns.rules」的直接证据
        let mut ids = vec!["444".to_string()];
        absorb_line(
            "[444 4ms] dns: lookup domain prometheus.ooooo.space",
            "prometheus.ooooo.space",
            &mut ids,
            &mut g,
        );
        assert!(
            g.dial_lookup
                .as_deref()
                .unwrap_or("")
                .contains("lookup domain")
        );
        assert!(g.dial_failure.is_none() && g.dial_success.is_none());

        // 失败行
        absorb_line(
            "[444 6ms] dns: lookup failed for prometheus.ooooo.space: (exchange4: NXDOMAIN | exchange6: NXDOMAIN)",
            "prometheus.ooooo.space",
            &mut ids,
            &mut g,
        );
        assert!(g.dial_failure.as_deref().unwrap_or("").contains("NXDOMAIN"));
        assert!(g.dial_success.is_none(), "失败不应同时被记成成功");

        // 成功行（另一请求）
        let mut d = KernelDecisions::default();
        absorb_line(
            "[555 4ms] dns: lookup succeed for kelee.one: 104.21.33.74",
            "kelee.one",
            &mut vec!["555".to_string()],
            &mut d,
        );
        assert!(
            d.dial_success
                .as_deref()
                .unwrap_or("")
                .contains("104.21.33.74")
        );
    }

    /// Clash API `/dns/query` 触发的日志没有请求号（该端点用 context.Background()
    /// 起 Exchange）。这类行只能凭本行域名归属，不能因为取不到 id 就丢。
    /// 回归：早先无条件要求 id，会把触发 1 产出的 dns: match 全部丢弃。
    #[test]
    fn absorb_line_accepts_id_less_lines_by_domain() {
        let mut ids: Vec<String> = Vec::new();
        let mut g = KernelDecisions::default();

        absorb_line(
            "dns: match[2] query_type=[A AAAA] => route(dns-fakeip)",
            "prometheus.ooooo.space",
            &mut ids,
            &mut g,
        );
        // 无 id 行不带域名，无从判断归属，不得收下（否则又是「第一条 match」污染）
        assert!(g.dns_match.is_none(), "无域名的无 id 行不应被收下");

        // 同查询的 exchange 行确立域名归属，随后的无 id match 行据此被收下
        absorb_line(
            "dns: exchange prometheus.ooooo.space. IN A",
            "prometheus.ooooo.space",
            &mut ids,
            &mut g,
        );
        assert_eq!(
            g.recent_dns_domain.as_deref(),
            Some("prometheus.ooooo.space")
        );
        absorb_line(
            "dns: match[2] query_type=[A AAAA] => route(dns-fakeip)",
            "prometheus.ooooo.space",
            &mut ids,
            &mut g,
        );
        assert!(g.dns_match.as_deref().unwrap_or("").contains("dns-fakeip"));

        // 别的域名的无 id 行仍须拒绝
        let mut g2 = KernelDecisions::default();
        absorb_line(
            "dns: exchange ntp.ubuntu.com. IN A",
            "prometheus.ooooo.space",
            &mut Vec::new(),
            &mut g2,
        );
        absorb_line(
            "dns: match[2] query_type=[A AAAA] => route(dns-fakeip)",
            "prometheus.ooooo.space",
            &mut Vec::new(),
            &mut g2,
        );
        assert!(g2.dns_match.is_none(), "无 id 且域名不匹配的行不得被收下");
    }

    /// 多行载荷（here-doc 日志）会被拼成一行、整体命中域名与决策子串，
    /// 误收成一次「决策」。真内核日志每条只有一行。
    #[test]
    fn absorb_line_rejects_multiline_payload() {
        let mut ids: Vec<String> = vec!["7".to_string()];
        let mut g = KernelDecisions::default();
        absorb_line(
            "[7 1ms] dns: exchanged A ooooo.space. 600 IN A 198.18.0.2\nlookup succeed for ooooo.space: 198.18.0.2",
            "ooooo.space",
            &mut ids,
            &mut g,
        );
        // 整条载荷里同时命中域名与两类决策子串，未拦下则会被收成拨号成功
        assert!(
            g.dial_success.is_none() && g.recent_dns_domain.is_none() && g.dial_lookup.is_none(),
            "多行载荷不应被当成一条日志: {g:?}"
        );
    }

    /// 收工条件：router match 到手后，只要有一条拨号结果行就可以停，
    /// 不能因为等不到 dns: match（无 id 行未到达）而空等到超时。
    #[test]
    fn absorb_line_signals_done_on_dial_result() {
        let mut ids: Vec<String> = vec!["8".to_string()];
        let mut g = KernelDecisions::default();
        absorb_line(
            "[8 1ms] router: match[20] rule_set=[MyDirect] => route(direct)",
            "ooooo.space",
            &mut ids,
            &mut g,
        );
        // 尚无拨号结果 → 未完成
        assert!(!absorb_line(
            "[8 2ms] dns: lookup domain ooooo.space",
            "ooooo.space",
            &mut ids,
            &mut g
        ));
        // 拨号失败行到达 → 完成
        assert!(absorb_line(
            "[8 5ms] dns: lookup failed for ooooo.space: (exchange4: NXDOMAIN)",
            "ooooo.space",
            &mut ids,
            &mut g
        ));
    }

    /// 无 id 前缀的 `dns: match[N]` 行不带域名（只带 query_type / domain_suffix），
    /// 靠上一条 exchange/exchanged 行确立的域名回填。回归：只按本行域名归属时，
    /// 这类行整条被丢，内核 DNS 判定阶段落空——正是实机抓到的样子。
    #[test]
    fn absorb_line_backfills_recent_dns_domain() {
        // 与实机捕获一致的行序（example.com 走 fakeip）
        let mut ids: Vec<String> = Vec::new();
        let mut g = KernelDecisions::default();
        for line in [
            "dns: exchange example.com. IN A",
            "dns: match[8] query_type=[A AAAA] => route(dns-fakeip)",
        ] {
            absorb_line(line, "example.com", &mut ids, &mut g);
        }
        assert!(
            g.dns_match
                .as_deref()
                .unwrap_or("")
                .contains("route(dns-fakeip)"),
            "match 行应经最近域名回填被收下: {:?}",
            g.dns_match
        );

        // 内网名走 predefined，返回真实 IP；match 行带 domain_suffix 也无 id
        let mut g2 = KernelDecisions::default();
        for line in [
            "dns: exchange photo.int.ooooo.space. IN A",
            "dns: match[0] query_type=A domain_suffix=.int.ooooo.space => predefined(NOERROR,*. 3600 IN A 192.168.69.46)",
        ] {
            absorb_line(line, "photo.int.ooooo.space", &mut ids, &mut g2);
        }
        assert!(
            g2.dns_match
                .as_deref()
                .unwrap_or("")
                .contains("=> predefined"),
            "predefined 的 match 行应被收下: {:?}",
            g2.dns_match
        );

        // 最近域名是别的查询时不得收下：回填只认目标域名
        let mut g3 = KernelDecisions::default();
        absorb_line(
            "dns: exchange other.example.net. IN A",
            "photo.int.ooooo.space",
            &mut ids,
            &mut g3,
        );
        absorb_line(
            "dns: match[0] query_type=A => route(dns-fakeip)",
            "photo.int.ooooo.space",
            &mut ids,
            &mut g3,
        );
        assert!(g3.dns_match.is_none(), "最近域名不属于目标时不应收下");
    }
}
