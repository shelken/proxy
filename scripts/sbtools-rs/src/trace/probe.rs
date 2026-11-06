//! 连接与探针：`/connections` 解析、CONNECT / range 探针、系统解析与首字节计时。
//!
//! 存续连接的 rule 串与 chains 是路由归属最可靠的来源；探针必须在连接存续期
//! 轮询 /connections，连接关闭即被 GC。

use serde_json::Value;
use std::net::ToSocketAddrs;
use std::time::{Duration, Instant};

use super::effective_config;

/// 系统 resolver 解析（getaddrinfo），返回首个 IPv4。
pub(super) fn system_resolve(domain: &str) -> Option<String> {
    let addrs: Vec<_> = (domain, 0u16).to_socket_addrs().ok()?.collect();
    addrs.iter().find_map(|a| match a {
        std::net::SocketAddr::V4(v4) => Some(v4.ip().to_string()),
        std::net::SocketAddr::V6(_) => None,
    })
}

/// /connections 中目标域名的匹配条目：rule 串与出站链。
#[derive(Debug, Clone)]
pub(super) struct ConnMatch {
    pub(super) rule: String,
    pub(super) chains: Vec<String>,
}

/// /connections 的 host/sniffHost 是否归属目标域名：自身或点边界的子域，
/// 与 dns 后缀语义一致，`notdemo.test` 不得命中 `demo.test`。
fn conn_host_matches(host: &str, domain: &str) -> bool {
    let host = host.to_ascii_lowercase();
    let domain = domain.to_ascii_lowercase();
    host == domain || host.ends_with(&format!(".{domain}"))
}

/// 解析 /connections 响应，取 metadata.host/sniffHost/destinationIP 匹配目标域名的条目。
/// 纯函数，/connections 响应解析的单测落在这里。
fn parse_conn_match(v: &Value, domain: &str) -> Option<ConnMatch> {
    let conns = v["connections"].as_array()?;
    for c in conns {
        let host = c["metadata"]["host"].as_str().unwrap_or("");
        let sniff = c["metadata"]["sniffHost"].as_str().unwrap_or("");
        let dst = c["metadata"]["destinationIP"].as_str().unwrap_or("");
        let hit =
            conn_host_matches(host, domain) || conn_host_matches(sniff, domain) || dst == domain;
        if !hit {
            continue;
        }
        let chains: Vec<String> = c["chains"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        if chains.is_empty() {
            continue;
        }
        return Some(ConnMatch {
            rule: c["rule"].as_str().unwrap_or("").to_string(),
            chains,
        });
    }
    None
}

/// 拉取 /connections 并解析。live 归属段的轮询与既有出站链路段共用这一套读取，
/// 不另写第二套。
fn conn_match(domain: &str, controller: &str) -> Option<ConnMatch> {
    let v = crate::clashapi::get_connections(controller).ok()?;
    parse_conn_match(&v, domain)
}

/// 生效配置里 mixed 入站的显式回环监听端口。与 controller 守卫同一纪律：非回环不用。
fn mixed_loopback_port(cfg: &Value) -> Option<u16> {
    cfg["inbounds"]
        .as_array()?
        .iter()
        .filter(|ib| ib["type"].as_str() == Some("mixed"))
        .filter(|ib| matches!(ib["listen"].as_str(), Some("127.0.0.1" | "localhost")))
        .find_map(|ib| {
            ib["listen_port"]
                .as_u64()
                .map(|p| p as u16)
                .filter(|p| *p > 0)
        })
}

/// CONNECT 探针：经 mixed 入站对目标发起 `CONNECT {domain}:443` 并把隧道握在本进程
/// 手里到 hold 期满。隧道握住即内核侧连接存续，不依赖目标服务器配合，也不依赖 TUN
/// 在场。线程自限，发完即忘。
fn spawn_connect_probe(target: String, port: u16, hold: Duration) {
    std::thread::spawn(move || {
        use std::io::{Read, Write};
        let start = Instant::now();
        let Ok(mut sock) = std::net::TcpStream::connect(("127.0.0.1", port)) else {
            return;
        };
        let _ = sock.set_read_timeout(Some(hold));
        let req = format!("CONNECT {target}:443 HTTP/1.1\r\nHost: {target}:443\r\n\r\n");
        if sock.write_all(req.as_bytes()).is_err() {
            return;
        }
        // 成功回 200；拨号失败立刻回 502 并关闭；拨号挂起读到超时。之后一律握住到期满。
        let mut buf = [0u8; 1024];
        let _ = sock.read(&mut buf);
        let rest = hold.saturating_sub(start.elapsed());
        if !rest.is_zero() {
            std::thread::sleep(rest);
        }
    });
}

/// range 探针：直连发起 range 长下载，靠 TUN 进内核。用于生效配置读不到（SFM）时。
fn spawn_range_probe(target: String) {
    std::thread::spawn(move || {
        let _ = crate::clashapi::agent_with_timeout(Duration::from_secs(4))
            .get(&format!("https://{target}/"))
            .header("Range", "bytes=0-104857600")
            .call();
    });
}

/// live 路由归属：发起一条经内核的连接，存续期轮询 /connections 抓 rule 串与链路。
///
/// 探针四的教训：连接关闭即被 GC，轮询必须发生在存续期。探针优先走 mixed 入站
/// （CONNECT 隧道握在本进程手里，存续窗确定）；生效配置读不到时退化为直连 range
/// 下载，靠 TUN 进内核。
pub(super) fn live_attribution(domain: &str, controller: &str) -> Option<ConnMatch> {
    const WINDOW: Duration = Duration::from_millis(1200);
    match effective_config().as_ref().and_then(mixed_loopback_port) {
        Some(port) => spawn_connect_probe(domain.to_string(), port, WINDOW),
        None => spawn_range_probe(domain.to_string()),
    }
    let start = Instant::now();
    loop {
        if let Some(m) = conn_match(domain, controller) {
            return Some(m);
        }
        if start.elapsed() >= WINDOW {
            return None;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// HTTP GET 首字节计时（经系统网络栈，即真实用户路径）。
pub(super) fn http_first_byte(url: &str) -> (bool, u128) {
    let start = Instant::now();
    match crate::clashapi::agent_with_timeout(Duration::from_secs(8))
        .get(url)
        .call()
    {
        Ok(_) | Err(ureq::Error::StatusCode(_)) => (true, start.elapsed().as_millis()),
        Err(_) => (false, start.elapsed().as_millis()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 附录 A 探针四的单条 /connections 形状。
    fn conn_fixture() -> Value {
        serde_json::json!({
            "connections": [{
                "chains": ["direct"],
                "metadata": {"host": "demo.test", "dnsMode": "normal", "destinationIP": "203.0.113.1"},
                "rule": "domain_suffix=demo.test => route(direct)",
                "rulePayload": ""
            }]
        })
    }
    #[test]
    fn parse_conn_match_reads_rule_and_chains() {
        let m = parse_conn_match(&conn_fixture(), "demo.test").expect("应命中");
        assert_eq!(m.rule, "domain_suffix=demo.test => route(direct)");
        assert_eq!(m.chains, vec!["direct".to_string()]);
        // 别的域名不命中
        assert!(parse_conn_match(&conn_fixture(), "other.test").is_none());
        // 空 connections 不命中
        assert!(parse_conn_match(&serde_json::json!({}), "demo.test").is_none());
    }

    /// /connections 的后缀命中必须带点边界，与 dns 后缀语义一致：
    /// 自身与子域命中，`notdemo.test` 对 `demo.test` 不命中。
    #[test]
    fn parse_conn_match_requires_dot_boundary() {
        let sub = serde_json::json!({"connections": [{
            "chains": ["direct"],
            "metadata": {"host": "a.demo.test"},
            "rule": "domain_suffix=demo.test => route(direct)"
        }]});
        assert!(parse_conn_match(&sub, "demo.test").is_some(), "子域应命中");

        let glued = serde_json::json!({"connections": [{
            "chains": ["direct"],
            "metadata": {"host": "notdemo.test"},
            "rule": "domain_suffix=demo.test => route(direct)"
        }]});
        assert!(
            parse_conn_match(&glued, "demo.test").is_none(),
            "前缀粘连不应命中"
        );
    }

    /// host 为空时按 sniffHost 后缀回退命中；chains 全量保留。
    #[test]
    fn parse_conn_match_falls_back_to_sniff_host() {
        let v = serde_json::json!({
            "connections": [{
                "chains": ["proxy", "selfhost"],
                "metadata": {"host": "", "sniffHost": "speed.demo.test"},
                "rule": "domain_suffix=demo.test => route(proxy)"
            }]
        });
        let m = parse_conn_match(&v, "demo.test").expect("sniffHost 应命中");
        assert_eq!(m.rule, "domain_suffix=demo.test => route(proxy)");
        assert_eq!(m.chains, vec!["proxy".to_string(), "selfhost".to_string()]);
    }

    /// 探针只走显式回环的 mixed 入站，与 controller 守卫同一纪律。
    #[test]
    fn mixed_loopback_port_requires_explicit_loopback() {
        let cfg = serde_json::json!({"inbounds": [
            {"type": "tun"},
            {"type": "mixed", "listen": "127.0.0.1", "listen_port": 19081}
        ]});
        assert_eq!(mixed_loopback_port(&cfg), Some(19081));
        let cfg = serde_json::json!({"inbounds": [
            {"type": "mixed", "listen": "0.0.0.0", "listen_port": 19081}
        ]});
        assert_eq!(mixed_loopback_port(&cfg), None);
        assert_eq!(mixed_loopback_port(&serde_json::json!({})), None);
    }
}
