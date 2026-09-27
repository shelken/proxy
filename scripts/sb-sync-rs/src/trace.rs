//! trace: 对指定域名做全链路探测（系统解析 / 内核 DNS 判定 / 路由判定 / 出站链路 / 首字节耗时）。
//!
//! 核心机制：监听内核 debug 日志流（`GET /logs?level=debug`），主动注入查询与流量，
//! 精确捕获 sing-box 内部真正的决策记录：
//!   1. DNS 走线：具体哪条 DNS 规则命中、具体选了哪个 DNS Server（`route(dns-fakeip)` / `route(dns-direct-cn)` 等）
//!   2. 路由走线：具体哪条路由规则命中、分配到哪个策略组（`route(gemini)` / `route(direct)` 等）
//!   3. 出口链路：连接实际经过的节点链（`vps-hy2 → selfhost → openai → gemini`）
//!   4. 首字节耗时：端到端真实延迟

use serde_json::Value;
use std::io::{BufRead, BufReader};
use std::net::ToSocketAddrs;
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
fn route_target(decision: &str) -> Option<&str> {
    decision
        .split("=> route(")
        .nth(1)
        .map(|t| t.trim_end_matches(')'))
}

/// 系统 resolver 解析（getaddrinfo），返回首个 IPv4。
pub fn system_resolve(domain: &str) -> Option<(String, u128)> {
    let start = Instant::now();
    let addrs: Vec<_> = (domain, 0u16).to_socket_addrs().ok()?.collect();
    let ip = addrs.iter().find_map(|a| match a {
        std::net::SocketAddr::V4(v4) => Some(v4.ip().to_string()),
        std::net::SocketAddr::V6(_) => None,
    })?;
    Some((ip, start.elapsed().as_millis()))
}

/// route get 判定目标 IP 实际出口接口名（macOS）；非 macOS 返回 None。
pub fn egress_interface(ip: &str) -> Option<String> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let out = std::process::Command::new("route")
        .args(["-n", "get", ip])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines() {
        let trimmed = line.trim();
        if let Some(i) = trimmed.strip_prefix("interface:") {
            return Some(i.trim().to_string());
        }
    }
    None
}

/// 内核决策捕获结果
#[derive(Default, Clone)]
struct KernelDecisions {
    dns_match: Option<String>,
    router_match: Option<String>,
    /// 该域名是否拿到过 fakeip 答案（拨号会因此失败，不算成功）
    fakeip_answer: Option<String>,
    /// 拨号解析失败证据行（`lookup failed for <domain>: ...`）
    dial_failure: Option<String>,
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
    let Some(id) = request_id(payload) else {
        return false;
    };
    let id = id.to_string();

    // 嗅探行确立该请求号属于目标域名
    if payload.contains("router: sniffed protocol") {
        if domain_in_line(payload).as_deref() == Some(target) && !wanted_ids.contains(&id) {
            wanted_ids.push(id);
        }
        return false;
    }
    // DNS/拨号行：带域名，做最后一道确认
    if domain_in_line(payload).as_deref() == Some(target) && !wanted_ids.contains(&id) {
        wanted_ids.push(id.clone());
    }
    if !wanted_ids.contains(&id) {
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
    } else if payload.contains("exchanged")
        && payload.contains(" IN A ")
        && guard.fakeip_answer.is_none()
    {
        // 提取答案 IP，稍后判断是否落 fakeip 段
        if let Some(ans) = payload.rsplit(' ').next() {
            if ans.parse::<std::net::Ipv4Addr>().is_ok() {
                guard.fakeip_answer = Some(ans.to_string());
            }
        }
    }
    guard.dns_match.is_some() && guard.router_match.is_some() && guard.dial_failure.is_some()
}

/// 从内核 debug 日志流实时捕获针对指定域名的 DNS 与路由决策。
///
/// 关联依据是请求号而非「第一条 match」：内核每个请求的各阶段日志带同一个
/// `[<id> <ms>]` 前缀，而 `dns: match[N]` 行不带域名。直接取第一条 match 会把
/// 后台流量（如缓存刷新）的判定算到目标域名头上。
fn capture_decisions(controller: &str, domain: &str) -> KernelDecisions {
    let decisions = Arc::new(Mutex::new(KernelDecisions::default()));
    let stop = Arc::new(AtomicBool::new(false));

    let dec_clone = Arc::clone(&decisions);
    let stop_clone = Arc::clone(&stop);
    let ctrl = controller.to_string();
    let target = domain.to_string();

    // 启动日志流监听线程
    let handle = std::thread::spawn(move || {
        let url = format!("http://{ctrl}/logs?level=debug");
        let Ok(resp) = ureq::get(&url).timeout(Duration::from_secs(4)).call() else {
            return;
        };
        let reader = BufReader::new(resp.into_reader());
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
    let _ = ureq::get(&format!("http://{ctrl_dns}/dns/query?name={dom}&type=A"))
        .timeout(Duration::from_secs(2))
        .call();

    // 触发 2: 发送 HTTPS 流量，触发内核 route 判定
    let dom_http = domain.to_string();
    std::thread::spawn(move || {
        let _ = ureq::get(&format!("https://{dom_http}/"))
            .timeout(Duration::from_secs(3))
            .call();
    });

    // 等待决策捕获（最多等待 1.2 秒）
    let start = Instant::now();
    while start.elapsed() < Duration::from_millis(1200) {
        if let Ok(guard) = decisions.lock() {
            if guard.dns_match.is_some() && guard.router_match.is_some() {
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    }

    stop.store(true, Ordering::Relaxed);
    let _ = handle.join();

    decisions.lock().map(|g| g.clone()).unwrap_or_default()
}

/// Clash API 查询活跃连接中该域名的出站代理链路
pub fn clash_api_chain(domain: &str, controller: &str) -> Option<String> {
    let res = ureq::get(&format!("http://{controller}/connections"))
        .timeout(Duration::from_secs(2))
        .call()
        .ok()?;
    let mut body = String::new();
    std::io::Read::read_to_string(&mut res.into_reader(), &mut body).ok()?;
    let v: Value = serde_json::from_str(&body).ok()?;
    let conns = v["connections"].as_array()?;
    for c in conns {
        let host = c["metadata"]["host"].as_str().unwrap_or("");
        let sniff = c["metadata"]["sniffHost"].as_str().unwrap_or("");
        let dst = c["metadata"]["destinationIP"].as_str().unwrap_or("");
        if host.eq_ignore_ascii_case(domain)
            || sniff.eq_ignore_ascii_case(domain)
            || dst == domain
            || host.ends_with(domain)
            || sniff.ends_with(domain)
        {
            let chains: Vec<&str> = c["chains"]
                .as_array()
                .map(|a| a.iter().filter_map(|x| x.as_str()).collect())
                .unwrap_or_default();
            if !chains.is_empty() {
                return Some(chains.join(" → "));
            }
        }
    }
    None
}

/// 读取产物 clash_api.external_controller（仅 127.0.0.1）。
pub fn clash_controller(cfg: &Value) -> Option<String> {
    let ec = cfg["experimental"]["clash_api"]["external_controller"].as_str()?;
    if ec.starts_with("127.0.0.1") {
        Some(ec.to_string())
    } else {
        None
    }
}

/// HTTP GET 首字节计时（经系统网络栈，即真实用户路径）。
pub fn http_first_byte(url: &str) -> (bool, u128) {
    let start = Instant::now();
    match ureq::get(url).timeout(Duration::from_secs(8)).call() {
        Ok(_) | Err(ureq::Error::Status(_, _)) => (true, start.elapsed().as_millis()),
        Err(_) => (false, start.elapsed().as_millis()),
    }
}

/// fakeip 池（与底模 `dns-fakeip` 的 inet4_range 一致）。落在这个段的 A 记录是假 IP，
/// 不是真实解析结果，拨号必然失败。
fn is_fakeip(ip: &str) -> bool {
    let Ok(a) = ip.parse::<std::net::Ipv4Addr>() else {
        return false;
    };
    let o = a.octets();
    o[0] == 198 && (o[1] == 18 || o[1] == 19)
}

/// Clash API 是否可达（`/version` 探活）。控制面不通时后续阶段全无意义，必须显式报错。
pub fn controller_reachable(controller: &str) -> bool {
    ureq::get(&format!("http://{controller}/version"))
        .timeout(Duration::from_secs(2))
        .call()
        .is_ok()
}

/// 执行全部阶段并打印报告；返回失败阶段数。
pub fn trace(domain: &str, controller: Option<&str>) -> u8 {
    println!("=== sb-sync trace — {domain} 全链路探测 ===\n");

    let mut fails: u8 = 0;

    // 阶段 1: 系统 resolver
    let mut resolved_fakeip = false;
    if let Some((ip, ms)) = system_resolve(domain) {
        let egress = egress_interface(&ip).unwrap_or_else(|| "?".into());
        if is_fakeip(&ip) {
            resolved_fakeip = true;
            println!(
                "✗ 系统 resolver   A {ip}  ({ms}ms)  出口 {egress}  ← fakeip 假 IP, 非真实解析"
            );
        } else {
            println!("✓ 系统 resolver   A {ip}  ({ms}ms)  出口 {egress}");
        }
    } else {
        println!("✗ 系统 resolver   解析失败/超时");
        fails += 1;
    }

    // 阶段 2 & 3: 监听内核决策流（DNS 规则 + 路由规则）
    match controller {
        Some(ec) if controller_reachable(ec) => {
            let decisions = capture_decisions(ec, domain);

            match &decisions.dns_match {
                Some(decision) => {
                    if decision.contains("dns-fakeip") {
                        println!("✓ 内核 DNS 判定   {decision}  ← 假 IP 路径, 拨号将失败");
                    } else {
                        println!("✓ 内核 DNS 判定   {decision}");
                    }
                }
                None => {
                    println!("⚠ 内核 DNS 判定   未捕获到匹配规则（可能命中缓存或 final）");
                }
            }

            match &decisions.router_match {
                Some(decision) => println!("✓ 内核路由判定   {decision}"),
                None => {
                    println!("⚠ 内核路由判定   未捕获到路由规则（可能直连或默认策略）");
                }
            }

            // 拨号解析证据行：诊断内网名失败的关键一行，缺失时旧版报告无从定位
            if let Some(f) = &decisions.dial_failure {
                println!("✗ 出站拨号解析   {f}");
                fails += 1;
            } else if let Some(ans) = &decisions.fakeip_answer.filter(|a| is_fakeip(a)) {
                println!(
                    "⚠ 出站拨号解析   拿到 fakeip 答案 {ans}，未观察到失败行（可能连接未走到拨号）"
                );
            }

            // 阶段 4: 出口代理链路
            match clash_api_chain(domain, ec) {
                Some(chain) => println!("✓ 实际出站链路   {chain}"),
                None => {
                    // 若短连接已关闭，从路由判定的目标也能明确出口
                    if let Some(rd) = &decisions.router_match {
                        if let Some(target) = route_target(rd) {
                            println!("✓ 规则分配目标   {target}");
                        }
                    }
                }
            }
        }
        Some(ec) => {
            // 控制面不通时后面每个阶段都会「无数据」，与其打一串 ⚠ 不如直说
            println!("✗ Clash API       {ec} 不可达（内核未运行 / controller 未开）");
            fails += 1;
        }
        None => {
            println!(
                "⚠ Clash API       未配置或不可达，跳过内核层判定（传 --api 127.0.0.1:9090 指定）"
            );
        }
    }

    // 阶段 5: HTTP 首字节耗时
    let (ok, ms) = http_first_byte(&format!("https://{domain}/"));
    if ok {
        println!("✓ HTTPS 首字节    {ms}ms");
        if ms > 3000 {
            println!("  ⚠ 超过 3s — 结合上方 DNS 与路由阶段定位延迟根因");
        }
    } else {
        // 立即失败（<1s）几乎都是拨号阶段的解析失败，不是超时
        let kind = if ms < 1000 {
            "立即失败 — 拨号/解析阶段拒绝，非超时"
        } else {
            "超时"
        };
        let hint = if resolved_fakeip {
            "（系统解析给的已是 fakeip 假 IP）"
        } else {
            ""
        };
        println!("✗ HTTPS 首字节    {ms}ms ({kind}){hint}");
        fails += 1;
    }

    fails
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

    #[test]
    fn fakeip_detects_pool_range() {
        assert!(is_fakeip("198.18.0.13"));
        assert!(is_fakeip("198.19.255.255"));
        assert!(!is_fakeip("192.168.99.99"));
        assert!(!is_fakeip("104.21.33.74"));
        assert!(!is_fakeip("not-an-ip"));
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
        assert!(g
            .router_match
            .as_deref()
            .unwrap_or("")
            .contains("route(direct)"));

        // 拨号解析失败证据行
        absorb_line(
            "[222 5ms] dns: lookup failed for prometheus.ooooo.space: (exchange4: NXDOMAIN | exchange6: NXDOMAIN)",
            "prometheus.ooooo.space",
            &mut ids,
            &mut g,
        );
        assert!(g.dial_failure.as_deref().unwrap_or("").contains("NXDOMAIN"));
    }

    /// fakeip 答案被抓出来，供上层判定「不算成功」。
    #[test]
    fn absorb_line_captures_fakeip_answer() {
        let mut ids = vec!["333".to_string()];
        let mut g = KernelDecisions::default();
        absorb_line(
            "[333 1ms] dns: exchanged A ooooo.space. 600 IN A 198.18.0.2",
            "ooooo.space",
            &mut ids,
            &mut g,
        );
        assert_eq!(g.fakeip_answer.as_deref(), Some("198.18.0.2"));
        assert!(is_fakeip(g.fakeip_answer.as_deref().unwrap_or("")));
    }
}
