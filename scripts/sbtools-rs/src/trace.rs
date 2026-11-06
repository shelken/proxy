//! trace: 对指定域名做全链路探测（系统解析 / 内核 DNS 判定 / 路由判定 / 拨号证据 / 首字节耗时）。
//!
//! 报告是「第一行结论 + 一条因果链」：解析 → DNS → 拨号 → 路由 → 连通。
//! 事实收集（`collect_facts`，唯一的 IO 段）与文本渲染（`render`，纯函数）分开，
//! 渲染可以不碰网络地逐字单测。
//!
//! DNS 与路由判定只认内核 debug 日志流与 /connections，不做本地推演：
//! 内核视角即真相。日志关联靠请求号，`dns: match[N]` 行不带域名，
//! 由相邻的 exchange/exchanged 行回填归属。
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
fn system_resolve(domain: &str) -> Option<String> {
    let addrs: Vec<_> = (domain, 0u16).to_socket_addrs().ok()?.collect();
    addrs.iter().find_map(|a| match a {
        std::net::SocketAddr::V4(v4) => Some(v4.ip().to_string()),
        std::net::SocketAddr::V6(_) => None,
    })
}

/// 内核决策捕获结果
#[derive(Default, Clone, Debug)]
struct KernelDecisions {
    dns_match: Option<String>,
    router_match: Option<String>,
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

// ===== live 路由归属 =====

/// /connections 中目标域名的匹配条目：rule 串与出站链。
#[derive(Debug, Clone)]
struct ConnMatch {
    rule: String,
    chains: Vec<String>,
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

/// 读取生效配置（统一 load_effective：客户端 YAML 的原生配置在 overlay 里）。
/// SFM 等磁盘不可达场景返回 None，调用方明示跳过，不算失败。
fn effective_config() -> Option<Value> {
    let eff = crate::config::load_effective(None).ok()?;
    Some(eff.overlay.unwrap_or(eff.root))
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
fn live_attribution(domain: &str, controller: &str) -> Option<ConnMatch> {
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
pub fn http_first_byte(url: &str) -> (bool, u128) {
    let start = Instant::now();
    match crate::clashapi::agent_with_timeout(Duration::from_secs(8))
        .get(url)
        .call()
    {
        Ok(_) | Err(ureq::Error::StatusCode(_)) => (true, start.elapsed().as_millis()),
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

fn is_excluded(ip: &str) -> bool {
    EXCLUDE_ADDRESS.iter().any(|c| in_range(ip, c))
}

fn is_fakeip(ip: &str) -> bool {
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

/// Clash API 是否可达（`/version` 探活）。控制面不通时后续阶段全无意义，必须显式报错。
pub fn controller_reachable(controller: &str) -> bool {
    crate::clashapi::reachable(controller)
}

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

    if controller_reachable(controller) {
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

    // ===== PR4：/connections 解析与 dns 推演（夹具全合成，零真实数据）=====

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
