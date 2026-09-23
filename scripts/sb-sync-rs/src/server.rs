//! 服务端：`sb-sync server` — 解密客户端载荷、装配节点、调用官方 sing-box CLI 合并并响应。

use crate::assemble::{self, AssembleInput};
use crate::crypto;
use crate::template;
use serde_json::{json, Value};
use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;
use tiny_http::{Response, Server};

/// 请求参数上限：URL 查询串（d=）最大字节数。
const MAX_QUERY_LEN: usize = 128 * 1024;
/// 订阅响应体单请求上限。
const MAX_SUB_BODY: usize = 5 * 1024 * 1024;

static REQUEST_SEQ: AtomicU64 = AtomicU64::new(0);

/// 解密后的客户端载荷。
#[derive(Debug)]
struct Payload {
    subs: Vec<String>,
    nodes: Vec<String>,
    overlay: Option<Value>,
    template_url: Option<String>,
}

/// 解析解密后的 JSON 载荷。结构由客户端 `config.rs::validate` 保证，仍做防御性校验。
fn parse_payload(plaintext: &[u8]) -> Result<Payload, String> {
    let v: Value =
        serde_json::from_slice(plaintext).map_err(|e| format!("载荷 JSON 解析失败: {e}"))?;
    if !v.is_object() {
        return Err("载荷顶层必须是 JSON Object".into());
    }
    let subs: Vec<String> = v["subs"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|s| s.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let nodes: Vec<String> = v["nodes"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|s| s.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let overlay = match &v["overlay"] {
        Value::Null => None,
        ov if ov.is_object() => Some(ov.clone()),
        other => return Err(format!("overlay 顶层必须是 JSON Object，当前: {other}")),
    };
    let template_url = match &v["template_url"] {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        other => return Err(format!("template_url 必须是字符串，当前: {other}")),
    };
    if subs.is_empty() && nodes.is_empty() {
        return Err("载荷 subs 与 nodes 均为空".into());
    }
    Ok(Payload {
        subs,
        nodes,
        overlay,
        template_url,
    })
}

/// 请求独立临时目录（进程唯一 + 请求序号），RAII 清理。
struct TempMergeDir {
    path: PathBuf,
}

impl TempMergeDir {
    fn create() -> Result<Self, String> {
        let seq = REQUEST_SEQ.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("sb-sync-merge-{}-{seq}", std::process::id()));
        std::fs::create_dir_all(&path).map_err(|e| format!("创建临时目录失败: {e}"))?;
        Ok(Self { path })
    }
}

impl Drop for TempMergeDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// 复用现有装配管线：sources → 节点全集 → 反回环规则 → finalize。
/// 返回填充好的完整底模 JSON 与实际底模来源。
fn assemble_base(payload: &Payload) -> Result<(Value, template::TemplateSource), String> {
    let mut sources: Vec<String> = Vec::with_capacity(payload.subs.len() + payload.nodes.len());
    sources.extend(payload.subs.iter().cloned());
    sources.extend(payload.nodes.iter().cloned());

    let input = AssembleInput {
        sources: sources.join("|"),
        fetch_subscription: Some(Box::new(fetch_subscription_bounded)),
    };
    let nodes = assemble::collect_nodes(&input.sources, &input)?;

    let (mut tpl, source) = template::load_template(payload.template_url.as_deref())?;
    // 反回环直连规则置顶（服务端 DNS 视角尽力解析；失败则只保留 domain 规则）
    if let Some(rule) = assemble::generate_node_direct_rule(&nodes, &tpl) {
        if !tpl["route"]["rules"].is_array() {
            tpl["route"]["rules"] = json!([]);
        }
        let rules = tpl["route"]["rules"]
            .as_array_mut()
            .ok_or_else(|| "底模 route.rules 必须是数组".to_string())?;
        rules.insert(0, rule);
    }
    assemble::finalize(&mut tpl, nodes)?;
    Ok((tpl, source))
}

/// 订阅抓取：带 5MB 上限，防止机场响应过大拖垮服务。
fn fetch_subscription_bounded(url: &str) -> Result<String, String> {
    let res = ureq::get(url)
        .timeout(std::time::Duration::from_secs(10))
        .call()
        .map_err(|e| format!("订阅拉取失败: {e}"))?;
    let mut body = String::new();
    res.into_reader()
        .take(MAX_SUB_BODY as u64 + 1)
        .read_to_string(&mut body)
        .map_err(|e| format!("订阅读取失败: {e}"))?;
    if body.len() > MAX_SUB_BODY {
        return Err(format!(
            "订阅响应超过 {}MB 上限",
            MAX_SUB_BODY / 1024 / 1024
        ));
    }
    Ok(body)
}

/// 调用内核 merge 01-overlay.json + 02-base.json，返回结果 JSON 字符串。
fn run_singbox_merge(
    dir: &TempMergeDir,
    overlay: Option<&Value>,
    base: &Value,
) -> Result<String, String> {
    run_singbox_merge_with(&template::resolve_singbox_binary(), dir, overlay, base)
}

/// merge 实现本体，内核路径由参数注入：测试需要验证「路径不存在时报错指向该路径」
/// 这条契约，而内联读环境变量无法确定性覆盖（env 是进程全局，并行测试下互相污染）。
fn run_singbox_merge_with(
    bin: &std::ffi::OsStr,
    dir: &TempMergeDir,
    overlay: Option<&Value>,
    base: &Value,
) -> Result<String, String> {
    let base_path = dir.path.join("02-base.json");
    std::fs::write(
        &base_path,
        serde_json::to_vec_pretty(base).map_err(|e| format!("底模序列化失败: {e}"))?,
    )
    .map_err(|e| format!("写底模失败: {e}"))?;

    let mut args: Vec<String> = Vec::new();
    if let Some(ov) = overlay {
        let overlay_path = dir.path.join("01-overlay.json");
        std::fs::write(
            &overlay_path,
            serde_json::to_vec_pretty(ov).map_err(|e| format!("overlay 序列化失败: {e}"))?,
        )
        .map_err(|e| format!("写 overlay 失败: {e}"))?;
        args.push("-c".into());
        args.push(overlay_path.display().to_string());
    }
    args.push("-c".into());
    args.push(base_path.display().to_string());

    let result_path = dir.path.join("result.json");
    let output = std::process::Command::new(bin)
        .arg("merge")
        .arg(result_path.display().to_string())
        .args(&args)
        .output()
        .map_err(|e| format!("启动内核失败（{}）: {e}", bin.to_string_lossy()))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let brief: String = stderr.lines().take(5).collect::<Vec<_>>().join("; ");
        return Err(format!("内核 merge 失败: {brief}"));
    }
    std::fs::read_to_string(&result_path).map_err(|e| format!("读取合并结果失败: {e}"))
}

/// 单次请求完整处理：解密 → 装配 → 合并 → JSON 字符串。
fn handle_sub(
    secret_key: &crypto::CryptoStaticSecret,
    query_d: &str,
) -> Result<(String, template::TemplateSource), String> {
    if query_d.len() > MAX_QUERY_LEN {
        return Err(format!("请求参数超过 {}KB 上限", MAX_QUERY_LEN / 1024));
    }
    let plaintext = crypto::decrypt_payload(secret_key, query_d)?;
    let payload = parse_payload(&plaintext)?;
    let (base, source) = assemble_base(&payload)?;
    let merged = run_singbox_merge(&TempMergeDir::create()?, payload.overlay.as_ref(), &base)?;
    Ok((merged, source))
}

/// 服务端主循环。
pub fn run(port: u16) -> Result<(), String> {
    let sk_hex = std::env::var("SERVER_PRIVATE_KEY")
        .map_err(|_| "环境变量 SERVER_PRIVATE_KEY 未设置（32 字节 Hex）".to_string())?;
    let sk = crypto::parse_private_key_hex(&sk_hex)?;
    // 公钥由私钥推导，供客户端 encode 自动获取，无需人工配置
    let pk_hex = crypto::derive_public_key_hex(&sk_hex)?;

    let server =
        Server::http(format!("0.0.0.0:{port}")).map_err(|e| format!("监听 {port} 失败: {e}"))?;
    eprintln!("[sb-sync server] listening on 0.0.0.0:{port}");

    for request in server.incoming_requests() {
        let started = Instant::now();
        let method = request.method().as_str();
        let url = request.url().to_string();
        let (path, query) = match url.split_once('?') {
            Some((p, q)) => (p, Some(q)),
            None => (url.as_str(), None),
        };

        let (status, body, tpl_src): (u16, String, Option<&'static str>) = match (method, path) {
            ("GET", "/healthz") => (200, "ok".into(), None),
            // 公钥公开：客户端 encode 靠它加密，无任何机密性要求
            ("GET", "/pubkey") => (200, pk_hex.clone(), None),
            ("GET", "/sub") => match query.and_then(|q| q.strip_prefix("d=")) {
                Some(d) if !d.is_empty() => match handle_sub(&sk, d) {
                    Ok((json, src)) => (200, json, Some(src.as_str())),
                    Err(e) => {
                        // 解密失败（含 403 语义）与装配失败统一 400；不回显密文
                        let code = if e.contains("解密失败")
                            || e.contains("Base64URL")
                            || e.contains("载荷长度")
                        {
                            403
                        } else {
                            400
                        };
                        (code, e, None)
                    }
                },
                _ => (400, "缺少 d 参数".into(), None),
            },
            _ => (404, "not found".into(), None),
        };
        match tpl_src {
            Some(src) => eprintln!(
                "[sb-sync server] {} {} -> {} ({}ms, 底模: {})",
                method,
                path,
                status,
                started.elapsed().as_millis(),
                src
            ),
            None => eprintln!(
                "[sb-sync server] {} {} -> {} ({}ms)",
                method,
                path,
                status,
                started.elapsed().as_millis()
            ),
        }

        let response = Response::from_string(body)
            .with_status_code(status)
            .with_header(
                tiny_http::Header::from_bytes(
                    &b"Content-Type"[..],
                    &b"application/json; charset=utf-8"[..],
                )
                .map_err(|()| "构造 Content-Type 响应头失败".to_string())?,
            );
        if let Err(e) = request.respond(response) {
            eprintln!("[sb-sync server] 响应失败: {e}");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// e2e 测试的内核门禁：返回 `Some(原因)` 表示应跳过，`None` 表示可用。
    ///
    /// 显式设置了 `SING_BOX` 却不可用时**不跳过**：沙箱里内核装在
    /// `/opt/proxy-test/bin` 不在 PATH，全靠这个变量定位，静默跳过会让 e2e
    /// 覆盖率降级且无人察觉——那正是这些测试存在的意义。只有「未显式设置
    /// 且 PATH 上也没有」才允许跳过（开发机上没装内核的常见情形）。
    fn kernel_unavailable_reason() -> Option<String> {
        let bin = template::resolve_singbox_binary();
        let explicit = std::env::var_os("SING_BOX").is_some_and(|v| !v.is_empty());
        let probe = std::process::Command::new(&bin).arg("version").output();

        let detail = match probe {
            Ok(o) if o.status.success() => return None,
            Ok(o) => format!("退出码 {:?}", o.status.code()),
            Err(e) => format!("无法执行: {e}"),
        };

        assert!(
            !explicit,
            "SING_BOX 已显式设为 {:?} 但不可用（{detail}）：\
             这是环境配置错误，不能按「内核缺失」跳过",
            bin
        );
        Some(format!("{:?} 不可用（{detail}）", bin))
    }

    #[test]
    fn parse_payload_roundtrip() {
        let payload = json!({
            "subs": ["https://airport.example/sub"],
            "nodes": ["hy2://pass@192.0.2.1:8388?sni=example.com#selfhost"],
            "overlay": {"log": {"level": "warn"}}
        });
        let parsed = parse_payload(&serde_json::to_vec(&payload).unwrap()).unwrap();
        assert_eq!(parsed.subs, vec!["https://airport.example/sub"]);
        assert_eq!(parsed.nodes.len(), 1);
        assert_eq!(parsed.overlay.as_ref().unwrap()["log"]["level"], "warn");
    }

    #[test]
    fn parse_payload_rejects_null_overlay_ok_and_empty_sources() {
        let payload = json!({"subs": [], "nodes": [], "overlay": null});
        let err = parse_payload(&serde_json::to_vec(&payload).unwrap()).unwrap_err();
        assert!(err.contains("均为空"), "实际: {err}");
    }

    #[test]
    fn parse_payload_rejects_non_object_overlay() {
        let payload = json!({"subs": ["https://a.example/s"], "nodes": [], "overlay": "string"});
        let err = parse_payload(&serde_json::to_vec(&payload).unwrap()).unwrap_err();
        assert!(err.contains("JSON Object"), "实际: {err}");
    }

    #[test]
    fn parse_payload_reads_template_url() {
        let payload = json!({
            "subs": ["https://a.example/s"],
            "nodes": [],
            "overlay": null,
            "template_url": "https://example.com/t.json"
        });
        let parsed = parse_payload(&serde_json::to_vec(&payload).unwrap()).unwrap();
        assert_eq!(
            parsed.template_url.as_deref(),
            Some("https://example.com/t.json")
        );

        // 缺字段与显式 null 都视作未配置
        for absent in [
            json!({"subs": ["https://a.example/s"], "nodes": []}),
            json!({"subs": ["https://a.example/s"], "nodes": [], "template_url": null}),
        ] {
            let parsed = parse_payload(&serde_json::to_vec(&absent).unwrap()).unwrap();
            assert!(parsed.template_url.is_none());
        }
    }

    #[test]
    fn parse_payload_rejects_non_string_template_url() {
        let payload = json!({"subs": ["https://a.example/s"], "nodes": [], "template_url": 42});
        let err = parse_payload(&serde_json::to_vec(&payload).unwrap()).unwrap_err();
        assert!(err.contains("template_url"), "实际: {err}");
    }

    #[test]
    fn end_to_end_encrypt_assemble_merge() {
        let Some(reason) = kernel_unavailable_reason() else {
            return run_end_to_end();
        };
        eprintln!("skip: {reason}");
    }

    fn run_end_to_end() {
        let (sk_hex, pk_hex) = crypto::generate_keypair_hex();
        let sk = crypto::parse_private_key_hex(&sk_hex).unwrap();

        let payload = json!({
            "subs": [],
            "nodes": ["hy2://pass@192.0.2.1:8388?sni=example.com#selfhost"],
            "overlay": {"log": {"level": "warn"}}
        });
        let plaintext = serde_json::to_vec(&payload).unwrap();
        let ciphertext =
            crypto::encrypt_payload(&crypto::parse_public_key_hex(&pk_hex).unwrap(), &plaintext)
                .unwrap();

        let (result, source) = handle_sub(&sk, &ciphertext).expect("端到端解密装配合并成功");
        let merged: Value = serde_json::from_str(&result).unwrap();
        // overlay 覆盖底模 log.level
        assert_eq!(merged["log"]["level"], "warn");
        // 底模 outbounds 与节点被填充
        assert!(merged["outbounds"].as_array().unwrap().len() > 2);
        // 三级回退必须有确定来源（有网=remote，无网=cache/embedded）
        assert!(
            ["remote", "cache", "embedded"].contains(&source.as_str()),
            "意外的底模来源: {}",
            source.as_str()
        );
    }

    /// 内核路径不存在时，报错必须含该路径本身。
    /// 报错只说「启动失败」会让沙箱里调试的人先去怀疑 PATH，
    /// 而真正的问题在 SING_BOX 指向了一个不存在的文件。
    #[test]
    fn missing_kernel_error_names_the_path() {
        let dir = TempMergeDir::create().unwrap();
        let base = json!({"outbounds": []});
        let bad = std::ffi::OsString::from("/nonexistent/definitely-not-a-kernel");
        let err = run_singbox_merge_with(&bad, &dir, None, &base).unwrap_err();
        assert!(
            err.contains("/nonexistent/definitely-not-a-kernel"),
            "报错须含注入的内核路径，实际: {err}"
        );
    }

    /// 内核 merge 失败时，报错须带上其 stderr 摘要（截前 5 行）。
    /// 否则用户只看到「失败」而不知道是 overlay 语法错还是底模冲突。
    #[test]
    #[cfg(unix)]
    fn kernel_failure_surfaces_stderr() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempMergeDir::create().unwrap();
        let script_dir =
            std::env::temp_dir().join(format!("sb-sync-badbox-{}", std::process::id()));
        std::fs::create_dir_all(&script_dir).unwrap();
        let bad = script_dir.join("bad-kernel");
        std::fs::write(
            &bad,
            "#!/bin/sh\necho 'ERROR: overlay 非法字段 xxx' >&2\nexit 1\n",
        )
        .unwrap();
        std::fs::set_permissions(&bad, std::fs::Permissions::from_mode(0o755)).unwrap();

        let base = json!({"outbounds": []});
        let err = run_singbox_merge_with(bad.as_os_str(), &dir, None, &base).unwrap_err();
        assert!(
            err.contains("overlay 非法字段"),
            "应带上 stderr 摘要，实际: {err}"
        );
        let _ = std::fs::remove_dir_all(&script_dir);
    }

    #[test]
    fn wrong_key_returns_403_semantics() {
        let (sk_hex, _) = crypto::generate_keypair_hex();
        let sk = crypto::parse_private_key_hex(&sk_hex).unwrap();
        let err = handle_sub(&sk, "not-a-valid-payload").unwrap_err();
        assert!(
            err.contains("Base64URL") || err.contains("载荷长度") || err.contains("解密失败"),
            "实际: {err}"
        );
    }

    /// 反回环直连规则必须恒定置于 route.rules 首位：底模自带嗅探、clash_mode 与分流规则，
    /// 任何一条先于它命中都会让节点自身流量走代理而形成回环。
    /// 只用 IP 字面量节点，避免域名解析引入网络依赖。
    #[test]
    fn node_direct_rule_is_pinned_to_first_position() {
        let payload = Payload {
            subs: vec![],
            nodes: vec![
                "hy2://pass@192.0.2.1:8388#a".into(),
                "anytls://pass@[2001:db8::1]:8443#b".into(),
            ],
            overlay: None,
            template_url: None,
        };
        let (tpl, _) = assemble_base(&payload).expect("装配失败");

        let rules = tpl["route"]["rules"].as_array().expect("rules 为数组");
        let first = &rules[0];
        assert_eq!(first["outbound"], json!("direct"), "首条规则应为直连");
        let cidrs = first["ip_cidr"].as_array().expect("首条应含 ip_cidr");
        for expected in ["192.0.2.1/32", "2001:db8::1/128"] {
            assert!(
                cidrs.iter().any(|c| c == expected),
                "首条 ip_cidr 应含 {expected}，实际: {cidrs:?}"
            );
        }
        // 底模原有的嗅探规则必须仍在，且排在反回环规则之后
        assert!(
            rules.iter().skip(1).any(|r| r["action"] == json!("sniff")),
            "底模嗅探规则不应被丢弃"
        );
        assert!(
            rules.len() > 3,
            "底模原有规则应保留，实际条数: {}",
            rules.len()
        );
    }

    /// 节点为纯域名且解析失败时，规则仍须生成并置顶，只保留 domain 分支。
    /// `.invalid` 是保留 TLD，解析必败，测试封闭不依赖网络。
    #[test]
    fn node_direct_rule_is_pinned_even_without_resolved_ip() {
        let payload = Payload {
            subs: vec![],
            nodes: vec!["hy2://pass@node.invalid:8388#dom".into()],
            overlay: None,
            template_url: None,
        };
        let (tpl, _) = assemble_base(&payload).expect("装配失败");

        let first = &tpl["route"]["rules"][0];
        assert_eq!(first["outbound"], json!("direct"));
        assert_eq!(first["domain"], json!(["node.invalid"]));
    }

    /// 无 overlay 时 merge 仍须产出配置；overlay 存在时覆盖底模同名标量。
    /// 这两条是「提交了 overlay 却没生效」与「没提交 overlay 就失败」两类事故的分界。
    #[test]
    fn overlay_overrides_base_after_merge() {
        let Some(reason) = kernel_unavailable_reason() else {
            return run_overlay_overrides();
        };
        eprintln!("skip: {reason}");
    }

    fn run_overlay_overrides() {
        let (sk_hex, pk_hex) = crypto::generate_keypair_hex();
        let sk = crypto::parse_private_key_hex(&sk_hex).unwrap();
        let pk = crypto::parse_public_key_hex(&pk_hex).unwrap();

        // 无 overlay：merge 结果仍须是合法 JSON 且带 outbounds
        let no_overlay = json!({
            "subs": [],
            "nodes": ["hy2://pass@192.0.2.1:8388#a"],
        });
        let ct = crypto::encrypt_payload(&pk, &serde_json::to_vec(&no_overlay).unwrap()).unwrap();
        let (merged, _) = handle_sub(&sk, &ct).expect("无 overlay 应成功");
        let v: Value = serde_json::from_str(&merged).unwrap();
        assert!(v["outbounds"].is_array(), "应产出 outbounds");

        // 有 overlay：log.level 被覆盖，且底模的入站结构保留（overlay 是叠加不是替换）
        let with_overlay = json!({
            "subs": [],
            "nodes": ["hy2://pass@192.0.2.1:8388#a"],
            "overlay": {"log": {"level": "debug"}},
        });
        let ct2 =
            crypto::encrypt_payload(&pk, &serde_json::to_vec(&with_overlay).unwrap()).unwrap();
        let (merged2, _) = handle_sub(&sk, &ct2).expect("有 overlay 应成功");
        let v2: Value = serde_json::from_str(&merged2).unwrap();
        assert_eq!(v2["log"]["level"], json!("debug"));
        assert!(v2["inbounds"].is_array(), "底模入站不应被 overlay 抹掉");
    }
}
