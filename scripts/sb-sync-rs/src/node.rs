//! 节点 URI 解析：hysteria2 / hy2、anytls、shadowsocks（SIP002 + legacy）。
//! 语义对齐旧 endpoint.ts，无法识别的输入 fail-fast。

use serde_json::{json, Map, Value};

fn parse_url(raw: &str) -> Result<url::Url, String> {
    url::Url::parse(raw).map_err(|e| format!("URI 解析失败: {e}"))
}

fn percent_decode(s: &str) -> String {
    percent_encoding::percent_decode_str(s).decode_utf8_lossy().into_owned()
}

fn query_get(url: &url::Url, key: &str) -> Option<String> {
    url.query_pairs().find(|(k, _)| k == key).map(|(_, v)| v.into_owned())
}

fn tag_from_hash(url: &url::Url, default: &str) -> String {
    match url.fragment() {
        Some(f) if !f.is_empty() => percent_decode(f),
        _ => default.to_string(),
    }
}

/// hysteria2:// 或 hy2:// → sing-box hysteria2 出站。
pub fn parse_hysteria2(raw: &str) -> Result<Value, String> {
    let u = parse_url(raw)?;
    let tag = tag_from_hash(&u, "selfhost");
    let auth = percent_decode(if !u.username().is_empty() {
        u.username()
    } else {
        u.password().unwrap_or("")
    });
    let port: u16 = u.port().unwrap_or(443);
    let sni = query_get(&u, "sni").unwrap_or_else(|| u.host_str().unwrap_or("").to_string());
    let insecure = query_get(&u, "insecure").as_deref() == Some("1");

    let mut outbound = json!({
        "type": "hysteria2",
        "tag": tag,
        "server": u.host_str().unwrap_or(""),
        "server_port": port,
        "password": auth,
        "tls": {
            "enabled": true,
            "server_name": sni,
            "insecure": insecure,
        },
    });
    if let Some(obfs_type) = query_get(&u, "obfs") {
        outbound["obfs"] = json!({
            "type": obfs_type,
            "password": query_get(&u, "obfs-password").unwrap_or_default(),
        });
    }
    Ok(outbound)
}

/// anytls:// → sing-box anytls 出站（字段语义按官方 anytls.md）。
pub fn parse_anytls(raw: &str) -> Result<Value, String> {
    let u = parse_url(raw)?;
    let default_tag = format!("AnyTLS {}:{}", u.host_str().unwrap_or(""), u.port().unwrap_or(443));
    let tag = tag_from_hash(&u, &default_tag);
    let password = percent_decode(if !u.username().is_empty() {
        u.username()
    } else {
        u.password().unwrap_or("")
    });
    if password.is_empty() {
        return Err(format!("anytls URI 缺少密码：{raw}"));
    }

    let mut tls = Map::new();
    tls.insert("enabled".into(), json!(true));
    if let Some(sni) = query_get(&u, "sni") {
        tls.insert("server_name".into(), json!(sni));
    }
    if let Some(insecure) = query_get(&u, "insecure") {
        tls.insert("insecure".into(), json!(insecure == "1"));
    }
    if let Some(alpn) = query_get(&u, "alpn") {
        let list: Vec<&str> = alpn.split(',').map(str::trim).filter(|s| !s.is_empty()).collect();
        tls.insert("alpn".into(), json!(list));
    }
    if let Some(fp) = query_get(&u, "fp") {
        tls.insert("utls".into(), json!({"enabled": true, "fingerprint": fp}));
    }

    let mut outbound = json!({
        "type": "anytls",
        "tag": tag,
        "server": u.host_str().unwrap_or(""),
        "server_port": u.port().unwrap_or(443),
        "password": password,
        "tls": Value::Object(tls),
    });
    for (src, dst) in [
        ("idle-session-check-interval", "idle_session_check_interval"),
        ("idle-session-timeout", "idle_session_timeout"),
        ("min-idle-session", "min_idle_session"),
    ] {
        if let Some(v) = query_get(&u, src) {
            outbound[dst] = json!(v);
        }
    }
    Ok(outbound)
}

/// shadowsocks URI（SIP002 及 legacy base64 整段格式）→ sing-box 出站。
pub fn parse_shadowsocks(raw: &str) -> Result<Value, String> {
    use base64::Engine;

    let (tag, main_all) = match raw.find('#') {
        Some(i) => (percent_decode(&raw[i + 1..]), &raw[..i]),
        None => ("Shadowsocks".to_string(), raw),
    };
    let mut main_part = main_all.strip_prefix("ss://").unwrap_or(main_all).to_string();
    if let Some(q) = main_part.find('?') {
        main_part.truncate(q);
    }

    let decode_std = |s: &str| -> Option<String> {
        base64::engine::general_purpose::STANDARD
            .decode(s.replace('-', "+").replace('_', "/").as_bytes())
            .ok()
            .and_then(|b| String::from_utf8(b).ok())
    };

    let cred_and_host: (String, String) = if let Some(at) = main_part.rfind('@') {
        // SIP002：userinfo 是 base64(method:password) 或明文 method:password
        let userinfo = &main_part[..at];
        let host = main_part[at + 1..].to_string();
        let decoded = decode_std(userinfo).unwrap_or_else(|| userinfo.to_string());
        (decoded, host)
    } else {
        // legacy：整段 base64 = method:password@host:port
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(main_part.as_bytes())
            .ok()
            .and_then(|b| String::from_utf8(b).ok())
            .ok_or("无法解析 ss URI：既无 @ 分隔也不是合法 legacy 格式")?;
        let at = decoded
            .rfind('@')
            .ok_or("无法解析 ss URI：既无 @ 分隔也不是合法 legacy 格式")?;
        (decoded[..at].to_string(), decoded[at + 1..].to_string())
    };

    let (cred, host_part) = cred_and_host;
    let sep = cred.find(':').ok_or("ss URI userinfo 缺少 method:password 分隔")?;
    let method = &cred[..sep];
    let password = &cred[sep + 1..];

    let (server, server_port): (&str, u16) = if host_part.starts_with('[') {
        let close = host_part.find(']').ok_or(format!("无法解析 ss 服务器地址：{host_part}"))?;
        let port = host_part[close + 1..]
            .strip_prefix(':')
            .and_then(|p| p.parse().ok())
            .ok_or(format!("无法解析 ss 服务器地址：{host_part}"))?;
        (&host_part[1..close], port)
    } else {
        let sep = host_part.rfind(':').ok_or(format!("无法解析 ss 服务器地址：{host_part}"))?;
        let port = host_part[sep + 1..]
            .parse()
            .map_err(|_| format!("无法解析 ss 服务器地址：{host_part}"))?;
        (&host_part[..sep], port)
    };
    if method.is_empty() || password.is_empty() || server.is_empty() {
        return Err("ss URI 字段不完整（method/password/server/port）".into());
    }

    Ok(json!({
        "type": "shadowsocks",
        "tag": tag,
        "server": server,
        "server_port": server_port,
        "method": method,
        "password": password,
    }))
}

/// 入口分发：按 scheme 分派到具体解析器。
pub fn parse_node_uri(uri: &str) -> Result<Value, String> {
    let trimmed = uri.trim();
    if trimmed.starts_with("hysteria2://") || trimmed.starts_with("hy2://") {
        return parse_hysteria2(trimmed);
    }
    if trimmed.starts_with("anytls://") {
        return parse_anytls(trimmed);
    }
    if trimmed.starts_with("ss://") {
        return parse_shadowsocks(trimmed);
    }
    let scheme = trimmed.split("://").next().unwrap_or(trimmed);
    Err(format!("不支持的节点协议：{scheme}（只支持 ss/hysteria2/hy2/anytls）"))
}
