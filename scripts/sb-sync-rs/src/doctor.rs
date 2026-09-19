//! doctor：网络分层自检（配置层 / DNS 解析链 / 三站点计时），定位"慢在哪一层"。

use crate::detect;
use crate::paths;
use serde_json::Value;
use std::net::ToSocketAddrs;
use std::time::Instant;

struct ProbeResult {
    name: String,
    ok: bool,
    detail: String,
    ms: u128,
}

/// DNS 解析链探测：走系统栈解析固定域（应答快 = 链路活；超时 = 001 号尸检同款黑洞征兆）。
fn probe_dns() -> ProbeResult {
    let start = Instant::now();
    let ok = "example.com:53".to_socket_addrs().is_ok();
    let ms = start.elapsed().as_millis();
    ProbeResult {
        name: "DNS 解析链 (系统解析器→内核)".into(),
        ok,
        detail: if ok {
            "系统栈解析成功".into()
        } else {
            "超时/无应答 — 解析路径黑洞(参照 001-tun-exclude-dns-blackhole)".into()
        },
        ms,
    }
}

/// 站点探测：DNS+TCP+TLS+首字节计时。
fn probe_site(name: &str, url: &str) -> ProbeResult {
    let start = Instant::now();
    let (ok, detail) = match ureq::request("HEAD", url).call() {
        Ok(res) => (res.status() < 500, format!("HTTP {}", res.status())),
        Err(e) => (false, format!("失败: {e}")),
    };
    ProbeResult {
        name: name.into(),
        ok,
        detail,
        ms: start.elapsed().as_millis(),
    }
}

/// 系统解析器地址（macOS scutil）。非 macOS 或解析失败返回 None。
fn system_resolver() -> Option<String> {
    let out = std::process::Command::new("scutil").arg("--dns").output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines() {
        if let Some(idx) = line.find("nameserver[0]") {
            if let Some(addr) = line[idx..].split(':').nth(1) {
                return Some(addr.trim().to_string());
            }
        }
    }
    None
}

/// 解析器地址是否落在 CIDR 内（001 号尸检的网段包含判定）。
fn ip_in_cidr(ip: &str, cidr: &str) -> Option<bool> {
    let (net, bits) = cidr.split_once('/')?;
    let bits: u32 = bits.parse().ok()?;
    let parse_ip = |s: &str| -> Option<u32> {
        let octets: Vec<u8> = s.split('.').filter_map(|o| o.parse().ok()).collect();
        (octets.len() == 4).then(|| {
            (u32::from(octets[0]) << 24)
                | (u32::from(octets[1]) << 16)
                | (u32::from(octets[2]) << 8)
                | u32::from(octets[3])
        })
    };
    let ip_num = parse_ip(ip)?;
    let net_num = parse_ip(net)?;
    let mask = if bits == 0 { 0 } else { u32::MAX << (32 - bits) };
    Some((ip_num & mask) == (net_num & mask))
}

/// TUN 网段冲突检查（001 号尸检根因固化进 check）：
/// 1) TUN address 与 route_exclude_address 有交集 → exclude 优先级更高，
///    TUN 自身劫持网段被排除 → 劫持地址不可达 → 系统 DNS 黑洞。
/// 2) TUN 网段落在私有段（10/8、172.16/12、192.168/16、100.64/10）→ 同类病根。
/// 返回错误列表；空列表 = 无冲突。
pub fn tun_conflicts(cfg: &Value) -> Vec<String> {
    const PRIVATE_V4: [&str; 4] = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10"];
    let tun = cfg["inbounds"]
        .as_array()
        .and_then(|a| a.iter().find(|i| i["type"] == "tun"));
    let Some(tun) = tun else { return Vec::new() };
    let tun_nets: Vec<&str> = tun["inet4_address"]
        .as_array()
        .or_else(|| tun["address"].as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str()).collect())
        .unwrap_or_default();
    if tun_nets.is_empty() {
        return Vec::new();
    }
    let excludes: Vec<&str> = tun["route_exclude_address"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str()).collect())
        .unwrap_or_default();

    let mut errs = Vec::new();
    for net in &tun_nets {
        let base = net.split_once('/').map(|(b, _)| b).unwrap_or(net);
        for ex in &excludes {
            if ip_in_cidr(base, ex).unwrap_or(false) {
                errs.push(format!(
                    "TUN 网段 {net} 被自身 route_exclude_address {ex} 覆盖 (001 号尸检同款黑洞!)"
                ));
            }
        }
        for p in &PRIVATE_V4 {
            if ip_in_cidr(base, p).unwrap_or(false) {
                errs.push(format!("TUN 网段 {net} 落在私有段 {p} 内，与内网/Tailscale 路由冲突"));
            }
        }
    }
    errs
}

/// 配置层检查：sing-box check（有内核才做）+ 系统解析器网段判定。
fn config_layer(cfg: Option<&Value>) -> Vec<String> {
    let mut lines = Vec::new();
    match detect::detect() {
        detect::Kernel::Cli(bin) => {
            let output = paths::output_path();
            match std::process::Command::new(&bin).args(["check", "-c"]).arg(&output).output() {
                Ok(o) if o.status.success() => lines.push("[配置] sing-box check: ✓ 通过".into()),
                Ok(o) => {
                    let err = String::from_utf8_lossy(&o.stderr).trim().to_string();
                    lines.push(format!("[配置] sing-box check: ✗ {err}"));
                }
                Err(e) => lines.push(format!("[配置] sing-box check: ✗ 执行失败 {e}")),
            }
        }
        detect::Kernel::PanelOnline(v) => {
            lines.push(format!("[配置] sing-box check: 跳过（SFM 在线 {v}，无文件校验能力）"));
        }
        detect::Kernel::None => {
            lines.push("[配置] sing-box check: 跳过（无内核）".into());
        }
    }

    if let Some(addr) = system_resolver() {
        let excluded: Vec<Value> = cfg
            .and_then(|c| {
                c["inbounds"].as_array().cloned().map(|inbounds| {
                    inbounds
                        .iter()
                        .find(|i| i["type"] == "tun" || i.get("route_exclude_address").is_some())
                        .map(|i| i["route_exclude_address"].clone())
                        .unwrap_or(Value::Null)
                })
            })
            .and_then(|e| e.as_array().cloned())
            .unwrap_or_default();
        let in_exclude = excluded
            .iter()
            .filter_map(|c| c.as_str())
            .filter_map(|c| ip_in_cidr(&addr, c))
            .any(|b| b);
        lines.push(format!(
            "[配置] 系统解析器 {addr}{}",
            if in_exclude {
                "  ✗ 落在 route_exclude_address 内 (001 号尸检同款黑洞!)".to_string()
            } else {
                "  ✓ 不在排除段".to_string()
            }
        ));
    }
    lines
}

/// doctor 入口：失败进程退出码 1。
pub fn run() {
    println!("=== sb-sync doctor — 网络分层自检 ===\n");

    let output = paths::output_path();
    let cfg: Option<Value> = std::fs::read_to_string(&output)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok());
    if cfg.is_none() {
        println!("⚠ 产物不存在 — 先 sb-sync sync。仅做网络自检:\n");
    }
    for line in config_layer(cfg.as_ref()) {
        println!("{line}");
    }
    println!();

    let mut results = vec![probe_dns()];
    results.push(probe_site("直连站点 (baidu.com)", "https://www.baidu.com/"));
    results.push(probe_site("代理站点 (google.com)", "https://www.google.com/generate_204"));
    results.push(probe_site("图片 CDN (pbs.twimg.com)", "https://pbs.twimg.com/favicon.ico"));

    for r in &results {
        println!(
            "{} {}  —  {}  ({}ms){}",
            if r.ok { "✓" } else { "✗" },
            r.name,
            r.detail,
            r.ms,
            if r.ms > 3000 { "  ⚠ 超过 3s" } else { "" }
        );
    }

    let failed = results.iter().filter(|r| !r.ok).count();
    let slow = results.iter().any(|r| r.ms > 3000);
    println!(
        "\n结论: {}{}",
        if failed == 0 { "全部正常".to_string() } else { format!("{failed} 项失败") },
        if slow { " | 注意: 存在 3s+ 慢项" } else { "" }
    );
    if failed > 0 {
        std::process::exit(1);
    }
}
