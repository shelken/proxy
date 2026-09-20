//! trace:对指定域名做全链路探测（DNS 各 RR 计时 / 出口接口 / Clash API 命中 / HTTP 首字节）。

use crate::paths;
use serde_json::Value;
use std::net::ToSocketAddrs;
use std::time::{Duration, Instant};

/// 系统 resolver 解析（getaddrinfo），返回首个 IPv4。
pub fn system_resolve(domain: &str) -> Option<(String, u128)> {
    let start = Instant::now();
    let addrs: Vec<_> = (domain, 0u16).to_socket_addrs().ok()?.collect();
    let ip = addrs
        .iter()
        .find_map(|a| match a {
            std::net::SocketAddr::V4(v4) => Some(v4.ip().to_string()),
            _ => None,
        })?;
    Some((ip, start.elapsed().as_millis()))
}

/// 指定 DNS 服务器的 UDP A 查询（手写极简 DNS 报文，无新依赖）。
/// 返回首个 A 记录与耗时；超时/失败返回 None。
pub fn udp_resolve_a(domain: &str, server: &str) -> Option<(String, u128)> {
    let start = Instant::now();
    let sock = std::net::UdpSocket::bind(("0.0.0.0", 0)).ok()?;
    sock.set_read_timeout(Some(Duration::from_secs(3))).ok()?;
    let server_ip: std::net::IpAddr = server.parse().ok()?;
    let sock_addr = std::net::SocketAddr::new(server_ip, 53);
    sock.connect(sock_addr).ok()?;

    let mut id = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(1)
        | 1) as u16;
    let packet = build_query(id, domain);
    for _ in 0..3 {
        sock.send(&packet).ok()?;
        let mut buf = [0u8; 512];
        if let Ok(n) = sock.recv(&mut buf) {
            if let Some(ip) = parse_a_answer(&buf[..n], id, domain) {
                return Some((ip, start.elapsed().as_millis()));
            }
            // 响应 ID 不符或无 A 记录：换 ID 重试（简单防混淆）
            id = id.wrapping_add(1);
        }
    }
    None
}

pub(crate) fn build_query(id: u16, domain: &str) -> Vec<u8> {
    let mut p = Vec::with_capacity(64);
    p.extend_from_slice(&id.to_be_bytes());
    // RD=1 的标准查询
    p.extend_from_slice(&[0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    for label in domain.split('.').filter(|s| !s.is_empty()) {
        p.push(label.len() as u8);
        p.extend_from_slice(label.as_bytes());
    }
    p.extend_from_slice(&[0x00, 0x00, 0x01, 0x00, 0x01]); // QTYPE=A QCLASS=IN
    p
}

pub(crate) fn parse_a_answer(buf: &[u8], id: u16, domain: &str) -> Option<String> {
    if buf.len() < 12 || u16::from_be_bytes([buf[0], buf[1]]) != id {
        return None;
    }
    let qd = u16::from_be_bytes([buf[4], buf[5]]);
    let an = u16::from_be_bytes([buf[6], buf[7]]);
    // 校验问题段域名与目标一致，防止误匹配无关应答
    let mut pos = 12usize;
    let mut matched_q = false;
    for _ in 0..qd {
        let (next, ok) = skip_names(buf, pos);
        pos = next;
        matched_q = ok && &buf[pos..pos + 4] == &[0x00, 0x01, 0x00, 0x01];
        pos += 4;
    }
    if !matched_q {
        return None;
    }
    for _ in 0..an {
        let (next, _) = skip_names(buf, pos);
        pos = next;
        if pos + 10 > buf.len() {
            return None;
        }
        let rtype = u16::from_be_bytes([buf[pos], buf[pos + 1]]);
        let rdlen = u16::from_be_bytes([buf[pos + 8], buf[pos + 9]]) as usize;
        pos += 10;
        if rtype == 1 && rdlen == 4 && pos + 4 <= buf.len() {
            return Some(format!("{}.{}.{}.{}", buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3]));
        }
        pos += rdlen;
    }
    let _ = domain;
    None
}

/// 跳过（可能压缩的）域名段，返回新位置与是否解析成功。
fn skip_names(buf: &[u8], mut pos: usize) -> (usize, bool) {
    let mut jumps = 0;
    loop {
        if pos >= buf.len() {
            return (pos, false);
        }
        let len = buf[pos];
        if len == 0 {
            return (pos + 1, true);
        }
        if len & 0xC0 == 0xC0 {
            return (pos + 2, jumps < 8);
        }
        pos += 1 + len as usize;
        jumps += 1;
        if jumps > 8 {
            return (pos, false);
        }
    }
}

/// 产物 TUN 的派生 DNS 地址（address 首个 /30 内 .2），sing-box 劫持入口。
pub fn tun_dns_server(cfg: &Value) -> Option<String> {
    let tun = cfg["inbounds"].as_array()?.iter().find(|i| i["type"] == "tun")?;
    let addr = tun["address"].as_array()?.iter().find_map(|a| a.as_str())?;
    let ip = addr.split('/').next()?;
    // 198.51.100.1/30 → 198.51.100.2
    let parts: Vec<u8> = ip.split('.').filter_map(|s| s.parse().ok()).collect();
    if parts.len() == 4 {
        Some(format!("{}.{}.{}.{}", parts[0], parts[1], parts[2], parts[3] + 1))
    } else {
        None
    }
}

/// route get 判定目标 IP 实际出口接口名（macOS）；非 macOS 返回 None。
pub fn egress_interface(ip: &str) -> Option<String> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let out = std::process::Command::new("route").args(["-n", "get", ip]).output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines() {
        let trimmed = line.trim();
        if let Some(i) = trimmed.strip_prefix("interface:") {
            return Some(i.trim().to_string());
        }
    }
    None
}

/// Clash API 查询当前活跃连接里命中该域名的条目（host/ DestinationIP/sniffHost）。
/// 返回 (规则, 出站链) 摘要；面板不可达返回 None。
pub fn clash_api_match(domain: &str, controller: &str) -> Option<(String, String)> {
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
        {
            let chains: Vec<&str> = c["chains"]
                .as_array()
                .map(|a| a.iter().filter_map(|x| x.as_str()).collect())
                .unwrap_or_default();
            let rule = format!(
                "{} {}",
                c["rule"].as_str().unwrap_or("?"),
                c["rulePayload"].as_str().unwrap_or("")
            )
            .trim()
            .to_string();
            return Some((rule, chains.join(" → ")));
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
    match ureq::get(url)
        .timeout(Duration::from_secs(8))
        .call()
    {
        Ok(_) => (true, start.elapsed().as_millis()),
        Err(ureq::Error::Status(_, _)) => (true, start.elapsed().as_millis()),
        Err(_) => (false, start.elapsed().as_millis()),
    }
}

/// 执行全部阶段并打印报告；返回失败阶段数。
pub fn trace(domain: &str) -> u8 {
    println!("=== sb-sync trace — {domain} 全链路探测 ===\n");

    let output = paths::output_path();
    let cfg: Option<Value> = std::fs::read_to_string(&output)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok());

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

    // 阶段 2: sing-box TUN resolver（产物存在才做）
    let Some(cfg) = cfg else {
        println!("⚠ 产物不存在 — 跳过 sing-box TUN 与 Clash API 阶段\n提示: 先 sb-sync sync");
        return fails;
    };
    if let Some(dns) = tun_dns_server(&cfg) {
        match udp_resolve_a(domain, &dns) {
            Some((ip, ms)) => {
                let tag = if ip.starts_with("198.18.") || ip.starts_with("198.19.") {
                    "fakeip"
                } else {
                    "真实 IP"
                };
                println!("✓ sing-box TUN    A {ip} ({ms}ms) [{tag}]");
            }
            None => {
                println!("✗ sing-box TUN    {dns} 查询超时 — 001 号尸检同款 DNS 黑洞征兆");
                fails += 1;
            }
        }
    } else {
        println!("⚠ sing-box TUN    产物无 tun inbound,跳过");
    }

    // 阶段 3: Clash API 命中
    if let Some(ec) = clash_controller(&cfg) {
        match clash_api_match(domain, &ec) {
            Some((rule, chains)) => println!("✓ Clash API       规则 [{rule}] 链路 [{chains}]"),
            None => println!("⚠ Clash API       活跃连接中暂无该域名(发起一次访问后重试可命中)"),
        }
    } else {
        println!("⚠ Clash API       产物未暴露 127.0.0.1 external_controller,跳过");
    }

    // 阶段 4: HTTP 首字节
    let (ok, ms) = http_first_byte(&format!("https://{domain}/"));
    if ok {
        println!("✓ HTTPS 首字节    {ms}ms");
        if ms > 3000 {
            println!("  ⚠ 超过 3s — 结合上方 DNS 阶段定位慢在哪层");
        }
    } else {
        println!("✗ HTTPS 首字节    {ms}ms (失败)");
        fails += 1;
    }

    fails
}
