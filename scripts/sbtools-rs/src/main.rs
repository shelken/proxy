//! sbtools — 客户端加密编码 + 服务端原生合并，双形态单二进制。
//!
//! 客户端: encode（YAML → 加密 URL → 剪切板）；辅助: keygen。
//! 服务端: server（解密 → 装配 → 官方 sing-box merge → 响应）。

// 与 lib.rs 同一套门禁（bin 是独立 crate 根，属性不继承）
#![forbid(unsafe_code)]
#![deny(warnings)]
#![deny(clippy::all, clippy::pedantic)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#![deny(clippy::todo, clippy::unimplemented, clippy::dbg_macro)]
#![allow(clippy::missing_errors_doc, clippy::missing_panics_doc)]
#![allow(clippy::must_use_candidate, clippy::module_name_repetitions)]
#![allow(clippy::doc_markdown, clippy::cast_possible_truncation)]
#![allow(clippy::cast_precision_loss, clippy::cast_sign_loss)]
// CLI 的职责就是把结果打到 stdout，这里不能禁用打印
#![allow(clippy::print_stdout, clippy::print_stderr)]
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

mod assemble;
mod clashapi;
mod config;
mod crypto;
mod node;
mod paths;
mod redact;
mod server;
mod template;
mod trace;

use std::process::Command;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cmd = args.first().map(String::as_str);
    let rest: &[String] = args.get(1..).unwrap_or(&[]);

    let result = match cmd {
        Some("encode") => cmd_encode(rest),
        Some("server") => cmd_server(rest),
        Some("trace") => cmd_trace(rest),
        Some("check") => cmd_check(rest),
        Some("config") => cmd_config(rest),
        Some("logs") => cmd_logs(rest),
        Some("keygen") => {
            let (sk, pk) = config::keygen();
            println!("SERVER_PRIVATE_KEY={sk}");
            println!("SERVER_PUBLIC_KEY={pk}");
            Ok(())
        }
        Some("version" | "--version" | "-V") => {
            println!("sbtools {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        _ => {
            eprintln!("{}", usage());
            std::process::exit(i32::from(cmd.is_some()));
        }
    };
    if let Err(e) = result {
        eprintln!("ERROR: {e}");
        std::process::exit(1);
    }
}

fn usage() -> String {
    [
        "sbtools — 客户端加密编码 + 服务端原生合并",
        "",
        "  sbtools encode -s <server> [-c <config.yaml>]   校验 YAML、加密生成订阅 URL 并写入剪切板",
        "  sbtools trace <domain> [--api <127.0.0.1:9090>]  真机全链路探测: 解析/dns归属/内核判定/live归属/静态规则/耗时",
        "  sbtools check [-c <config.yaml>]               离线校验: 合并 overlay 到底模并跑内核 check, 打印生效摘要",
        "  sbtools config [--path <config.yaml|singbox.json>]  打印生效配置(隐私脱敏); SFM 可达时附 /configs 运行时摘要",
        "  sbtools logs [-f] [-n N] [--level debug|info|warn|error]  查看日志: -f 跟踪 /logs 流, -n N 读 log.output 末 N 行",
        "  sbtools keygen                                 生成服务端 X25519 公私钥对（Hex）",
        "  sbtools version                                显示版本",
    ]
    .join("\n")
}

/// encode 的参数解析，独立成函数以便单测（`cmd_encode` 自身会发网络请求）。
///
/// 服务端是具名选项 `-s/--server` 而非位置参数：两个选项顺序无关，
/// 未来新增选项时不会因位置变动而改调用方式。
fn parse_encode_args(rest: &[String]) -> Result<(String, Option<std::path::PathBuf>), String> {
    let usage_hint = "encode 用法: sbtools encode -s <server> [-c <config.yaml>]";
    let mut server: Option<String> = None;
    let mut config_path: Option<std::path::PathBuf> = None;

    let mut it = rest.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "-s" | "--server" => {
                server = Some(it.next().ok_or("encode: -s 需要一个服务端地址")?.clone());
            }
            "-c" | "--config" => {
                let p = it.next().ok_or("encode: -c 需要一个配置文件路径")?;
                config_path = Some(std::path::PathBuf::from(p));
            }
            other => return Err(format!("encode: 未知参数 {other}（{usage_hint}）")),
        }
    }
    Ok((server.ok_or(usage_hint)?, config_path))
}

/// encode: 读取 YAML → 取服务端公钥 → 加密 → URL → pbcopy。
fn cmd_encode(rest: &[String]) -> Result<(), String> {
    let (server, config_path) = parse_encode_args(rest)?;
    let server = config::normalize_server(&server)?;
    let config_path = match config_path {
        Some(p) => p,
        None => paths::client_config_path()?,
    };
    let config = config::load_config(&config_path)?;
    // 先本地校验（含 template_url 合法性），再做任何网络请求：
    // 配置写错时应在本地立刻报错，不该先浪费一次 /pubkey 往返
    let payload = config::validate(&config)?;
    // 公钥每次从服务端取：客户端只配 server，不再有需要手工同步的公钥字段
    let server_pk = config::fetch_server_public_key(&server)?;
    let ciphertext = config::encode_payload(&payload, &server_pk)?;
    let url = config::build_url(&server, &ciphertext)?;

    // 写剪切板（macOS pbcopy；非 macOS 环境失败不阻断，仅提示）
    match Command::new("pbcopy")
        .stdin(std::process::Stdio::piped())
        .spawn()
    {
        Ok(mut child) => {
            use std::io::Write;
            if let Some(stdin) = child.stdin.as_mut() {
                let _ = stdin.write_all(url.as_bytes());
            }
            let _ = child.wait();
            println!("✓ 订阅 URL 已复制到剪切板");
        }
        Err(_) => println!("（未找到 pbcopy，请手动复制下方 URL）"),
    }
    println!("{url}");
    Ok(())
}

/// 新架构无本地产物;SFM 场景产物在 SFM 组容器 configs/ 下。
/// 兼容旧路径 ~/.config/sing-box/singbox.json(存在则读其 clash_api 配置)。
fn legacy_config_path() -> std::path::PathBuf {
    std::path::PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
        .join(".config/sing-box/singbox.json")
}

/// trace: 真机全链路探测。--api 显式指定 Clash API,缺省读产物配置。
fn cmd_trace(rest: &[String]) -> Result<(), String> {
    let usage_hint = "trace 用法: sbtools trace <domain> [--api <127.0.0.1:9090>]";
    let mut domain: Option<String> = None;
    let mut api: Option<String> = None;
    let mut it = rest.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--api" => {
                api = Some(it.next().ok_or("trace: --api 需要一个地址")?.clone());
            }
            other if domain.is_none() && !other.starts_with('-') => {
                domain = Some(other.to_string());
            }
            other => return Err(format!("trace: 未知参数 {other}（{usage_hint}）")),
        }
    }
    let domain = domain.ok_or(usage_hint)?;
    let legacy = std::fs::read_to_string(legacy_config_path())
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok());
    let controller = resolve_trace_controller(api, legacy.as_ref())?;
    let fails = trace::trace(&domain, controller.as_deref());
    if fails > 0 {
        return Err(format!("{fails} 个阶段失败"));
    }
    Ok(())
}

/// trace 的 controller 解析。--api 显式指定总是放行；legacy 配置里有 controller 时
/// 回环放行、非回环显式拒绝（与 logs 同口径：回退缺省口会连上无关内核，如真机 SFM）；
/// 没有配置源才用缺省口。
fn resolve_trace_controller(
    api: Option<String>,
    legacy: Option<&serde_json::Value>,
) -> Result<Option<String>, String> {
    if let Some(a) = api {
        return Ok(Some(a));
    }
    match legacy.and_then(clashapi::configured_controller) {
        Some(c) if c.starts_with("127.0.0.1") => Ok(Some(c)),
        Some(c) => Err(format!(
            "trace: 配置的 clash api {c} 非回环地址，拒绝连接（回退缺省口会连上无关内核）；可用 --api 显式指定回环地址"
        )),
        None => Ok(Some("127.0.0.1:9090".to_string())),
    }
}

/// check: 离线校验。读本机 YAML → 合并 overlay 到底模 → 内核 check → 打印生效摘要。
///
/// 补的是服务端才有的那一步：`sing-box check` 单独跑底模时，overlay 的 rule_set 引用
/// 完全不在视野内（引用一个不存在的 rule-set，本地不报错，SFM 启动才 FATAL）。
/// 这里在本地把 overlay 合并进去再 check，把那个 FATAL 提前到动手之前。
fn cmd_check(rest: &[String]) -> Result<(), String> {
    let usage_hint = "check 用法: sbtools check [-c <config.yaml>]";
    let mut config_path: Option<std::path::PathBuf> = None;
    let mut it = rest.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "-c" | "--config" => {
                let p = it.next().ok_or("check: -c 需要一个配置文件路径")?;
                config_path = Some(std::path::PathBuf::from(p));
            }
            other => return Err(format!("check: 未知参数 {other}（{usage_hint}）")),
        }
    }
    let config_path = match config_path {
        Some(p) => p,
        None => paths::client_config_path()?,
    };
    let config = config::load_config(&config_path)?;
    // 复用 encode 的同一套 YAML 校验（含 overlay 安全审查与 template_url 合法性），
    // 但不做任何网络请求：check 的定位就是纯离线。
    let payload = config::validate(&config)?;

    let (base, source) = template::load_template(config.template_url.as_deref())?;
    let overlay = match &payload["overlay"] {
        serde_json::Value::Object(o) => Some(serde_json::Value::Object(o.clone())),
        _ => None,
    };
    let merged = server::merge_overlay(&base, overlay.as_ref())?;
    server::kernel_check(&merged)?;

    println!("✓ 内核 check 通过（底模: {}）", source.as_str());
    print!("{}", render_effective_summary(&merged));
    Ok(())
}

/// 渲染合并后真正生效的关键项。改 overlay 后不重贴 SFM 就看这个确认改动生效。
///
/// 纯函数（返回字符串而非直写 stdout），以便单测覆盖 merge 规范化后的形态差异。
fn render_effective_summary(merged: &serde_json::Value) -> String {
    /// sing-box merge 会把单元素数组规范化成标量，故两种形态都要认。
    fn as_list(v: &serde_json::Value) -> Option<String> {
        if let Some(s) = v.as_str() {
            return Some(s.to_string());
        }
        v.as_array().map(|a| {
            a.iter()
                .filter_map(|x| x.as_str())
                .collect::<Vec<_>>()
                .join(",")
        })
    }
    use std::fmt::Write as _;
    let mut out = String::new();
    let dns_rules = merged["dns"]["rules"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let _ = writeln!(out, "  dns.rules 条数: {}", dns_rules.len());
    for (i, r) in dns_rules.iter().enumerate() {
        let target = r["server"].as_str().unwrap_or("?");
        let what = [
            ("rule_set", "rule_set"),
            ("domain_suffix", "domain_suffix"),
            ("domain", "domain"),
            ("query_type", "query_type"),
            ("clash_mode", "clash_mode"),
        ]
        .iter()
        .find_map(|(k, label)| as_list(&r[*k]).map(|v| format!("{label}={v}")))
        .unwrap_or_else(|| "(其它匹配条件)".to_string());
        let _ = writeln!(out, "    [{i}] {what} -> {target}");
    }
    // merge 会把 `{"server": x}` 规范化成裸字符串，两种形态都要认。
    let resolver = merged["route"]["default_domain_resolver"]["server"]
        .as_str()
        .or_else(|| merged["route"]["default_domain_resolver"].as_str())
        .unwrap_or("?");
    let _ = writeln!(out, "  route.default_domain_resolver: {resolver}");
    let _ = writeln!(
        out,
        "  route.final: {}",
        merged["route"]["final"].as_str().unwrap_or("?")
    );
    let _ = writeln!(
        out,
        "  log.level: {}",
        merged["log"]["level"].as_str().unwrap_or("?")
    );
    out
}

/// config: 打印生效配置（隐私脱敏）。SFM 场景 profile 在组容器内、磁盘直读受限，
/// clash api 可达时补 /configs 运行时摘要，运行时观测指向 logs 与 trace。
fn cmd_config(rest: &[String]) -> Result<(), String> {
    let usage_hint = "config 用法: sbtools config [--path <config.yaml|singbox.json>]";
    let mut path: Option<std::path::PathBuf> = None;
    let mut it = rest.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--path" => {
                let p = it.next().ok_or("config: --path 需要一个配置文件路径")?;
                path = Some(std::path::PathBuf::from(p));
            }
            other => return Err(format!("config: 未知参数 {other}（{usage_hint}）")),
        }
    }

    // 磁盘读不到不立即报错：SFM 运行时可能仅有 clash api 可达（发现链降级）
    let disk = paths::discover_effective(path.as_deref());
    let disk_controller = match disk {
        Ok(eff) => {
            let outcome = load_and_print_redacted(&eff);
            match outcome {
                // controller 发现顺序与 logs 一致：顶层 → overlay，拿到的是原始值
                Ok(v) => v.as_ref().and_then(|v| {
                    clashapi::configured_controller(v).or_else(|| {
                        overlay_value(v).and_then(|o| clashapi::configured_controller(&o))
                    })
                }),
                // --path 是用户显式意图，读不到必须报错；发现链结果不可读才降级
                Err(e) if eff.explicit => return Err(e),
                Err(e) => {
                    println!("· 磁盘配置不可读: {e}");
                    None
                }
            }
        }
        Err(e) if path.is_some() => return Err(e),
        Err(e) => {
            println!("· 磁盘未找到生效配置: {e}");
            None
        }
    };

    // SFM 分支：磁盘读不到 profile 时运行时真相只在 clash api；缺省回环口与 trace 一致。
    // 配置了非回环 controller 时显式拒绝并跳过摘要，不静默回退缺省口——那会把
    // 缺省口上无关内核的 /configs 摘要张冠李戴（logs/trace 对此是硬报错，config
    // 的主功能是本地脱敏查看，拒绝探测即可，不挡主输出）。
    let disk_found = disk_controller.is_some();
    let controller = config_runtime_controller(disk_controller.as_deref());
    if let Some(controller) = &controller {
        if clashapi::reachable(controller) {
            print_runtime_summary(controller);
        } else if !disk_found {
            return Err(format!(
                "未找到生效配置，且 clash api {controller} 不可达；可用 --path 指定配置文件"
            ));
        }
    }
    Ok(())
}

/// config 的运行时摘要 controller：配置的 controller 非回环时拒绝（None）并提示，
/// 没配才用缺省回环口。
fn config_runtime_controller(raw: Option<&str>) -> Option<String> {
    match raw {
        Some(addr) if clashapi::is_loopback(addr) => Some(addr.to_string()),
        Some(addr) => {
            println!("· controller {addr} 非回环地址，已拒绝；跳过运行时摘要（clash_api 仅允许 127.0.0.1）");
            None
        }
        None => Some("127.0.0.1:9090".to_string()),
    }
}

/// 读取磁盘配置、打印脱敏 JSON，返回解析后的完整配置值。controller 的发现
/// （顶层 → overlay）与回环裁决都在调用方，与 logs 的解析顺序一致。
fn load_and_print_redacted(
    eff: &paths::EffectiveConfig,
) -> Result<Option<serde_json::Value>, String> {
    let text = std::fs::read_to_string(&eff.path)
        .map_err(|e| format!("读取 {}: {e}", eff.path.display()))?;
    let value = parse_config_text(&text, &eff.path)?;
    println!("✓ 生效配置: {}", eff.path.display());
    println!(
        "{}",
        serde_json::to_string_pretty(&redact::redact(&value))
            .map_err(|e| format!("序列化失败: {e}"))?
    );
    Ok(Some(value))
}

/// 按扩展名解析 YAML 或 JSON（legacy singbox.json 走严格 JSON，报错更准）。
fn parse_config_text(text: &str, path: &std::path::Path) -> Result<serde_json::Value, String> {
    if path
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("json"))
    {
        serde_json::from_str(text).map_err(|e| format!("JSON 解析失败（{}）: {e}", path.display()))
    } else {
        serde_yaml::from_str(text).map_err(|e| format!("YAML 解析失败（{}）: {e}", path.display()))
    }
}

/// SFM 运行时摘要。/configs 顶层键集经实测锚定: mode、mixed-port、tun、log-level。
fn print_runtime_summary(controller: &str) {
    match clashapi::get_json(controller, "/configs") {
        Ok(v) => {
            println!("✓ SFM 运行时 (clash api {controller}):");
            // SFM 实测 /configs 的 tun 可能为 null(未启用)，与键缺失(未上报)区分
            let tun = if v.get("tun").is_some_and(serde_json::Value::is_null) {
                Some("未启用".to_string())
            } else {
                v["tun"]["enable"].as_bool().map(|b| b.to_string())
            };
            let keys = [
                ("mode", v["mode"].as_str().map(String::from)),
                (
                    "mixed-port",
                    v["mixed-port"].as_u64().map(|n| n.to_string()),
                ),
                ("tun", tun),
                ("log-level", v["log-level"].as_str().map(String::from)),
            ];
            for (k, val) in keys {
                println!("  {k}: {}", val.as_deref().unwrap_or("未上报"));
            }
            println!("· SFM profile 磁盘直读受限，运行时观测请用 sbtools logs 与 sbtools trace");
        }
        Err(e) => println!("· clash api 可达但 /configs 读取失败: {e}"),
    }
}

/// logs: 查看日志。`-n N` 读 log.output 末 N 行，`-f` 跟踪 clash api /logs 流。
///
/// /logs 只吐连接后的新行、无回放（附录 A 探针二），回看只能走 log.output 文件；
/// SFM 磁盘直读受限，缺 log.output 时明示并退化 -f。Ctrl-C 走默认 SIGINT 终止。
fn cmd_logs(rest: &[String]) -> Result<(), String> {
    let usage_hint = "logs 用法: sbtools logs [-f] [-n N] [--level debug|info|warn|error]";
    let mut follow = false;
    let mut tail: Option<usize> = None;
    let mut level = "info".to_string();
    let mut it = rest.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "-f" => follow = true,
            "-n" => {
                let v = it.next().ok_or("logs: -n 需要一个行数")?;
                tail = Some(v.parse().map_err(|_| format!("logs: -n 非法行数: {v}"))?);
            }
            "--level" => {
                let lv = it.next().ok_or("logs: --level 需要一个级别")?;
                level.clone_from(lv);
            }
            other => return Err(format!("logs: 未知参数 {other}（{usage_hint}）")),
        }
    }
    if !matches!(level.as_str(), "debug" | "info" | "warn" | "error") {
        return Err(format!(
            "logs: --level 仅支持 debug|info|warn|error，当前: {level}"
        ));
    }

    // 生效配置解析一次：controller 与 overlay 的 log.output 都从这来。
    // 磁盘读不到不报错（SFM 场景降级走缺省回环口），与 cmd_config 一致。
    let eff = paths::discover_effective(None).ok();
    let eff_value = eff.as_ref().and_then(|e| {
        std::fs::read_to_string(&e.path)
            .ok()
            .and_then(|t| parse_config_text(&t, &e.path).ok())
    });

    let mut follow = follow || tail.is_none();
    if let Some(n) = tail {
        if let Some(path) = discover_log_output(eff_value.as_ref()).map(std::path::PathBuf::from) {
            println!("✓ log.output: {}", path.display());
            for line in tail_lines(&path, n)? {
                println!("{line}");
            }
        } else {
            println!(
                "· 未配置 log.output（legacy singbox.json 与 overlay 均无），退化 -f 跟踪 /logs 流"
            );
            follow = true;
        }
    }
    if follow {
        follow_logs(&resolve_logs_controller(eff_value.as_ref())?, &level)?;
    }
    Ok(())
}

/// logs 的 controller 发现：生效配置顶层 → 其 overlay（客户端 YAML 的 clash_api
/// 只会在 overlay 里）→ 缺省回环口（与 config/trace 一致）。
/// 配置里写了 controller 但未过回环守卫时显式报错，不静默回退——回退会连上
/// 缺省口上无关的内核（如真机 SFM），数据张冠李戴且有隐私暴露面。
fn resolve_logs_controller(eff_value: Option<&serde_json::Value>) -> Result<String, String> {
    fn rejected(addr: &str) -> String {
        format!("controller {addr} 非回环地址，已拒绝；clash_api 仅允许 127.0.0.1")
    }
    if let Some(v) = eff_value {
        if let Some(c) = clashapi::discover_controller(v) {
            return Ok(c);
        }
        if let Some(raw) = clashapi::configured_controller(v) {
            return Err(rejected(&raw));
        }
        if let Some(o) = overlay_value(v) {
            if let Some(c) = clashapi::discover_controller(&o) {
                return Ok(c);
            }
            if let Some(raw) = clashapi::configured_controller(&o) {
                return Err(rejected(&raw));
            }
        }
    }
    Ok("127.0.0.1:9090".to_string())
}

/// -f 跟踪 /logs 流，逐行打出 payload。
fn follow_logs(controller: &str, level: &str) -> Result<(), String> {
    use std::io::BufRead as _;
    if !clashapi::reachable(controller) {
        return Err(format!(
            "clash api {controller} 不可达；请确认内核已启动，\
             或检查 experimental.clash_api.external_controller 配置"
        ));
    }
    println!("✓ 跟踪 {controller} /logs?level={level}（Ctrl-C 退出）");
    let mut reader = clashapi::logs_stream(controller, level)?;
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => {
                eprintln!("· /logs 流已关闭");
                return Ok(());
            }
            Ok(_) => println!("{}", log_stream_payload(line.trim_end())),
            Err(e) => return Err(format!("/logs 读取中断: {e}")),
        }
    }
}

/// /logs 每行是 {"payload":"...","type":"..."}；形状异常时原样输出便于排查。
fn log_stream_payload(line: &str) -> String {
    serde_json::from_str::<serde_json::Value>(line)
        .ok()
        .and_then(|v| v["payload"].as_str().map(String::from))
        .unwrap_or_else(|| line.to_string())
}

/// JSON 值里的 log.output 路径。
fn log_output_from(value: &serde_json::Value) -> Option<String> {
    value["log"]["output"].as_str().map(String::from)
}

/// 客户端 YAML 的 overlay 是原生 sing-box JSON 文本；解析失败按无处理。
fn overlay_value(value: &serde_json::Value) -> Option<serde_json::Value> {
    serde_json::from_str(value["overlay"].as_str()?).ok()
}

/// log.output 读取顺序写死: legacy singbox.json 优先，其次客户端 config 的 overlay。
/// 客户端 YAML 顶层无 log 键（config.rs 的 ClientConfig 只有 subs/nodes/overlay/template_url）。
fn pick_log_output(
    legacy: Option<&serde_json::Value>,
    eff: Option<&serde_json::Value>,
) -> Option<String> {
    if let Some(p) = legacy.and_then(log_output_from) {
        return Some(p);
    }
    eff.and_then(overlay_value)
        .as_ref()
        .and_then(log_output_from)
}

/// 磁盘 IO 版: legacy singbox.json 现读，生效配置解析值由调用方传入。
fn discover_log_output(eff_value: Option<&serde_json::Value>) -> Option<String> {
    let legacy = std::fs::read_to_string(legacy_config_path())
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok());
    pick_log_output(legacy.as_ref(), eff_value)
}

/// 读文件末 N 行。日志量级为万行，全量读入足够；日志轮转由内核或外部负责。
fn tail_lines(path: &std::path::Path, n: usize) -> Result<Vec<String>, String> {
    let text =
        std::fs::read_to_string(path).map_err(|e| format!("读取 {}: {e}", path.display()))?;
    let lines: Vec<&str> = text.lines().collect();
    let start = lines.len().saturating_sub(n);
    Ok(lines[start..].iter().map(|s| (*s).to_string()).collect())
}

fn cmd_server(rest: &[String]) -> Result<(), String> {
    let port: u16 = match rest {
        [p] if p == "--port" || p == "-p" => return Err("server: --port 需要一个数字参数".into()),
        [flag, p] if flag == "--port" || flag == "-p" => {
            p.parse().map_err(|_| format!("非法端口: {p}"))?
        }
        [] => std::env::var("PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(8080),
        _ => return Err("server 用法: sbtools server [--port 8080]".into()),
    };
    server::run(port)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usage_lists_only_new_commands() {
        let u = usage();
        assert!(u.contains("encode"));
        assert!(u.contains("server"));
        assert!(u.contains("keygen"));
        assert!(u.contains("check"));
        assert!(u.contains("sbtools config [--path"));
        assert!(u.contains("sbtools logs [-f] [-n N]"));
        assert!(u.contains("解析/dns归属/内核判定/live归属/静态规则/耗时"));
        assert!(!u.contains("doctor"));
        assert!(!u.contains("sbtools sync"));
        assert!(u.contains("encode -s <server>"));
    }

    /// check 的摘要必须能读出 merge 规范化后的两种形态：
    /// 单元素数组 → 标量（`rule_set: ["Lan-dns"]` → `"Lan-dns"`）、
    /// `{"server": x}` → 裸字符串。读不到就会把生效项打成 `?`，摘要失去意义。
    #[test]
    fn effective_summary_reads_normalized_shapes() {
        let merged = serde_json::json!({
            "log": {"level": "debug"},
            "dns": {"rules": [
                {"rule_set": "Lan-dns", "server": "dns-local-system"},
                {"domain_suffix": ["ooooo.space"], "server": "dns-local-system"},
                {"query_type": ["A", "AAAA"], "server": "dns-fakeip"}
            ]},
            "route": {"final": "proxy", "default_domain_resolver": "dns-local-system"}
        });
        let out = render_effective_summary(&merged);
        assert!(out.contains("rule_set=Lan-dns"), "rule_set 未读出:\n{out}");
        assert!(out.contains("domain_suffix=ooooo.space"), "实际:\n{out}");
        assert!(out.contains("dns-local-system"), "实际:\n{out}");
        assert!(!out.contains('?'), "有读不出的字段:\n{out}");
    }

    fn args(s: &[&str]) -> Vec<String> {
        s.iter().map(|x| (*x).to_string()).collect()
    }

    #[test]
    fn encode_accepts_server_flag_in_any_position() {
        // -s 是具名选项：与 -c 的先后顺序不影响结果
        for rest in [
            args(&["-s", "https://a.example", "-c", "/tmp/x.yaml"]),
            args(&["-c", "/tmp/x.yaml", "-s", "https://a.example"]),
            args(&["--server", "https://a.example", "--config", "/tmp/x.yaml"]),
            args(&["-s", "https://a.example"]),
        ] {
            let (server, cfg) = parse_encode_args(&rest).expect("应解析成功");
            assert_eq!(server, "https://a.example");
            if rest.len() == 4 {
                assert_eq!(cfg.as_deref(), Some(std::path::Path::new("/tmp/x.yaml")));
            } else {
                assert!(cfg.is_none());
            }
        }
    }

    #[test]
    fn encode_rejects_missing_or_unknown_args() {
        // 位置参数被废弃：裸 <server> 必须报错，而不是被当作 server 接受
        assert!(parse_encode_args(&args(&["https://a.example"])).is_err());
        assert!(parse_encode_args(&args(&[])).is_err());
        // 选项缺值
        assert!(parse_encode_args(&args(&["-s"])).is_err());
        assert!(parse_encode_args(&args(&["-c"])).is_err());
        // 未知参数
        assert!(parse_encode_args(&args(&["-s", "https://a.example", "-x"])).is_err());
    }

    #[test]
    fn encode_last_flag_wins_on_duplicate() {
        // 重复给同一选项时后者覆盖（命令行惯例），避免静默取首个造成困惑
        let (server, cfg) = parse_encode_args(&args(&[
            "-s",
            "https://first.example",
            "-s",
            "https://second.example",
            "-c",
            "/tmp/a.yaml",
            "-c",
            "/tmp/b.yaml",
        ]))
        .expect("应解析成功");
        assert_eq!(server, "https://second.example");
        assert_eq!(cfg.as_deref(), Some(std::path::Path::new("/tmp/b.yaml")));
    }

    #[test]
    fn logs_rejects_unknown_level_and_bad_tail() {
        // 级别白名单之外必须拒绝（透传值会在 URL 里发往内核）
        assert!(cmd_logs(&args(&["--level", "verbose"])).is_err());
        assert!(cmd_logs(&args(&["-n", "abc"])).is_err());
        assert!(cmd_logs(&args(&["-n"])).is_err());
        assert!(cmd_logs(&args(&["--level"])).is_err());
        assert!(cmd_logs(&args(&["-x"])).is_err());
    }

    /// log.output 读取顺序写死: legacy singbox.json 优先，其次 overlay。
    /// 客户端 YAML 顶层无 log 键，log.output 只可能来自这两处。
    #[test]
    fn log_output_prefers_legacy_then_overlay() {
        let legacy = serde_json::json!({"log": {"output": "/tmp/legacy.log"}});
        let eff = serde_json::json!({"overlay": r#"{"log":{"output":"/tmp/overlay.log"}}"#});
        assert_eq!(
            pick_log_output(Some(&legacy), Some(&eff)).as_deref(),
            Some("/tmp/legacy.log")
        );
        // legacy 存在但无 log.output 时落到 overlay
        assert_eq!(
            pick_log_output(Some(&serde_json::json!({})), Some(&eff)).as_deref(),
            Some("/tmp/overlay.log")
        );
        // 两处均无 → 退化 -f 的判定输入
        assert_eq!(
            pick_log_output(Some(&serde_json::json!({})), Some(&serde_json::json!({}))),
            None
        );
        assert_eq!(pick_log_output(None, None), None);
        // overlay 不是合法 JSON 时按无处理
        let bad = serde_json::json!({"overlay": "not-json"});
        assert_eq!(pick_log_output(None, Some(&bad)), None);
    }

    #[test]
    fn tail_lines_returns_last_n_lines() {
        let path = std::env::temp_dir().join(format!("sbtools-tail-{}.log", std::process::id()));
        let content = (1..=30)
            .map(|i| format!("line-{i}"))
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(&path, content).unwrap();
        let last20 = tail_lines(&path, 20).unwrap();
        assert_eq!(last20.len(), 20);
        assert_eq!(last20[0], "line-11");
        assert_eq!(last20[19], "line-30");
        // N 超过总行数时全量返回，不 panic
        assert_eq!(tail_lines(&path, 100).unwrap().len(), 30);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn log_stream_line_yields_payload() {
        assert_eq!(
            log_stream_payload(r#"{"payload":"dns: exchanged A demo.test","type":"log"}"#),
            "dns: exchanged A demo.test"
        );
        // 形状异常时原样输出，便于排查
        assert_eq!(log_stream_payload("plain text"), "plain text");
    }

    #[test]
    fn logs_controller_rejects_non_loopback_instead_of_fallback() {
        // 客户端 YAML 顶层无 experimental，controller 在 overlay 里
        let eff = serde_json::json!({"overlay": r#"{"experimental":{"clash_api":{"external_controller":"127.0.0.1:19090"}}}"#});
        assert_eq!(
            resolve_logs_controller(Some(&eff)).unwrap(),
            "127.0.0.1:19090"
        );
        // 无任何 controller 时才回退缺省回环口（与 config/trace 一致）
        assert_eq!(
            resolve_logs_controller(Some(&serde_json::json!({}))).unwrap(),
            "127.0.0.1:9090"
        );
        assert_eq!(resolve_logs_controller(None).unwrap(), "127.0.0.1:9090");
        // 配置了非回环 controller 必须显式拒绝，不能静默回退连上缺省口的无关内核
        let err = resolve_logs_controller(Some(&serde_json::json!(
            {"experimental": {"clash_api": {"external_controller": "192.0.2.5:19090"}}}
        )))
        .unwrap_err();
        assert!(
            err.contains("192.0.2.5:19090") && err.contains("拒绝"),
            "实际: {err}"
        );
        // 顶层无、overlay 有非回环：同样拒绝
        let err = resolve_logs_controller(Some(&serde_json::json!(
            {"overlay": r#"{"experimental":{"clash_api":{"external_controller":"127.0.0.2:19090"}}}"#}
        )))
        .unwrap_err();
        assert!(
            err.contains("127.0.0.2:19090") && err.contains("拒绝"),
            "实际: {err}"
        );
    }

    /// trace 的 controller 解析与 logs 同口径：配置了非回环地址必须显式报错，
    /// 不得静默回退缺省口（会连上缺省口上无关内核）。
    #[test]
    fn trace_controller_rejects_non_loopback_instead_of_fallback() {
        // --api 显式指定总是放行
        assert_eq!(
            resolve_trace_controller(Some("127.0.0.1:19090".into()), None)
                .unwrap()
                .as_deref(),
            Some("127.0.0.1:19090")
        );
        // legacy 配置有回环 controller → 采用
        let cfg = serde_json::json!({"experimental":{"clash_api":{"external_controller":"127.0.0.1:19090"}}});
        assert_eq!(
            resolve_trace_controller(None, Some(&cfg))
                .unwrap()
                .as_deref(),
            Some("127.0.0.1:19090")
        );
        // 非回环 → 显式报错且含被拒地址
        let cfg = serde_json::json!({"experimental":{"clash_api":{"external_controller":"192.0.2.5:9090"}}});
        let err = resolve_trace_controller(None, Some(&cfg)).unwrap_err();
        assert!(
            err.contains("192.0.2.5:9090") && err.contains("拒绝"),
            "实际: {err}"
        );
        // 无配置源 → 缺省口
        assert_eq!(
            resolve_trace_controller(None, None).unwrap().as_deref(),
            Some("127.0.0.1:9090")
        );
    }

    /// config 的运行时摘要 controller 与 logs/trace 同口径：配置了非回环地址
    /// 必须显式拒绝并跳过摘要，不能静默回退缺省口连上无关内核；没配才用缺省。
    #[test]
    fn config_runtime_controller_拒绝非回环不回退缺省() {
        assert!(config_runtime_controller(Some("192.0.2.5:19090")).is_none());
        assert_eq!(
            config_runtime_controller(Some("127.0.0.1:19090")).as_deref(),
            Some("127.0.0.1:19090")
        );
        assert_eq!(
            config_runtime_controller(None).as_deref(),
            Some("127.0.0.1:9090")
        );
    }
}
