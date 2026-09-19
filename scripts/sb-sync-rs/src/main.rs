//! sb-sync — 设备侧 sing-box 配置同步 CLI。

mod assemble;
mod detect;
mod doctor;
mod node;
mod paths;
mod store;
mod template;

use std::fs;
use std::path::Path;
use std::time::Instant;

use serde_json::Value;

fn main() {
    // macOS 下 Rust 忽略 SIGPIPE，`sb-sync list | head` 会 panic。
    // 恢复默认行为：管道关闭时进程随 SIGPIPE 终止
    unsafe { libc::signal(libc::SIGPIPE, libc::SIG_DFL) };
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cmd = args.first().map(String::as_str);
    let rest: &[String] = args.get(1..).unwrap_or(&[]);

    let result = match cmd {
        Some("init") => cmd_init(),
        Some("add") => cmd_add(rest),
        Some("remove") => cmd_remove(rest),
        Some("list") => cmd_list(),
        Some("template") => cmd_template(rest),
        Some("sync") => cmd_sync(),
        Some("output") => {
            println!("{}", store::load_store().output.map(std::path::PathBuf::from).unwrap_or_else(paths::output_path).display());
            Ok(())
        }
        Some("check") => cmd_check(),
        Some("doctor") => {
            doctor::run();
            Ok(())
        }
        _ => {
            eprintln!("{}", usage());
            std::process::exit(if cmd.is_none() { 0 } else { 1 });
        }
    };
    if let Err(e) = result {
        eprintln!("ERROR: {e}");
        std::process::exit(1);
    }
}

fn usage() -> String {
    [
        "sb-sync — 设备侧 sing-box 配置同步器",
        "",
        "用法:",
        "  sb-sync init                  初始化设备目录",
        "  sb-sync add sub <url>         追加机场订阅",
        "  sb-sync add node <uri>        追加私有节点",
        "  sb-sync add local <file>      安装设备 local 覆盖",
        "  sb-sync list                  查看源清单与状态",
        "  sb-sync remove sub|node <#>   移除指定源",
        "  sb-sync template update|reset 手动刷新/重置远程底模",
        "  sb-sync sync                  拉订阅+自动更新底模+原子产出",
        "  sb-sync check                 验证本地产物（零网络）",
        "  sb-sync doctor                网络分层自检（DNS/直连/代理逐层计时）",
        "  sb-sync output                打印产物路径",
    ]
    .join("\n")
}

fn ensure_dir() {
    fs::create_dir_all(paths::sb_sync_dir()).expect("无法创建配置目录");
}

fn cmd_init() -> Result<(), String> {
    ensure_dir();
    let store_path = paths::store_path();
    if !store_path.exists() {
        store::save_store(&store::Store::default())?;
    }
    let local = paths::local_path();
    if !local.exists() {
        paths::write_json_atomic(
            &local,
            &serde_json::json!({
                "_comment": "设备特有覆盖：dns.servers / dns.rules / route.rules。参考仓库 local.json.example"
            }),
        )?;
    }
    println!("已初始化 {}", paths::sb_sync_dir().display());
    println!("下一步: sb-sync add sub <订阅URL> && sb-sync add node <节点URI> && sb-sync sync");
    Ok(())
}

fn cmd_add(rest: &[String]) -> Result<(), String> {
    let kind = rest.first().map(String::as_str).unwrap_or("");
    let value = rest.get(1).cloned().unwrap_or_default();
    match kind {
        "sub" | "node" if !value.is_empty() => {}
        "local" if !value.is_empty() => {
            let src = std::env::current_dir()
                .map_err(|e| e.to_string())?
                .join(&value);
            let src = fs::canonicalize(&src).map_err(|_| format!("local 文件不存在: {}", src.display()))?;
            let parsed: Value = serde_json::from_str(
                &fs::read_to_string(&src).map_err(|e| format!("读取失败: {e}"))?,
            )
            .map_err(|e| format!("local 文件必须是 JSON 对象: {e}"))?;
            if !parsed.is_object() {
                return Err("local 文件必须是 JSON 对象".into());
            }
            fs::copy(&src, paths::local_path()).map_err(|e| e.to_string())?;
            println!("已安装设备 local 覆盖 → {}", paths::local_path().display());
            return Ok(());
        }
        _ => return Err("add 用法: sb-sync add sub|node|local <值>".into()),
    }

    ensure_dir();
    let mut store = store::load_store();
    let is_sub = kind == "sub";
    let list = if is_sub { &mut store.subs } else { &mut store.nodes };
    if list.contains(&value) {
        println!("已存在，跳过");
        return Ok(());
    }
    list.push(value);
    let count = list.len();
    store::save_store(&store)?;
    println!("已添加 {kind} #{count}");
    Ok(())
}

fn cmd_remove(rest: &[String]) -> Result<(), String> {
    let kind = rest.first().map(String::as_str).unwrap_or("");
    let index: usize = rest
        .get(1)
        .and_then(|s| s.parse().ok())
        .ok_or("remove 用法: sb-sync remove sub|node <序号>")?;
    if kind != "sub" && kind != "node" {
        return Err("remove 用法: sb-sync remove sub|node <序号>".into());
    }
    if index < 1 {
        return Err("序号必须是 >= 1 的整数".into());
    }
    let mut store = store::load_store();
    let list = if kind == "sub" { &mut store.subs } else { &mut store.nodes };
    if index > list.len() {
        return Err(format!("序号超出范围（共 {} 项）", list.len()));
    }
    let removed = list.remove(index - 1);
    store::save_store(&store)?;
    let masked = if kind == "sub" { mask_url(&removed) } else { mask_uri(&removed) };
    println!("已移除 {kind} #{index}: {masked}");
    Ok(())
}

fn cmd_list() -> Result<(), String> {
    let store = store::load_store();
    println!("机场订阅 ({}):", store.subs.len());
    for (i, s) in store.subs.iter().enumerate() {
        println!("  [{}] {}", i + 1, mask_url(s));
    }
    println!("私有节点 ({}):", store.nodes.len());
    for (i, n) in store.nodes.iter().enumerate() {
        println!("  [{}] {}", i + 1, mask_uri(n));
    }
    println!(
        "local 覆盖: {}",
        if paths::local_path().exists() {
            paths::local_path().display().to_string()
        } else {
            "(未配置)".into()
        }
    );
    let state = store::State::load();
    let last = state
        .last_sync_at
        .clone()
        .unwrap_or_else(|| "从未".into());
    let fail_note = match (&state.last_sync_ok, &state.last_error) {
        (Some(false), Some(e)) => format!(" (上次失败: {e})"),
        (Some(false), None) => " (上次失败)".into(),
        _ => String::new(),
    };
    println!("底模来源: {} | 上次同步: {}{}", state.template_source, last, fail_note);
    Ok(())
}

fn cmd_template(rest: &[String]) -> Result<(), String> {
    ensure_dir();
    match rest.first().map(String::as_str) {
        Some("reset") => {
            fs::remove_file(paths::template_cache_path()).ok();
            println!("已清除远程底模缓存，回退内嵌版");
            Ok(())
        }
        Some("update") => {
            let remote = template::fetch_remote_template()
                .ok_or("远程底模拉取失败（网络或源不可用），缓存未动")?;
            let parsed: Value = serde_json::from_str(&remote).map_err(|e| e.to_string())?;
            paths::write_json_atomic(&paths::template_cache_path(), &parsed)?;
            let mut state = store::State::load();
            state.template_source = "remote".into();
            state.template_fetched_at = Some(now_iso());
            state.save()?;
            println!("底模已更新（{}）", template::TEMPLATE_REMOTE_URL);
            Ok(())
        }
        _ => Err("template 用法: sb-sync template update|reset".into()),
    }
}

fn cmd_sync() -> Result<(), String> {
    ensure_dir();
    let store = store::load_store();
    let started = Instant::now();

    let assemble_result = (|| -> Result<(String, template::TemplateSource, usize), String> {
        let (tpl, source) =
            template::load_template_for_sync(store.template_auto_update)?;
        let parts: Vec<String> = store
            .nodes
            .iter()
            .chain(store.subs.iter())
            .cloned()
            .collect();
        if parts.is_empty() {
            return Err("没有任何节点来源：先执行 sb-sync add sub/node".into());
        }
        let local: Option<Value> = fs::read_to_string(paths::local_path())
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok());
        let input = assemble::AssembleInput {
            sources: parts.join("|"),
            local,
            fetch_subscription: None,
        };
        let config = assemble::build_config(&tpl, &input)?;
        let rule_sets = config["route"]["rule_set"].as_array().map(|a| a.len()).unwrap_or(0);
        let content = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())? + "\n";
        Ok((content, source, rule_sets))
    })();

    let mut state = store::State::load();
    let (content, source, rule_sets) = match assemble_result {
        Ok(r) => {
            state.template_source = r.1.as_str().into();
            if r.1 == template::TemplateSource::Remote {
                state.template_fetched_at = Some(now_iso());
            }
            state.last_sync_at = Some(now_iso());
            state.last_sync_ok = Some(true);
            state.last_error = None;
            r
        }
        Err(e) => {
            state.last_sync_at = Some(now_iso());
            state.last_sync_ok = Some(false);
            state.last_error = Some(e.clone());
            state.save()?;
            return Err(e);
        }
    };
    state.save()?;

    let output: std::path::PathBuf = store
        .output
        .map(std::path::PathBuf::from)
        .unwrap_or_else(paths::output_path);
    write_output_atomic(&output, &content)?;

    println!("[sb-sync] 完成 ({}ms)", started.elapsed().as_millis());
    println!("  底模: {} | 规则集: {}", source.as_str(), rule_sets);
    println!("  产物: {}", output.display());
    reload_hint();
    Ok(())
}

/// 产物原子写：校验（可选内核）→ 保留 .bak → rename。
fn write_output_atomic(final_path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = final_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    let tmp = final_path.with_extension(format!("tmp.{}", std::process::id()));
    let bak = final_path.with_extension("bak");
    let had_previous = final_path.exists();

    fs::write(&tmp, content).map_err(|e| format!("写入临时文件失败: {e}"))?;
    let (result, warn) = detect::validate(&tmp);
    if let Some(w) = warn {
        eprintln!("[sb-sync] {w}");
    }
    if let Err(e) = result {
        fs::remove_file(&tmp).ok();
        return Err(format!("新产物校验失败，已放弃写入（保留原产物）: {e}"));
    }

    if had_previous {
        fs::copy(final_path, &bak).map_err(|e| format!("备份失败: {e}"))?;
    }
    fs::rename(&tmp, final_path).map_err(|e| format!("rename 失败: {e}"))?;
    Ok(())
}

/// sync 成功后：SFM 面板在线则提示用户重载（菜单栏开关 OFF→ON）。
fn reload_hint() {
    if let detect::Kernel::PanelOnline(v) = detect::detect() {
        println!("  SFM 在线（{v}）— 菜单栏开关 OFF→ON 重载新配置");
    }
}

/// check：对本地产物做全项验证（结构 + 可选内核校验 + local 合并痕迹），零网络。
fn cmd_check() -> Result<(), String> {
    let output: std::path::PathBuf = store::load_store()
        .output
        .map(std::path::PathBuf::from)
        .unwrap_or_else(paths::output_path);
    if !output.exists() {
        return Err(format!("产物不存在: {}（先执行 sb-sync sync）", output.display()));
    }
    let state = store::State::load();
    let text = fs::read_to_string(&output).map_err(|e| format!("读取失败: {e}"))?;
    let cfg: Value = serde_json::from_str(&text).map_err(|e| format!("产物 JSON 损坏: {e}"))?;

    let (result, warn) = detect::validate(&output);
    if let Some(w) = warn {
        eprintln!("[sb-sync] {w}");
    }
    result?;

    let nodes = cfg["outbounds"]
        .as_array()
        .map(|a| a.iter().filter(|o| o["server"].is_string()).count())
        .unwrap_or(0);
    let selectors = cfg["outbounds"]
        .as_array()
        .map(|a| a.iter().filter(|o| o["type"] == "selector").count())
        .unwrap_or(0);
    let rule_sets = cfg["route"]["rule_set"].as_array().map(|a| a.len()).unwrap_or(0);
    let local_applied = cfg["dns"]["rules"][0]["domain_suffix"].is_string()
        || cfg["route"]["rules"][0]["domain_suffix"].is_string();

    println!("产物:     {}", output.display());
    println!(
        "底模来源: {} | 上次同步: {}{}",
        state.template_source,
        state.last_sync_at.clone().unwrap_or_else(|| "从未".into()),
        if state.last_sync_ok == Some(false) { " (失败!)" } else { " (OK)" }
    );
    let first_node = cfg["outbounds"]
        .as_array()
        .and_then(|a| a.iter().find(|o| o["server"].is_string()))
        .and_then(|o| o["tag"].as_str())
        .unwrap_or("-");
    println!("节点:     {nodes} 个 (首选 {first_node})");
    println!("策略组:   {selectors} 个 | 规则集: {rule_sets} 份");
    println!(
        "local 覆盖: {}",
        if paths::local_path().exists() {
            if local_applied { "已注入 ✓".to_string() } else { "存在但产物未见注入(可能为空)".to_string() }
        } else {
            "未配置".to_string()
        }
    );
    Ok(())
}

fn mask_url(url: &str) -> String {
    // token/key/password 参数值打码（大小写不敏感）
    let re = regex::Regex::new(r"(?i)([?&](?:token|key|password)/?=?)[^&]+").unwrap();
    re.replace_all(url, "${1}***").into_owned()
}

fn mask_uri(uri: &str) -> String {
    let scheme = uri.split("://").next().unwrap_or(uri);
    match uri.find('#') {
        Some(i) => format!("{scheme}://***#{}", &uri[i + 1..]),
        None => format!("{scheme}://***"),
    }
}

fn now_iso() -> String {
    // 无 chrono 依赖：用 SYSTEMTIME 等价的 libc 时间戳（秒级足够，state 记录用）
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format_iso(secs)
}

/// Unix 秒 → ISO 8601（UTC），无外部 crate 的纯算术实现。
fn format_iso(secs: u64) -> String {
    let days = secs / 86_400;
    let rem = secs % 86_400;
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // civil-from-days 算法（Howard Hinnant）
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };
    format!("{year:04}-{month:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_format_matches_reference() {
        assert_eq!(format_iso(0), "1970-01-01T00:00:00Z");
        // 2026-09-19 17:00:00 UTC
        assert_eq!(format_iso(1_789_837_200), "2026-09-19T17:00:00Z");
        // 润年边界: 2024-02-29 00:00:00 UTC
        assert_eq!(format_iso(1_709_164_800), "2024-02-29T00:00:00Z");
    }

    #[test]
    fn mask_url_hides_token() {
        assert_eq!(
            mask_url("https://x.com/api?token=abc123&foo=bar"),
            "https://x.com/api?token=***&foo=bar"
        );
        assert_eq!(
            mask_url("https://x.com/api?Token=abc&key=xyz&password=1"),
            "https://x.com/api?Token=***&key=***&password=***"
        );
    }

    #[test]
    fn mask_uri_keeps_tag() {
        assert_eq!(mask_uri("hysteria2://pass@1.2.3.4:443#MyNode"), "hysteria2://***#MyNode");
        assert_eq!(mask_uri("https://sub.example.com/x"), "https://***");
    }
}
