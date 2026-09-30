//! 客户端 YAML 配置定义、校验与加密载荷准备。

use crate::crypto;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;

/// sing-box merge 会读取服务器本地文件并内联返回的路径引用字段（含 ECH 嵌套）。
/// 客户端提交的 overlay 一旦包含这些字段，就会造成服务器任意文件读取。
pub const FORBIDDEN_PATH_FIELDS: &[&str] = &[
    "certificate_path",
    "key_path",
    "private_key_path",
    "config_path",
];

/// 客户端 YAML 结构。所有字段服务端都可识别；未知顶层字段拒绝。
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClientConfig {
    /// 机场订阅链接列表（可选）
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub subs: Vec<String>,
    /// 私有节点 URI 列表（可选，支持 hysteria2/hy2/anytls/ss）
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub nodes: Vec<String>,
    /// 原生 sing-box JSON 覆盖层文本（可选，多行字符串）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overlay: Option<String>,
    /// 远程底模 URL（可选）。配置后服务端改用该底模替代内置底模
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template_url: Option<String>,
}

/// 深度遍历 JSON，禁止出现任何路径引用字段（含 ECH 嵌套）。
/// overlay 与远程底模都要过这一关：两者最终都进 `sing-box merge`，都会内联服务器文件。
pub fn reject_path_fields(value: &Value) -> Result<(), String> {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                if FORBIDDEN_PATH_FIELDS.contains(&key.as_str()) {
                    return Err(format!(
                        "含禁用字段 `{key}`：服务端 merge 会读取该路径并内联服务器文件，\
                         请改为内联内容（如 `certificate`）"
                    ));
                }
                reject_path_fields(child)?;
            }
            Ok(())
        }
        Value::Array(items) => items.iter().try_for_each(reject_path_fields),
        _ => Ok(()),
    }
}

/// 校验配置并返回可加密的载荷（serde_json Value）。
pub fn validate(config: &ClientConfig) -> Result<Value, String> {
    if config.subs.is_empty() && config.nodes.is_empty() {
        return Err("`subs` 与 `nodes` 至少需要一个非空列表".into());
    }
    for (i, sub) in config.subs.iter().enumerate() {
        if !sub.starts_with("http://") && !sub.starts_with("https://") {
            return Err(format!("subs[{i}] 必须是 http(s) URL，当前: {sub}"));
        }
    }
    // overlay 必须能反序列化为 JSON Object 且无禁用路径字段
    let overlay_value = match &config.overlay {
        Some(text) if !text.trim().is_empty() => {
            let v: Value =
                serde_json::from_str(text).map_err(|e| format!("overlay JSON 解析失败: {e}"))?;
            if !v.is_object() {
                return Err("overlay 顶层必须是 JSON Object".into());
            }
            reject_path_fields(&v)?;
            Some(v)
        }
        _ => None,
    };

    // template_url 在本地先校验：非法 URL 立刻报错，不吃一次服务端往返
    let template_url = config
        .template_url
        .as_deref()
        .map(str::trim)
        .filter(|u| !u.is_empty());
    if let Some(url) = template_url {
        crate::template::validate_template_url(url)?;
    }

    // 载荷序列化：只包含有意义的字段（服务端按此结构还原）
    let payload = serde_json::json!({
        "subs": config.subs,
        "nodes": config.nodes,
        "overlay": overlay_value,
        "template_url": template_url,
    });
    Ok(payload)
}

/// 读取并解析 YAML 配置文件。
pub fn load_config(path: &Path) -> Result<ClientConfig, String> {
    let content = std::fs::read_to_string(path)
        .map_err(|e| format!("读取配置 {} 失败: {e}", path.display()))?;
    let config: ClientConfig =
        serde_yaml::from_str(&content).map_err(|e| format!("YAML 解析失败: {e}"))?;
    Ok(config)
}

/// 校验并加密，返回 base64url 编码的密文包。
pub fn encode_payload(payload: &Value, server_pk_hex: &str) -> Result<String, String> {
    let server_pk = crypto::parse_public_key_hex(server_pk_hex)?;
    let plaintext = serde_json::to_vec(payload).map_err(|e| format!("载荷序列化失败: {e}"))?;
    crypto::encrypt_payload(&server_pk, &plaintext)
}

/// 校验服务端基址并返回规范化形式（去尾斜杠）。
pub fn normalize_server(server: &str) -> Result<String, String> {
    let trimmed = server.trim();
    if trimmed.is_empty() {
        return Err("服务端地址不能为空".into());
    }
    if !trimmed.starts_with("https://") && !trimmed.starts_with("http://") {
        return Err(format!("服务端地址必须以 http(s):// 开头，当前: {trimmed}"));
    }
    Ok(trimmed.trim_end_matches('/').to_string())
}

/// 从服务端 `GET /pubkey` 拉取公钥（64 字符 Hex）。
pub fn fetch_server_public_key(server: &str) -> Result<String, String> {
    let url = format!("{}/pubkey", normalize_server(server)?);
    let body = crate::template::http_get(&url)?;
    let pk = body.trim();
    // 拉取后立即解析一次：非 Hex、长度不对、非法点位都在这里拦掉，不要带进加密阶段
    crypto::parse_public_key_hex(pk)?;
    Ok(pk.to_string())
}

/// 组装完整订阅 URL：`{server}/sub?d={ciphertext}`
pub fn build_url(server: &str, ciphertext: &str) -> Result<String, String> {
    Ok(format!("{}/sub?d={ciphertext}", normalize_server(server)?))
}

/// 生成新的 X25519 公私钥对（Hex），用于服务端部署初始化。
pub fn keygen() -> (String, String) {
    crypto::generate_keypair_hex()
}

#[cfg(test)]
mod tests {
    use super::*;

    const NODE: &str = "hy2://pass@192.0.2.1:8388?sni=example.com#selfhost";

    fn valid_yaml() -> String {
        "subs:\n  - https://airport.example/sub\n".to_string()
    }

    fn nodes_yaml(extra: &str) -> String {
        format!("nodes:\n  - {NODE}\n{extra}")
    }

    fn parse(yaml: &str) -> ClientConfig {
        serde_yaml::from_str(yaml).expect("YAML 解析失败")
    }

    #[test]
    fn valid_config_encodes() {
        let config = parse(&valid_yaml());
        let payload = validate(&config).expect("校验通过");
        assert_eq!(payload["subs"].as_array().unwrap().len(), 1);
        assert!(payload["overlay"].is_null());
    }

    #[test]
    fn empty_sources_rejected() {
        let config = parse("subs: []\n");
        let err = validate(&config).unwrap_err();
        assert!(err.contains("至少需要一个非空列表"), "实际: {err}");
    }

    #[test]
    fn unknown_top_level_field_rejected() {
        let yaml = format!("{}\nunknown_field: 1", valid_yaml());
        let err = serde_yaml::from_str::<ClientConfig>(&yaml).unwrap_err();
        assert!(
            err.to_string().contains("unknown_field"),
            "应拒绝未知字段，实际: {err}"
        );
    }

    /// 回归：`server` 与 `server_public_key` 已从 YAML 移除，写成配置字段必须报错，
    /// 否则旧配置会被静默接受，而用户以为公钥生效了。
    #[test]
    fn server_fields_no_longer_accepted_in_yaml() {
        for field in ["server", "server_public_key"] {
            let yaml = format!("{field}: https://sub.example.com\n{}", valid_yaml());
            let err = serde_yaml::from_str::<ClientConfig>(&yaml).unwrap_err();
            assert!(
                err.to_string().contains(field),
                "`{field}` 应被拒绝，实际: {err}"
            );
        }
    }

    #[test]
    fn overlay_must_be_object() {
        let config = parse(&nodes_yaml("overlay: |\n  [1, 2, 3]\n"));
        let err = validate(&config).unwrap_err();
        assert!(err.contains("JSON Object"), "实际: {err}");
    }

    #[test]
    fn overlay_invalid_json_rejected() {
        let config = parse(&nodes_yaml("overlay: |\n  {{not-json}}\n"));
        let err = validate(&config).unwrap_err();
        assert!(err.contains("overlay JSON 解析失败"), "实际: {err}");
    }

    #[test]
    fn overlay_certificate_path_rejected() {
        let config = parse(&nodes_yaml(
            "overlay: |\n  {\"inbounds\": [{\"type\": \"mixed\", \"tls\": {\"certificate_path\": \"/etc/passwd\"}}]}\n",
        ));
        let err = validate(&config).unwrap_err();
        assert!(err.contains("certificate_path"), "实际: {err}");
    }

    #[test]
    fn overlay_ech_nested_path_rejected() {
        let config = parse(&nodes_yaml(
            "overlay: |\n  {\"outbounds\": [{\"type\": \"vmess\", \"tls\": {\"ech\": {\"config_path\": \"/etc/passwd\"}}}]}\n",
        ));
        let err = validate(&config).unwrap_err();
        assert!(err.contains("config_path"), "实际: {err}");
    }

    #[test]
    fn build_url_strips_trailing_slash() {
        let url = build_url("https://sub.example.com/", "SOMECIPHER").unwrap();
        assert_eq!(url, "https://sub.example.com/sub?d=SOMECIPHER");
    }

    #[test]
    fn normalize_server_rejects_plain_host() {
        assert!(normalize_server("sub.example.com").is_err());
        assert!(normalize_server("  ").is_err());
        assert_eq!(
            normalize_server("https://sub.example.com//").unwrap(),
            "https://sub.example.com"
        );
    }

    /// template_url 进载荷并在本地先校验：非法 URL 在 encode 阶段就报错
    #[test]
    fn template_url_goes_into_payload() {
        let yaml = format!(
            "{}template_url: https://example.com/t.json\n",
            nodes_yaml("")
        );
        let payload = validate(&parse(&yaml)).unwrap();
        assert_eq!(payload["template_url"], "https://example.com/t.json");
    }

    #[test]
    fn absent_template_url_is_null_in_payload() {
        let payload = validate(&parse(&nodes_yaml(""))).unwrap();
        assert!(payload["template_url"].is_null());
    }

    #[test]
    fn blank_template_url_treated_as_absent() {
        let yaml = format!("{}template_url: \"   \"\n", nodes_yaml(""));
        let payload = validate(&parse(&yaml)).unwrap();
        assert!(payload["template_url"].is_null());
    }

    #[test]
    fn invalid_template_url_rejected_locally() {
        for bad in ["http://example.com/t.json", "https://127.0.0.1/t.json"] {
            let yaml = format!("{}template_url: {bad}\n", nodes_yaml(""));
            let err = validate(&parse(&yaml)).unwrap_err();
            assert!(
                err.contains("https") || err.contains("内网"),
                "{bad} 应被拒，实际: {err}"
            );
        }
    }

    /// 回归：禁用字段的报错文案不再写死「overlay」，因为远程底模走同一套拦截
    #[test]
    fn forbidden_field_message_is_not_overlay_specific() {
        let config = parse(&nodes_yaml(
            "overlay: |\n  {\"tls\": {\"key_path\": \"/etc/passwd\"}}\n",
        ));
        let err = validate(&config).unwrap_err();
        assert!(err.contains("禁用字段"), "实际: {err}");
    }
}
