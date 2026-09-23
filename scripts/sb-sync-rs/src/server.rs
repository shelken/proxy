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
}

/// 解析解密后的 JSON 载荷。结构由客户端 `config.rs::validate` 保证，仍做防御性校验。
fn parse_payload(plaintext: &[u8]) -> Result<Payload, String> {
    let v: Value = serde_json::from_slice(plaintext).map_err(|e| format!("载荷 JSON 解析失败: {e}"))?;
    if !v.is_object() {
        return Err("载荷顶层必须是 JSON Object".into());
    }
    let subs: Vec<String> = v["subs"]
        .as_array()
        .map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    let nodes: Vec<String> = v["nodes"]
        .as_array()
        .map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    let overlay = match &v["overlay"] {
        Value::Null => None,
        ov if ov.is_object() => Some(ov.clone()),
        other => return Err(format!("overlay 顶层必须是 JSON Object，当前: {other}")),
    };
    if subs.is_empty() && nodes.is_empty() {
        return Err("载荷 subs 与 nodes 均为空".into());
    }
    Ok(Payload { subs, nodes, overlay })
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
/// 返回填充好的完整底模 JSON。
fn assemble_base(payload: &Payload) -> Result<Value, String> {
    let mut sources: Vec<String> = Vec::with_capacity(payload.subs.len() + payload.nodes.len());
    sources.extend(payload.subs.iter().cloned());
    sources.extend(payload.nodes.iter().cloned());

    let input = AssembleInput {
        sources: sources.join("|"),
        local: None,
        fetch_subscription: Some(Box::new(fetch_subscription_bounded)),
    };
    let nodes = assemble::collect_nodes(&input.sources, &input)?;

    let mut tpl = template::embedded_template();
    // 反回环直连规则置顶（服务端 DNS 视角尽力解析；失败则只保留 domain 规则）
    if let Some(rule) = assemble::generate_node_direct_rule(&nodes, &tpl) {
        if !tpl["route"]["rules"].is_array() {
            tpl["route"]["rules"] = json!([]);
        }
        let rules = tpl["route"]["rules"].as_array_mut().unwrap();
        rules.insert(0, rule);
    }
    assemble::finalize(&mut tpl, nodes)?;
    Ok(tpl)
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
        return Err(format!("订阅响应超过 {}MB 上限", MAX_SUB_BODY / 1024 / 1024));
    }
    Ok(body)
}

/// 调用官方 sing-box CLI 合并 01-overlay.json + 02-base.json，返回结果 JSON 字符串。
fn run_singbox_merge(dir: &TempMergeDir, overlay: Option<&Value>, base: &Value) -> Result<String, String> {
    let base_path = dir.path.join("02-base.json");
    std::fs::write(&base_path, serde_json::to_vec_pretty(base).map_err(|e| format!("底模序列化失败: {e}"))?)
        .map_err(|e| format!("写底模失败: {e}"))?;

    let mut args: Vec<String> = Vec::new();
    if let Some(ov) = overlay {
        let overlay_path = dir.path.join("01-overlay.json");
        std::fs::write(&overlay_path, serde_json::to_vec_pretty(ov).map_err(|e| format!("overlay 序列化失败: {e}"))?)
            .map_err(|e| format!("写 overlay 失败: {e}"))?;
        args.push("-c".into());
        args.push(overlay_path.display().to_string());
    }
    args.push("-c".into());
    args.push(base_path.display().to_string());

    let result_path = dir.path.join("result.json");
    let output = std::process::Command::new("sing-box")
        .arg("merge")
        .arg(result_path.display().to_string())
        .args(&args)
        .output()
        .map_err(|e| format!("启动 sing-box 失败（容器内必须自带 sing-box 1.14.1）: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let brief: String = stderr.lines().take(5).collect::<Vec<_>>().join("; ");
        return Err(format!("sing-box merge 失败: {brief}"));
    }
    std::fs::read_to_string(&result_path).map_err(|e| format!("读取合并结果失败: {e}"))
}

/// 单次请求完整处理：解密 → 装配 → 合并 → JSON 字符串。
fn handle_sub(secret_key: &crypto::CryptoStaticSecret, query_d: &str) -> Result<String, String> {
    if query_d.len() > MAX_QUERY_LEN {
        return Err(format!("请求参数超过 {}KB 上限", MAX_QUERY_LEN / 1024));
    }
    let plaintext = crypto::decrypt_payload(secret_key, query_d)?;
    let payload = parse_payload(&plaintext)?;
    let base = assemble_base(&payload)?;
    run_singbox_merge(&TempMergeDir::create()?, payload.overlay.as_ref(), &base)
}

/// 服务端主循环。
pub fn run(port: u16) -> Result<(), String> {
    let sk_hex = std::env::var("SERVER_PRIVATE_KEY")
        .map_err(|_| "环境变量 SERVER_PRIVATE_KEY 未设置（32 字节 Hex）".to_string())?;
    let sk = crypto::parse_private_key_hex(&sk_hex)?;

    let server = Server::http(format!("0.0.0.0:{port}")).map_err(|e| format!("监听 {port} 失败: {e}"))?;
    eprintln!("[sb-sync server] listening on 0.0.0.0:{port}");

    for request in server.incoming_requests() {
        let started = Instant::now();
        let method = request.method().as_str();
        let url = request.url().to_string();
        let (path, query) = match url.split_once('?') {
            Some((p, q)) => (p, Some(q)),
            None => (url.as_str(), None),
        };

        let (status, body): (u16, String) = match (method, path) {
            ("GET", "/healthz") => (200, "ok".into()),
            ("GET", "/sub") => match query.and_then(|q| q.strip_prefix("d=")) {
                Some(d) if !d.is_empty() => match handle_sub(&sk, d) {
                    Ok(json) => (200, json),
                    Err(e) => {
                        // 解密失败（含 403 语义）与装配失败统一 400；不回显密文
                        let code = if e.contains("解密失败") || e.contains("Base64URL") || e.contains("载荷长度") {
                            403
                        } else {
                            400
                        };
                        (code, e)
                    }
                },
                _ => (400, "缺少 d 参数".into()),
            },
            _ => (404, "not found".into()),
        };
        eprintln!("[sb-sync server] {} {} -> {} ({}ms)", method, path, status, started.elapsed().as_millis());

        let response = Response::from_string(body)
            .with_status_code(status)
            .with_header(
                tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json; charset=utf-8"[..])
                    .unwrap(),
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
    fn end_to_end_encrypt_assemble_merge() {
        // 需要 sing-box 可执行文件；缺失则跳过（CI 沙箱内已保证）
        if std::process::Command::new("sing-box").arg("version").output().is_err() {
            eprintln!("skip: sing-box not found");
            return;
        }
        let (sk_hex, pk_hex) = crypto::generate_keypair_hex();
        let sk = crypto::parse_private_key_hex(&sk_hex).unwrap();

        let payload = json!({
            "subs": [],
            "nodes": ["hy2://pass@192.0.2.1:8388?sni=example.com#selfhost"],
            "overlay": {"log": {"level": "warn"}}
        });
        let plaintext = serde_json::to_vec(&payload).unwrap();
        let ciphertext = crypto::encrypt_payload(&crypto::parse_public_key_hex(&pk_hex).unwrap(), &plaintext).unwrap();

        let result = handle_sub(&sk, &ciphertext).expect("端到端解密装配合并成功");
        let merged: Value = serde_json::from_str(&result).unwrap();
        // overlay 覆盖底模 log.level
        assert_eq!(merged["log"]["level"], "warn");
        // 底模 outbounds 与节点被填充
        assert!(merged["outbounds"].as_array().unwrap().len() > 2);
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
}
