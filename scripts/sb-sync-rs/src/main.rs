//! sb-sync — 客户端加密编码 + 服务端原生合并，双形态单二进制。
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
mod config;
mod crypto;
mod node;
mod paths;
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
        Some("keygen") => {
            let (sk, pk) = config::keygen();
            println!("SERVER_PRIVATE_KEY={sk}");
            println!("SERVER_PUBLIC_KEY={pk}");
            Ok(())
        }
        Some("version" | "--version" | "-V") => {
            println!("sb-sync {}", env!("CARGO_PKG_VERSION"));
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
        "sb-sync — 客户端加密编码 + 服务端原生合并",
        "",
        "  sb-sync encode -s <server> [-c <config.yaml>]   校验 YAML、加密生成订阅 URL 并写入剪切板",
        "  sb-sync trace <domain> [--api <127.0.0.1:9090>]  真机全链路探测: 系统解析/DNS判定/路由判定/链路/耗时",
        "  sb-sync check [-c <config.yaml>]               离线校验: 合并 overlay 到底模并跑内核 check, 打印生效摘要",
        "  sb-sync keygen                                 生成服务端 X25519 公私钥对（Hex）",
        "  sb-sync version                                显示版本",
    ]
    .join("\n")
}

/// encode 的参数解析，独立成函数以便单测（`cmd_encode` 自身会发网络请求）。
///
/// 服务端是具名选项 `-s/--server` 而非位置参数：两个选项顺序无关，
/// 未来新增选项时不会因位置变动而改调用方式。
fn parse_encode_args(rest: &[String]) -> Result<(String, Option<std::path::PathBuf>), String> {
    let usage_hint = "encode 用法: sb-sync encode -s <server> [-c <config.yaml>]";
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
    let usage_hint = "trace 用法: sb-sync trace <domain> [--api <127.0.0.1:9090>]";
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
    let controller = match api {
        Some(a) => Some(a),
        None => std::fs::read_to_string(legacy_config_path())
            .ok()
            .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
            .and_then(|v| trace::clash_controller(&v))
            .or_else(|| Some("127.0.0.1:9090".to_string())),
    };
    let fails = trace::trace(&domain, controller.as_deref());
    if fails > 0 {
        return Err(format!("{fails} 个阶段失败"));
    }
    Ok(())
}

/// check: 离线校验。读本机 YAML → 合并 overlay 到底模 → 内核 check → 打印生效摘要。
///
/// 补的是服务端才有的那一步：`sing-box check` 单独跑底模时，overlay 的 rule_set 引用
/// 完全不在视野内（引用一个不存在的 rule-set，本地不报错，SFM 启动才 FATAL）。
/// 这里在本地把 overlay 合并进去再 check，把那个 FATAL 提前到动手之前。
fn cmd_check(rest: &[String]) -> Result<(), String> {
    let usage_hint = "check 用法: sb-sync check [-c <config.yaml>]";
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
        _ => return Err("server 用法: sb-sync server [--port 8080]".into()),
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
        assert!(!u.contains("doctor"));
        assert!(!u.contains("sb-sync sync"));
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
}
