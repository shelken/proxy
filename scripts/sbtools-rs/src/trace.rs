//! trace: 对指定域名做全链路探测（系统解析 / 内核 DNS 判定 / 路由判定 / 出站链路 / 首字节耗时）。
//!
//! 核心机制：监听内核 debug 日志流（`GET /logs?level=debug`），主动注入查询与流量，
//! 精确捕获 sing-box 内部真正的决策记录：
//!   1. DNS 走线：具体哪条 DNS 规则命中、具体选了哪个 DNS Server（`route(dns-fakeip)` / `route(dns-direct-cn)` 等）
//!   2. 路由走线：具体哪条路由规则命中、分配到哪个策略组（`route(gemini)` / `route(direct)` 等）
//!   3. 出口链路：连接实际经过的节点链（`vps-hy2 → selfhost → openai → gemini`）
//!   4. 首字节耗时：端到端真实延迟
//!
//! 与 `scripts/trace-route.ts`（沙箱侧）的分工：本模块跑在真机上，验证**当前部署**
//! 在真实网络环境下的表现；沙箱侧在 Lima VM 内用于**离线复现**配置裁决。两者被测
//! 对象不同，各自维护日志解析；改任一侧只需与内核实际日志格式对齐，不必互相同步。

use crate::template;
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
#[derive(Default, Clone, Debug)]
struct KernelDecisions {
    dns_match: Option<String>,
    router_match: Option<String>,
    /// 该域名是否拿到过 fakeip 答案（拨号会因此失败，不算成功）
    fakeip_answer: Option<String>,
    /// 拨号解析失败证据行（`lookup failed for <domain>: ...`）
    dial_failure: Option<String>,
    /// 拨号解析成功行（`lookup succeed for <domain>: ...`）
    dial_success: Option<String>,
    /// 拨号解析发起行（`dns: lookup domain <domain>`）。
    /// 这行存在而整条链路无 dns: match，就是「拨号走 default_domain_resolver、
    /// 不经 dns.rules」的直接证据。
    dial_lookup: Option<String>,
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
        if let (Some(id), true) = (id.as_ref(), matches_target) {
            if !wanted_ids.contains(id) {
                wanted_ids.push(id.clone());
            }
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
    guard.router_match.is_some() && (guard.dns_match.is_some() || guard.dial_failure.is_some())
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

    // 等待决策捕获。只等拨号解析的收尾行（成功或失败）：它是本工具要报的关键证据，
    // 且晚于 match 行到达；等满 1.2s 即收工，不能只等两个 match 就停，否则会在
    // 证据行落地前掐掉监听。
    let start = Instant::now();
    while start.elapsed() < Duration::from_millis(1200) {
        if let Ok(guard) = decisions.lock() {
            if guard.dial_failure.is_some() || guard.dial_success.is_some() {
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

/// fakeip 池（从底模 `dns-fakeip` 的 inet4_range 读）。落在这个段的 A 记录是假 IP，
/// 不是真实解析结果，拨号必然失败。
struct Ipv4Cidr {
    net: std::net::Ipv4Addr,
    prefix: u32,
}

impl Ipv4Cidr {
    /// 段来源于 `config/sing-box/template.json`；读不到就退回 `198.18.0.0/15`
    /// （sing-box fakeip 的默认段），保证 trace 仍可用。
    fn from_template() -> Self {
        let fallback = || Self {
            net: std::net::Ipv4Addr::new(198, 18, 0, 0),
            prefix: 15,
        };
        let Ok((template, _)) = template::load_template(None) else {
            return fallback();
        };
        let Some(spec) = template["dns"]["servers"]
            .as_array()
            .and_then(|servers| {
                servers
                    .iter()
                    .find(|s| s["type"].as_str() == Some("fakeip"))
            })
            .and_then(|s| s["inet4_range"].as_str())
        else {
            return fallback();
        };
        parse_cidr4(spec).unwrap_or_else(fallback)
    }
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

/// 从底模读一次 fakeip 段，进程内复用。
static FAKEIP_RANGE: std::sync::LazyLock<Ipv4Cidr> =
    std::sync::LazyLock::new(Ipv4Cidr::from_template);

fn prefix_mask(prefix: u32) -> u32 {
    if prefix == 0 {
        0
    } else {
        u32::MAX << (32 - prefix)
    }
}

/// tun 入站的 `route_exclude_address`。目标落这些段时流量根本不进 TUN，内核
/// 不会产生路由判定日志——这是「直连」而非「未捕获」，报告必须分得开。
static EXCLUDE_ADDRESS: std::sync::LazyLock<Vec<Ipv4Cidr>> = std::sync::LazyLock::new(|| {
    template::load_template(None)
        .ok()
        .and_then(|(t, _)| {
            t["inbounds"].as_array().map(|inbounds| {
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
        })
        .unwrap_or_default()
});

fn is_excluded(ip: &str) -> bool {
    let Ok(a) = ip.parse::<std::net::Ipv4Addr>() else {
        return false;
    };
    EXCLUDE_ADDRESS
        .iter()
        .any(|c| u32::from(a) & prefix_mask(c.prefix) == u32::from(c.net))
}

fn is_fakeip(ip: &str) -> bool {
    let Ok(a) = ip.parse::<std::net::Ipv4Addr>() else {
        return false;
    };
    let range = &*FAKEIP_RANGE;
    u32::from(a) & prefix_mask(range.prefix) == u32::from(range.net)
}

/// Clash API 是否可达（`/version` 探活）。控制面不通时后续阶段全无意义，必须显式报错。
pub fn controller_reachable(controller: &str) -> bool {
    ureq::get(&format!("http://{controller}/version"))
        .timeout(Duration::from_secs(2))
        .call()
        .is_ok()
}

/// 内核决策段的报告：DNS 判定 / 路由判定 / 拨号解析证据 / 出口链路。
/// 返回本段新增的失败阶段数。
fn report_kernel_decisions(ec: &str, domain: &str, resolved_ip: Option<&str>) -> u8 {
    let decisions = capture_decisions(ec, domain);
    let mut fails: u8 = 0;

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
            // 目标在 route_exclude_address 内时内核本就不产生路由日志，
            // 与「没抓到」是两回事，不能都打 ⚠
            if resolved_ip.is_some_and(is_excluded) {
                println!(
                    "· 内核路由判定   目标 {} 在 route_exclude_address 内，不经路由判定（直连）",
                    resolved_ip.unwrap_or("?")
                );
            } else {
                println!("⚠ 内核路由判定   未捕获到路由规则（可能直连或默认策略）");
            }
        }
    }

    // 拨号解析证据行：诊断内网名失败的关键一行，缺失时旧版报告无从定位。
    // 同时报出「拨号走哪个解析路径」：这行不经 dns.rules，只认
    // route.default_domain_resolver，与入站查询是两条不同的解析路径。
    if let Some(f) = &decisions.dial_failure {
        println!("✗ 出站拨号解析   {f}  ← 不经 dns.rules，只认 route.default_domain_resolver");
        fails += 1;
    } else if let Some(s) = &decisions.dial_success {
        println!("✓ 出站拨号解析   {s}");
    } else if let Some(l) = &decisions.dial_lookup {
        println!("· 出站拨号解析   {l}  (已发起，未观察到结果行)");
    } else if let Some(ans) = &decisions.fakeip_answer.filter(|a| is_fakeip(a)) {
        println!("⚠ 出站拨号解析   拿到 fakeip 答案 {ans}，未观察到失败行（可能连接未走到拨号）");
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
    fails
}

/// 执行全部阶段并打印报告；返回失败阶段数。
pub fn trace(domain: &str, controller: Option<&str>) -> u8 {
    println!("=== sbtools trace — {domain} 全链路探测 ===\n");

    let mut fails: u8 = 0;

    // 阶段 1: 系统 resolver
    let mut resolved_fakeip = false;
    let mut resolved_ip: Option<String> = None;
    if let Some((ip, ms)) = system_resolve(domain) {
        resolved_ip = Some(ip.clone());
        let egress = egress_interface(&ip).unwrap_or_else(|| "?".into());
        if is_fakeip(&ip) {
            resolved_fakeip = true;
            println!(
                "✗ 系统 resolver   A {ip}  ({ms}ms)  出口 {egress}  ← fakeip 假 IP, 非真实解析"
            );
            fails += 1;
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
            fails += report_kernel_decisions(ec, domain, resolved_ip.as_deref());
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
        assert!(g
            .dial_lookup
            .as_deref()
            .unwrap_or("")
            .contains("lookup domain"));
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
        assert!(d
            .dial_success
            .as_deref()
            .unwrap_or("")
            .contains("104.21.33.74"));
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

        absorb_line(
            "dns: exchanged A prometheus.ooooo.space. 600 IN A 198.18.0.2",
            "prometheus.ooooo.space",
            &mut ids,
            &mut g,
        );
        assert_eq!(g.fakeip_answer.as_deref(), Some("198.18.0.2"));

        // 别的域名的无 id 行仍须拒绝
        let mut g2 = KernelDecisions::default();
        absorb_line(
            "dns: match[2] query_type=[A AAAA] => route(dns-fakeip)",
            "prometheus.ooooo.space",
            &mut Vec::new(),
            &mut g2,
        );
        absorb_line(
            "dns: exchanged A ntp.ubuntu.com. 600 IN A 198.18.0.9",
            "prometheus.ooooo.space",
            &mut Vec::new(),
            &mut g2,
        );
        assert!(
            g2.fakeip_answer.is_none(),
            "无 id 且域名不匹配的行不得被收下"
        );
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
            g.dial_success.is_none() && g.fakeip_answer.is_none() && g.dial_lookup.is_none(),
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

    /// fakeip 段从底模读取，与 `config/sing-box/template.json` 的 inet4_range 绑定；
    /// 底模改了段而 trace 还写死 198.18/15 会静默误判。
    #[test]
    fn fakeip_range_matches_template() {
        let (template, _) = template::load_template(None).expect("底模应可加载");
        let spec = template["dns"]["servers"]
            .as_array()
            .and_then(|servers| {
                servers
                    .iter()
                    .find(|s| s["type"].as_str() == Some("fakeip"))
            })
            .and_then(|s| s["inet4_range"].as_str())
            .expect("底模应有 fakeip inet4_range");
        let parsed = parse_cidr4(spec).expect("inet4_range 应是合法 CIDR");
        assert_eq!(parsed.prefix, 15);
        assert_eq!(parsed.net, std::net::Ipv4Addr::new(198, 18, 0, 0));
        assert!(is_fakeip("198.18.0.13"));
        assert!(is_fakeip("198.19.255.255"));
        assert!(!is_fakeip("198.20.0.1"));
    }

    #[test]
    fn parse_cidr4_rejects_malformed() {
        assert!(parse_cidr4("198.18.0.0").is_none());
        assert!(parse_cidr4("198.18.0.0/33").is_none());
        assert!(parse_cidr4("not-an-ip/15").is_none());
        assert_eq!(parse_cidr4("198.18.0.1/15").unwrap().net.octets()[1], 18);
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

    /// tun 入站的 route_exclude_address 决定「直连所以没有路由日志」；
    /// 底模改了段而 trace 还写死会静默误判。
    #[test]
    fn exclude_address_matches_template() {
        assert!(is_excluded("192.168.69.46"), "内网段应命中 exclude");
        assert!(is_excluded("10.1.2.3"));
        assert!(!is_excluded("8.8.8.8"));
        assert!(!is_excluded("198.18.0.13"), "fakeip 段不在 exclude 内");
    }
}
