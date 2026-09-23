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
    /// 服务端基础地址，如 https://sub.example.com
    pub server: String,
    /// 服务端 X25519 公钥（64 字符 Hex）
    pub server_public_key: String,
    /// 机场订阅链接列表（可选）
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub subs: Vec<String>,
    /// 私有节点 URI 列表（可选，支持 hysteria2/hy2/anytls/ss）
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub nodes: Vec<String>,
    /// 原生 sing-box JSON 覆盖层文本（可选，多行字符串）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overlay: Option<String>,
}

/// 深度遍历 JSON，禁止出现任何路径引用字段（含 ECH 嵌套）。
fn reject_path_fields(value: &Value) -> Result<(), String> {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                if FORBIDDEN_PATH_FIELDS.contains(&key.as_str()) {
                    return Err(format!(
                        "overlay 含禁用字段 `{key}`：服务端 merge 会读取该路径并内联服务器文件，\
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
    if config.server.is_empty() {
        return Err("`server` 不能为空".into());
    }
    if !config.server.starts_with("https://") && !config.server.starts_with("http://") {
        return Err(format!(
            "`server` 必须以 http(s):// 开头，当前: {}",
            config.server
        ));
    }
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
            let v: Value = serde_json::from_str(text)
                .map_err(|e| format!("overlay JSON 解析失败: {e}"))?;
            if !v.is_object() {
                return Err("overlay 顶层必须是 JSON Object".into());
            }
            reject_path_fields(&v)?;
            Some(v)
        }
        _ => None,
    };

    // 载荷序列化：只包含有意义的字段（服务端按此结构还原）
    let payload = serde_json::json!({
        "subs": config.subs,
        "nodes": config.nodes,
        "overlay": overlay_value,
    });
    Ok(payload)
}

/// 读取并解析 YAML 配置文件。
pub fn load_config(path: &Path) -> Result<ClientConfig, String> {
    let content = std::fs::read_to_string(path)
        .map_err(|e| format!("读取配置 {} 失败: {e}", path.display()))?;
    let config: ClientConfig = serde_yaml::from_str(&content)
        .map_err(|e| format!("YAML 解析失败: {e}"))?;
    Ok(config)
}

/// 校验并加密，返回 base64url 编码的密文包。
pub fn encode_payload(config: &ClientConfig) -> Result<String, String> {
    let payload = validate(config)?;
    let server_pk = crypto::parse_public_key_hex(&config.server_public_key)?;
    let plaintext = serde_json::to_vec(&payload).map_err(|e| format!("载荷序列化失败: {e}"))?;
    crypto::encrypt_payload(&server_pk, &plaintext)
}

/// 组装完整订阅 URL：`{server}/sub?d={ciphertext}`
pub fn build_url(config: &ClientConfig, ciphertext: &str) -> Result<String, String> {
    let base = config.server.trim_end_matches('/');
    if base.is_empty() {
        return Err("`server` 不能为空".into());
    }
    Ok(format!("{base}/sub?d={ciphertext}"))
}

/// 生成新的 X25519 公私钥对（Hex），用于服务端部署初始化。
pub fn keygen() -> (String, String) {
    crypto::generate_keypair_hex()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_yaml() -> String {
        let (_, pk_hex) = crate::crypto::generate_keypair_hex();
        format!(
            "server: https://sub.example.com\nserver_public_key: {pk_hex}\nsubs:\n  - https://airport.example/sub\n"
        )
    }

    fn parse(yaml: &str) -> ClientConfig {
        serde_yaml::from_str(yaml).expect("YAML 解析失败")
    }

    #[test]
    fn valid_config_encodes() {
        let yaml = valid_yaml();
        let config = parse(&yaml);
        let payload = validate(&config).expect("校验通过");
        assert_eq!(payload["subs"].as_array().unwrap().len(), 1);
        assert!(payload["overlay"].is_null());
    }

    #[test]
    fn empty_sources_rejected() {
        let (_, pk_hex) = crate::crypto::generate_keypair_hex();
        let yaml = format!("server: https://sub.example.com\nserver_public_key: {pk_hex}\n");
        let config = parse(&yaml);
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

    #[test]
    fn overlay_must_be_object() {
        let (_, pk_hex) = crate::crypto::generate_keypair_hex();
        let yaml = format!(
            "server: https://sub.example.com\nserver_public_key: {pk_hex}\nnodes:\n  - hy2://pass@192.0.2.1:8388?sni=example.com#selfhost\noverlay: |\n  [1, 2, 3]\n"
        );
        let config = parse(&yaml);
        let err = validate(&config).unwrap_err();
        assert!(err.contains("JSON Object"), "实际: {err}");
    }

    #[test]
    fn overlay_invalid_json_rejected() {
        let (_, pk_hex) = crate::crypto::generate_keypair_hex();
        let yaml = format!(
            "server: https://sub.example.com\nserver_public_key: {pk_hex}\nnodes:\n  - hy2://pass@192.0.2.1:8388#x\noverlay: |\n  {{not-json}}\n"
        );
        let config = parse(&yaml);
        let err = validate(&config).unwrap_err();
        assert!(err.contains("overlay JSON 解析失败"), "实际: {err}");
    }

    #[test]
    fn overlay_certificate_path_rejected() {
        let (_, pk_hex) = crate::crypto::generate_keypair_hex();
        let yaml = format!(
            "server: https://sub.example.com\nserver_public_key: {pk_hex}\nnodes:\n  - hy2://pass@192.0.2.1:8388#x\noverlay: |\n  {{\"inbounds\": [{{\"type\": \"mixed\", \"tls\": {{\"certificate_path\": \"/etc/passwd\"}}}}]}}\n"
        );
        let config = parse(&yaml);
        let err = validate(&config).unwrap_err();
        assert!(err.contains("certificate_path"), "实际: {err}");
    }

    #[test]
    fn overlay_ech_nested_path_rejected() {
        let (_, pk_hex) = crate::crypto::generate_keypair_hex();
        let yaml = format!(
            "server: https://sub.example.com\nserver_public_key: {pk_hex}\nnodes:\n  - hy2://pass@192.0.2.1:8388#x\noverlay: |\n  {{\"outbounds\": [{{\"type\": \"vmess\", \"tls\": {{\"ech\": {{\"config_path\": \"/etc/passwd\"}}}}}}]}}\n"
        );
        let config = parse(&yaml);
        let err = validate(&config).unwrap_err();
        assert!(err.contains("config_path"), "实际: {err}");
    }

    #[test]
    fn build_url_strips_trailing_slash() {
        let (_, pk_hex) = crate::crypto::generate_keypair_hex();
        let config = ClientConfig {
            server: "https://sub.example.com/".into(),
            server_public_key: pk_hex,
            subs: vec!["https://a.example/s".into()],
            nodes: vec![],
            overlay: None,
        };
        let url = build_url(&config, "SOMECIPHER").unwrap();
        assert_eq!(url, "https://sub.example.com/sub?d=SOMECIPHER");
    }
}
