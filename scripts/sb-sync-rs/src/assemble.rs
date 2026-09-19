//! 装配：源列表 → 完整 sing-box 配置（订阅解析 + 标签唯一化 + 策略组填充 + local 覆盖）。
//! 语义对齐旧 endpoint.ts 的 buildConfig / mergeLocalConfig。

use serde_json::{json, Value};

/// 保留标签 = 底模 route.rules 引用的出站标签；节点名撞上时必须让位。
pub fn reserved_tags(template: &Value) -> Vec<String> {
    template["outbounds"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|o| o["tag"].as_str())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// 订阅原文 → 节点数组。base64 整段或纯 URI 列表均可；坏行带行号报错。
pub fn parse_subscription_body(body: &str) -> Result<Vec<Value>, String> {
    let mut decoded = body.trim().to_string();
    if !decoded.contains("://") {
        let normalized: String = decoded.chars().filter(|c| !c.is_whitespace()).collect();
        decoded = base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            normalized.as_bytes(),
        )
        .ok()
        .and_then(|b| String::from_utf8(b).ok())
        .ok_or("订阅内容 base64 解码失败")?;
    }
    let lines: Vec<&str> = decoded.split('\n').map(str::trim).filter(|l| !l.is_empty()).collect();
    if lines.is_empty() {
        return Err("订阅内容为空".into());
    }
    lines
        .iter()
        .enumerate()
        .map(|(i, line)| {
            crate::node::parse_node_uri(line)
                .map_err(|e| format!("订阅第 {} 行解析失败：{e}", i + 1))
        })
        .collect()
}

/// 节点标签唯一化：避开保留标签与彼此重名。
fn assign_tags(nodes: &mut [Value], reserved: &[String]) {
    let mut taken: std::collections::HashSet<String> = reserved.iter().cloned().collect();
    for (index, node) in nodes.iter_mut().enumerate() {
        let base = node["tag"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("node-{}", index + 1));
        let mut tag = base.clone();
        if taken.contains(&tag) {
            tag = format!("{base}-node");
            let mut suffix = 2;
            while taken.contains(&tag) {
                tag = format!("{base}-node-{suffix}");
                suffix += 1;
            }
        }
        node["tag"] = json!(tag);
        taken.insert(tag);
    }
}

/// 深度合并设备 local 覆盖：
/// dns.servers 按 tag 覆盖或前置追加；dns.rules / route.rules 置顶；outbounds 追加。
pub fn merge_local_config(template: &mut Value, local: &Value) {
    if !local.is_object() {
        return;
    }

    if let Some(local_dns) = local["dns"].as_object() {
        if let Some(servers) = local_dns.get("servers").and_then(Value::as_array) {
            if !template["dns"]["servers"].is_array() {
                template["dns"]["servers"] = json!([]);
            }
            let tpl_servers = template["dns"]["servers"].as_array_mut().unwrap();
            for server in servers {
                let Some(tag) = server["tag"].as_str() else { continue };
                match tpl_servers.iter().position(|s| s["tag"].as_str() == Some(tag)) {
                    Some(idx) => {
                        // 同 tag：浅覆盖（新字段胜出，原字段保留）
                        let merged = {
                            let base = tpl_servers[idx].as_object().cloned().unwrap_or_default();
                            let overlay = server.as_object().cloned().unwrap_or_default();
                            base.into_iter().chain(overlay).collect::<serde_json::Map<String, Value>>()
                        };
                        tpl_servers[idx] = Value::Object(merged);
                    }
                    None => tpl_servers.insert(0, server.clone()),
                }
            }
        }
        if let Some(rules) = local_dns.get("rules").and_then(Value::as_array) {
            if !rules.is_empty() {
                if !template["dns"]["rules"].is_array() {
                    template["dns"]["rules"] = json!([]);
                }
                let tpl_rules = template["dns"]["rules"].as_array_mut().unwrap();
                let mut new_rules = rules.clone();
                new_rules.extend(tpl_rules.drain(..));
                *template["dns"]["rules"].as_array_mut().unwrap() = new_rules;
            }
        }
    }

    if let Some(route_rules) = local["route"]["rules"].as_array() {
        if !route_rules.is_empty() {
            if !template["route"]["rules"].is_array() {
                template["route"]["rules"] = json!([]);
            }
            let tpl_rules = template["route"]["rules"].as_array_mut().unwrap();
            let mut new_rules = route_rules.clone();
            new_rules.extend(tpl_rules.drain(..));
            *template["route"]["rules"].as_array_mut().unwrap() = new_rules;
        }
    }

    if let Some(local_outbounds) = local["outbounds"].as_array() {
        if !template["outbounds"].is_array() {
            template["outbounds"] = json!([]);
        }
        let tpl = template["outbounds"].as_array_mut().unwrap();
        tpl.extend(local_outbounds.iter().cloned());
    }
}

/// 正则字符串 → regex（TS 版 (?i) 前缀语义对齐）。非法正则返回 None（该项跳过，不 fail）。
fn compile_pattern(item: &str) -> Option<regex::Regex> {
    // strip 后必须重新拼回 (?i)：直接用剥掉前缀的 pat 编译会变成大小写敏感，
    // 节点名的小写国家后缀（hk-01 等）全部漏匹配。
    match item.strip_prefix("(?i)") {
        Some(rest) => regex::Regex::new(&format!("(?i){rest}")).ok(),
        None => regex::Regex::new(item).ok(),
    }
}

/// 策略组填充：底模声明 selector/urltest 的 outbounds 占位项展开为真实节点标签。
fn populate_selectors(template: &Value, tags: &[String]) -> Vec<Value> {
    let declared: Vec<&Value> = template["outbounds"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter(|o| o["type"] == "selector" || o["type"] == "urltest")
                .collect()
        })
        .unwrap_or_default();
    let selector_tags: std::collections::HashSet<&str> =
        declared.iter().filter_map(|s| s["tag"].as_str()).collect();

    declared
        .into_iter()
        .map(|sel| {
            let mut expanded: Vec<String> = Vec::new();
            for item in sel["outbounds"].as_array().map(|a| a.iter()).unwrap_or_default() {
                let Some(item_str) = item.as_str() else { continue };
                if item_str == "direct" || selector_tags.contains(item_str) || tags.iter().any(|t| t == item_str) {
                    expanded.push(item_str.to_string());
                    continue;
                }
                if let Some(re) = compile_pattern(item_str) {
                    expanded.extend(tags.iter().filter(|t| re.is_match(t)).cloned());
                }
            }
            // 去重 + 排除自身
            let mut seen = std::collections::HashSet::new();
            expanded.retain(|t| t != sel["tag"].as_str().unwrap_or("") && seen.insert(t.clone()));
            let mut out = sel.clone();
            out["outbounds"] = json!(expanded);
            out
        })
        .collect::<Vec<Value>>()
}

#[derive(Default)]
pub struct AssembleInput {
    /// `|` 分隔的源列表：订阅 URL 与私有节点 URI 任意混合。
    pub sources: String,
    /// 设备 local 覆盖（可选）。
    pub local: Option<Value>,
    /// 订阅抓取注入点（测试用）。
    pub fetch_subscription: Option<Box<dyn Fn(&str) -> Result<String, String>>>,
}

/// 底模 → 完整配置。任何解析错误 fail-fast。
pub fn build_config(template: &Value, input: &AssembleInput) -> Result<Value, String> {
    let mut tpl = template.clone();

    if let Some(local) = &input.local {
        merge_local_config(&mut tpl, &local);
    }

    let reserved = reserved_tags(&tpl);
    let mut private_nodes: Vec<Value> = Vec::new();
    let mut airport_nodes: Vec<Value> = Vec::new();

    for source in input.sources.split('|').map(str::trim).filter(|s| !s.is_empty()) {
        if source.starts_with("http://") || source.starts_with("https://") {
            let body = match &input.fetch_subscription {
                Some(f) => f(source)?,
                None => crate::template::http_get(source)?,
            };
            airport_nodes.extend(parse_subscription_body(&body)?);
        } else {
            private_nodes.push(crate::node::parse_node_uri(source)?);
        }
    }

    let mut nodes: Vec<Value> = private_nodes;
    nodes.extend(airport_nodes);
    if nodes.is_empty() {
        return Err("未解析出任何节点：请检查源列表内容".into());
    }
    assign_tags(&mut nodes, &reserved);
    let tags: Vec<String> = nodes
        .iter()
        .filter_map(|n| n["tag"].as_str())
        .map(str::to_string)
        .collect();

    let selectors = populate_selectors(&tpl, &tags);

    let mut outbounds = vec![json!({"type": "direct", "tag": "direct"})];
    outbounds.extend(nodes);
    outbounds.extend(selectors);
    tpl["outbounds"] = Value::Array(outbounds);

    Ok(tpl)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 回归：(?i) 前缀必须保留大小写不敏感语义。
    /// 修复前 strip 掉前缀后直接编译，小写节点名（hk-02 等）全部漏匹配。
    #[test]
    fn case_insensitive_prefix_is_preserved() {
        let re = compile_pattern("(?i)(港|HK|Hong)").expect("编译失败");
        assert!(re.is_match("HK-01"));
        assert!(re.is_match("hk-02"));
        assert!(re.is_match("HkNode"));
        assert!(!re.is_match("JP-01"));

        let re2 = compile_pattern("(?i)(日本|川日|东京|大阪|泉日|埼玉|沪日|深日|JP|Japan)").unwrap();
        assert!(re2.is_match("jp-osaka-01"));
        assert!(re2.is_match("JP-01"));

        // 无前缀的模式保持原语义（大小写敏感）
        let re3 = compile_pattern("HK").unwrap();
        assert!(re3.is_match("HK-01"));
        assert!(!re3.is_match("hk-02"));
    }

    /// 回归：分组填充端到端——底模 HK 组 (?i) 模式应命中小写节点。
    #[test]
    fn hk_group_matches_lowercase_tags() {
        let tpl = crate::template::embedded_template();
        let input = AssembleInput {
            sources: "hy2://pass@192.0.2.1:8388#hk-02".into(),
            local: None,
            fetch_subscription: Some(Box::new(|_| Ok(String::new()))),
        };
        let config = build_config(&tpl, &input).unwrap();
        let hk = config["outbounds"]
            .as_array()
            .unwrap()
            .iter()
            .find(|o| o["tag"] == "hk")
            .expect("hk 组缺失");
        let expanded = hk["outbounds"].as_array().unwrap();
        assert!(
            expanded.iter().any(|t| t == "hk-02"),
            "hk 组应包含小写节点 hk-02，实际: {expanded:?}"
        );
    }
}
