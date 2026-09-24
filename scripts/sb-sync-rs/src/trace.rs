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

/// 系统 resolver 解析（getaddrinfo），返回首个 IPv4。
pub fn system_resolve(domain: &str) -> Option<(String, u128)> {
    let start = Instant::now();
    let addrs: Vec<_> = (domain, 0u16).to_socket_addrs().ok()?.collect();
    let ip = addrs.iter().find_map(|a| match a {
        std::net::SocketAddr::V4(v4) => Some(v4.ip().to_string()),
        _ => None,
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
}

/// 从内核 debug 日志流实时捕获针对指定域名的 DNS 与路由决策。
fn capture_decisions(controller: &str, domain: &str) -> (Option<String>, Option<String>) {
    let decisions = Arc::new(Mutex::new(KernelDecisions::default()));
    let stop = Arc::new(AtomicBool::new(false));

    let dec_clone = Arc::clone(&decisions);
    let stop_clone = Arc::clone(&stop);
    let ctrl = controller.to_string();

    // 启动日志流监听线程
    let handle = std::thread::spawn(move || {
        let url = format!("http://{ctrl}/logs?level=debug");
        let resp = match ureq::get(&url).timeout(Duration::from_secs(4)).call() {
            Ok(r) => r,
            Err(_) => return,
        };
        let reader = BufReader::new(resp.into_reader());
        for line in reader.lines() {
            if stop_clone.load(Ordering::Relaxed) {
                break;
            }
            if let Ok(l) = line {
                if let Ok(v) = serde_json::from_str::<Value>(&l) {
                    if let Some(payload) = v["payload"].as_str() {
                        let mut guard = dec_clone.lock().unwrap();
                        if payload.contains("dns: match[") && guard.dns_match.is_none() {
                            // 清洗前导日志时间戳：[12345 2ms] dns: match...
                            let clean = if let Some(idx) = payload.find("dns: match[") {
                                &payload[idx..]
                            } else {
                                payload
                            };
                            guard.dns_match = Some(clean.to_string());
                        } else if payload.contains("router: match[")
                            && !payload.contains("=> sniff")
                            && guard.router_match.is_none()
                        {
                            let clean = if let Some(idx) = payload.find("router: match[") {
                                &payload[idx..]
                            } else {
                                payload
                            };
                            guard.router_match = Some(clean.to_string());
                        }
                        if guard.dns_match.is_some() && guard.router_match.is_some() {
                            break;
                        }
                    }
                }
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
        {
            let guard = decisions.lock().unwrap();
            if guard.dns_match.is_some() && guard.router_match.is_some() {
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    }

    stop.store(true, Ordering::Relaxed);
    let _ = handle.join();

    let guard = decisions.lock().unwrap();
    (guard.dns_match.clone(), guard.router_match.clone())
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
        Ok(_) => (true, start.elapsed().as_millis()),
        Err(ureq::Error::Status(_, _)) => (true, start.elapsed().as_millis()),
        Err(_) => (false, start.elapsed().as_millis()),
    }
}

/// 执行全部阶段并打印报告；返回失败阶段数。
pub fn trace(domain: &str, controller: Option<String>) -> u8 {
    println!("=== sb-sync trace — {domain} 全链路探测 ===\n");

    let mut fails: u8 = 0;

    // 阶段 1: 系统 resolver
    match system_resolve(domain) {
        Some((ip, ms)) => {
            let egress = egress_interface(&ip).unwrap_or_else(|| "?".into());
            println!("✓ 系统 resolver   A {ip}  ({ms}ms)  出口 {egress}");
        }
        None => {
            println!("✗ 系统 resolver   解析失败/超时");
            fails += 1;
        }
    }

    // 阶段 2 & 3: 监听内核决策流（DNS 规则 + 路由规则）
    match controller.as_deref() {
        Some(ec) => {
            let (dns_decision, router_decision) = capture_decisions(ec, domain);

            match &dns_decision {
                Some(decision) => println!("✓ 内核 DNS 判定   {decision}"),
                None => {
                    println!("⚠ 内核 DNS 判定   未捕获到匹配规则（可能命中缓存或 final）");
                }
            }

            match &router_decision {
                Some(decision) => println!("✓ 内核路由判定   {decision}"),
                None => {
                    println!("⚠ 内核路由判定   未捕获到路由规则（可能直连或默认策略）");
                }
            }

            // 阶段 4: 出口代理链路
            match clash_api_chain(domain, ec) {
                Some(chain) => println!("✓ 实际出站链路   {chain}"),
                None => {
                    // 若短连接已关闭，从路由判定的目标也能明确出口
                    if let Some(rd) = &router_decision {
                        if let Some(target) = rd.split("=> route(").nth(1) {
                            let clean_target = target.trim_end_matches(')');
                            println!("✓ 规则分配目标   {clean_target}");
                        }
                    }
                }
            }
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
        println!("✗ HTTPS 首字节    {ms}ms (失败)");
        fails += 1;
    }

    fails
}
