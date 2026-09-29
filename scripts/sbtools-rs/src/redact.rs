//! 生效配置的隐私脱敏。按路径限定三条规则：
//!
//! 1. `subs` 与 `nodes` 数组的每个元素整体替换 `[已隐藏]`，不做 URL 形态判断：
//!    订阅 token 在 query 串里，`ss://` 凭据在 base64 里，逐个判断形态必然漏。
//! 2. 敏感键替换 `[已隐藏]`；`server` 仅在 `outbounds` 子树内替换——
//!    `dns.servers[].server`、`dns.rules[].server` 与 route 里的 `server`
//!    是标签或上游名，不是凭据，显式保留。
//! 3. URL 值模式只兜 userinfo 形态（`scheme://user:pass@host`），作为
//!    出现在非 subs/nodes 位置的 URL 凭据的兜底。
//!
//! `overlay` 是 YAML 块内的 JSON 字符串：解析后按同规则递归脱敏再回填；
//! 解析失败保留原文并加 `[overlay 未解析]` 标注（与服务端 validate 同口径：
//! overlay 本就必须是 JSON）。
//!
//! log.output 与 experimental.clash_api.external_controller 不在敏感键内，保留：
//! 它们是 logs（PR3）与 trace（PR4）的数据源。

use serde_json::{Map, Value};

const HIDDEN: &str = "[已隐藏]";

/// 出站凭据相关敏感键（不含 `server`，见规则 2；含 wireguard 的 `secret_key`）。
const SENSITIVE_KEYS: &[&str] = &[
    "auth",
    "auth_str",
    "password",
    "private_key",
    "psk",
    "public_key",
    "secret",
    "secret_key",
    "short_id",
    "token",
    "username",
    "uuid",
];

/// 递归脱敏，保持层级结构与键序（serde_json preserve_order）。
pub fn redact(value: &Value) -> Value {
    redact_value(value, false)
}

fn redact_value(value: &Value, in_outbound: bool) -> Value {
    match value {
        Value::Object(map) => {
            let mut out = Map::new();
            for (k, v) in map {
                out.insert(k.clone(), redact_field(k, v, in_outbound));
            }
            Value::Object(out)
        }
        Value::Array(items) => {
            Value::Array(items.iter().map(|v| redact_value(v, in_outbound)).collect())
        }
        other => other.clone(),
    }
}

fn redact_field(key: &str, value: &Value, in_outbound: bool) -> Value {
    // 规则 1: subs/nodes 元素整体隐藏
    if key == "subs" || key == "nodes" {
        if let Value::Array(items) = value {
            return Value::Array(items.iter().map(|_| Value::String(HIDDEN.into())).collect());
        }
    }
    // overlay 是 YAML 块字符串: JSON 解析后按同规则递归脱敏再回填
    if key == "overlay" {
        if let Value::String(text) = value {
            return redact_overlay(text);
        }
    }
    // 规则 2: 敏感键; server 仅限 outbounds 子树
    if !value.is_null() && (SENSITIVE_KEYS.contains(&key) || (key == "server" && in_outbound)) {
        return Value::String(HIDDEN.into());
    }
    // 规则 3: URL userinfo 兜底
    if let Value::String(s) = value {
        if let Some(r) = redact_userinfo(s) {
            return Value::String(r);
        }
    }
    redact_value(value, in_outbound || key == "outbounds")
}

fn redact_overlay(text: &str) -> Value {
    match serde_json::from_str::<Value>(text) {
        Ok(v) => match serde_json::to_string(&redact(&v)) {
            Ok(s) => Value::String(s),
            // Value 序列化不会失败，此分支仅为满足无 panic 门禁
            Err(_) => Value::String(format!("[overlay 未解析]\n{text}")),
        },
        Err(_) => Value::String(format!("[overlay 未解析]\n{text}")),
    }
}

/// `scheme://<凭据>@host` 的凭据段替换为 `[已隐藏]`，host 保留。
/// userinfo 不含 `/` 与 `?`，故 `https://host/path?mail=a@b.com` 不会被误伤。
fn redact_userinfo(s: &str) -> Option<String> {
    let (scheme, rest) = s.split_once("://")?;
    let first = scheme.chars().next()?;
    if !first.is_ascii_alphabetic()
        || !scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.')
    {
        return None;
    }
    let (userinfo, after) = rest.split_once('@')?;
    if userinfo.is_empty() || userinfo.contains('/') || userinfo.contains('?') {
        return None;
    }
    Some(format!("{scheme}://{HIDDEN}@{after}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn subs_and_nodes_elements_fully_hidden() {
        // 合成夹具: 订阅 token 在 query、ss 凭据在 base64、hy2 凭据在 userinfo
        let v = json!({
            "subs": ["https://example.invalid/sub?token=FAKE-TOKEN"],
            "nodes": [
                "ss://YWVzLTI1Ni1nYmM6cGFzc3dvcmQ=@192.0.2.10:8388#node-a",
                "hy2://user:pass@192.0.2.11:443?sni=example.invalid"
            ]
        });
        let out = redact(&v);
        let s = serde_json::to_string(&out).unwrap();
        assert!(!s.contains("FAKE-TOKEN"), "query token 泄漏: {s}");
        assert!(!s.contains("YWVz"), "ss base64 泄漏: {s}");
        assert!(!s.contains("user:pass"), "hy2 凭据泄漏: {s}");
        assert_eq!(out["subs"][0], "[已隐藏]");
        assert_eq!(out["nodes"].as_array().unwrap().len(), 2);
        assert!(out["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .all(|x| x == "[已隐藏]"));
    }

    #[test]
    fn outbound_sensitive_keys_hidden_including_nested() {
        let v = json!({
            "outbounds": [
                {"type": "direct", "tag": "direct"},
                {"type": "shadowsocks", "tag": "proxy", "server": "192.0.2.20",
                 "server_port": 8388, "password": "FAKE-PW"},
                {"type": "vless", "tag": "proxy-2", "server": "192.0.2.21", "uuid": "FAKE-UUID",
                 "tls": {"reality": {"public_key": "FAKE-PK", "short_id": "FAKE-SID"}}}
            ]
        });
        let s = serde_json::to_string(&redact(&v)).unwrap();
        for secret in [
            "FAKE-PW",
            "FAKE-UUID",
            "FAKE-PK",
            "FAKE-SID",
            "192.0.2.20",
            "192.0.2.21",
        ] {
            assert!(!s.contains(secret), "{secret} 泄漏: {s}");
        }
        // server_port 是端口不是凭据; tag 是标签
        assert!(s.contains("8388") && s.contains("proxy"));
    }

    #[test]
    fn dns_and_route_server_labels_kept() {
        let v = json!({
            "dns": {
                "servers": [{"tag": "dns-direct", "server": "192.0.2.53"}],
                "rules": [{"domain_suffix": ["example.org"], "server": "dns-alt"}]
            },
            "route": {
                "rules": [{"domain_suffix": ["demo.test"], "outbound": "direct"}],
                "default_domain_resolver": {"server": "dns-direct"}
            }
        });
        let out = redact(&v);
        assert_eq!(out["dns"]["servers"][0]["server"], "192.0.2.53");
        assert_eq!(out["dns"]["rules"][0]["server"], "dns-alt");
        assert_eq!(
            out["route"]["default_domain_resolver"]["server"],
            "dns-direct"
        );
        assert_eq!(out["route"]["rules"][0]["outbound"], "direct");
    }

    #[test]
    fn url_userinfo_hidden_outside_subs() {
        let v = json!({
            "experimental": {"clash_api": {"external_controller": "127.0.0.1:19090"}},
            "url": "hy2://user:pass@192.0.2.9:443"
        });
        let out = redact(&v);
        assert_eq!(out["url"], "hy2://[已隐藏]@192.0.2.9:443");
        // external_controller 是 PR4 数据源, 保留
        assert_eq!(
            out["experimental"]["clash_api"]["external_controller"],
            "127.0.0.1:19090"
        );
    }

    #[test]
    fn url_without_userinfo_untouched() {
        // @ 出现在 query 里且中间有路径段: 不是 userinfo 形态, 不得误伤
        let v = json!({"url": "https://example.invalid/sub?mail=a@b.com"});
        assert_eq!(
            redact(&v)["url"],
            "https://example.invalid/sub?mail=a@b.com"
        );
    }

    #[test]
    fn clash_api_secret_hidden_but_controller_kept() {
        let v = json!({"experimental": {"clash_api": {
            "external_controller": "127.0.0.1:19090", "secret": "FAKE-SECRET"}}});
        let s = serde_json::to_string(&redact(&v)).unwrap();
        assert!(!s.contains("FAKE-SECRET"), "clash api secret 泄漏: {s}");
        assert!(s.contains("127.0.0.1:19090"));
    }

    #[test]
    fn overlay_redacted_recursively_and_refilled() {
        let overlay = r#"{"outbounds":[{"type":"ss","server":"192.0.2.7","password":"OV-PW"}],
            "log":{"output":"/tmp/sing-box.log","level":"debug"}}"#;
        let v = json!({"overlay": overlay, "subs": ["https://example.invalid/sub?token=FAKE"]});
        let out = redact(&v);
        let s = out["overlay"].as_str().unwrap();
        assert!(
            !s.contains("OV-PW") && !s.contains("192.0.2.7"),
            "overlay 泄漏: {s}"
        );
        assert!(s.contains("[已隐藏]"));
        // log.output 保留(层级未破坏, 可再解析)
        let inner: Value = serde_json::from_str(s).unwrap();
        assert_eq!(inner["log"]["output"], "/tmp/sing-box.log");
        assert_eq!(inner["outbounds"][0]["server"], "[已隐藏]");
    }

    #[test]
    fn overlay_unparsable_kept_with_marker() {
        let v = json!({"overlay": "{{not json}}"});
        let out = redact(&v);
        let s = out["overlay"].as_str().unwrap();
        assert!(s.starts_with("[overlay 未解析]"), "实际: {s}");
        assert!(s.contains("{{not json}}"));
    }

    #[test]
    fn nested_arrays_traversed_and_log_kept() {
        let v = json!({
            "log": {"level": "debug", "output": "/tmp/sing-box.log"},
            "inbounds": [{"type": "mixed", "tag": "mixed-in", "listen": "127.0.0.1", "listen_port": 19081}],
            "route": {"rules": [
                {"protocol": "dns", "outbound": "dns-out"},
                {"ip_cidr": ["198.18.0.0/15"], "outbound": "dns-out"}
            ]}
        });
        let out = redact(&v);
        assert_eq!(out["log"]["output"], "/tmp/sing-box.log");
        assert_eq!(out["inbounds"][0]["listen"], "127.0.0.1");
        assert_eq!(out["route"]["rules"][1]["ip_cidr"][0], "198.18.0.0/15");
        // 顶层无 subs/nodes 时不产生占位键
        assert!(out.get("subs").is_none());
        assert!(out.get("nodes").is_none());
    }
}
