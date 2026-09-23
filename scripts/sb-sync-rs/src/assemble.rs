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
        // node_direct_rule 独立于 rules 数组存在：用户没写自定义规则时也要合并
        let node_rule = local["route"]["node_direct_rule"].clone();
        if !route_rules.is_empty() || node_rule.is_object() {
            if !template["route"]["rules"].is_array() {
                template["route"]["rules"] = json!([]);
            }
            let tpl_rules = template["route"]["rules"].as_array_mut().unwrap();
            let mut new_rules = route_rules.clone();
            // sb-sync 自动维护的反回环规则压过用户 local 置顶规则（防回环优先级最高）
            if node_rule.is_object() {
                new_rules.insert(0, node_rule);
            }
            new_rules.extend(tpl_rules.drain(..));
            *template["route"]["rules"].as_array_mut().unwrap() = new_rules;
        }
    } else if let Some(node_rule) = local["route"].get("node_direct_rule") {
        if node_rule.is_object() {
            if !template["route"]["rules"].is_array() {
                template["route"]["rules"] = json!([]);
            }
            let tpl_rules = template["route"]["rules"].as_array_mut().unwrap();
            let mut new_rules = vec![node_rule.clone()];
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

/// 节点全集 → 反回环直连规则（纯内存，由调用方决定归属）。
/// IP server → ip_cidr(/32|/128)；域名 server → domain + 尽力解析 IPv4 → ip_cidr。
/// 服务端视角解析：系统 getaddrinfo → DoH 兜底；两级都失败则只留 domain 规则。
pub fn generate_node_direct_rule(nodes: &[Value], _template: &Value) -> Option<Value> {

    let mut domains: Vec<String> = Vec::new();
    let mut cidrs: Vec<String> = Vec::new();
    for node in nodes {
        let Some(server) = node["server"].as_str() else { continue };
        // url crate 的 host_str() 对 IPv6 返回 "[2001:db8::1]"，剥括号
        let server = server.trim().trim_start_matches('[').trim_end_matches(']');
        if server.is_empty() {
            continue;
        }
        match server.parse::<std::net::IpAddr>() {
            Ok(ip) => {
                let cidr = if ip.is_ipv6() { format!("{server}/128") } else { format!("{server}/32") };
                if !cidrs.contains(&cidr) {
                    cidrs.push(cidr);
                }
            }
            Err(_) => {
                if domains.iter().any(|d| d == server) {
                    continue;
                }
                domains.push(server.to_string());
                // 服务端视角解析：系统 getaddrinfo（无 TUN/fakeip 场景）→ DoH 兜底
                let ip = system_resolve_a(server).or_else(|| doh_resolve_a(server));
                if let Some(ip) = ip {
                    let cidr = format!("{ip}/32");
                    if !cidrs.contains(&cidr) {
                        cidrs.push(cidr);
                    }
                }
            }
        }
    }
    if domains.is_empty() && cidrs.is_empty() {
        return None;
    }
    let mut rule = serde_json::Map::new();
    if !domains.is_empty() {
        rule.insert("domain".into(), json!(domains));
    }
    if !cidrs.is_empty() {
        rule.insert("ip_cidr".into(), json!(cidrs));
    }
    rule.insert("outbound".into(), json!("direct"));
    Some(Value::Object(rule))
}

/// std getaddrinfo 解析：返回首个 IPv4。服务端无 TUN 劫持，无需 fakeip 排除。
fn system_resolve_a(domain: &str) -> Option<String> {
    use std::net::ToSocketAddrs;
    (domain, 0u16)
        .to_socket_addrs()
        .ok()?
        .find_map(|a| match a.ip() {
            std::net::IpAddr::V4(v4) => Some(v4.to_string()),
            std::net::IpAddr::V6(_) => None,
        })
}

/// AliDNS DoH JSON API：返回首个合法 IPv4 A 记录；任何失败静默 None。
fn doh_resolve_a(domain: &str) -> Option<String> {
    use std::io::Read;
    let url = format!("https://223.5.5.5/resolve?name={domain}&type=A");
    let res = ureq::get(&url)
        .timeout(std::time::Duration::from_secs(5))
        .call()
        .ok()?;
    let mut body = String::new();
    res.into_reader()
        .take(64 * 1024)
        .read_to_string(&mut body)
        .ok()?;
    let v: Value = serde_json::from_str(&body).ok()?;
    v["Answer"]
        .as_array()?
        .iter()
        .filter(|a| a["type"] == 1)
        .filter_map(|a| a["data"].as_str())
        .find(|d| d.parse::<std::net::Ipv4Addr>().is_ok())
        .map(str::to_string)
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
        .filter_map(|sel| {
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
            if expanded.is_empty() {
                // 空组(订阅无匹配节点)会让 sing-box FATAL "missing tags",整体跳过:
                // 产物少一个组,路由不炸(国家组均不被 route 规则引用)。
                eprintln!(
                    "[sb-sync] 策略组 '{}' 无匹配节点,已跳过(订阅缺少该地区节点或模式失效)",
                    sel["tag"].as_str().unwrap_or("?")
                );
                return None;
            }
            let mut out = sel.clone();
            out["outbounds"] = json!(expanded);
            Some(out)
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

/// 解析全部源 → 节点全集（私有节点保序前插，机场订阅原序追加）。
/// 这是"所有节点确定"的唯一时点：反回环规则必须在此之后、装配之前生成。
pub fn collect_nodes(sources: &str, input: &AssembleInput) -> Result<Vec<Value>, String> {
    let mut private_nodes: Vec<Value> = Vec::new();
    let mut airport_nodes: Vec<Value> = Vec::new();

    for source in sources.split('|').map(str::trim).filter(|s| !s.is_empty()) {
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

    let mut nodes = private_nodes;
    nodes.extend(airport_nodes);
    if nodes.is_empty() {
        return Err("未解析出任何节点：请检查源列表内容".into());
    }
    Ok(nodes)
}

/// 节点全集 + 底模 → 填充完 outbounds 的完整配置（纯内存，零网络）。
pub fn finalize(template: &mut Value, nodes: Vec<Value>) -> Result<(), String> {
    let reserved = reserved_tags(template);
    let mut nodes = nodes;
    assign_tags(&mut nodes, &reserved);
    let tags: Vec<String> = nodes
        .iter()
        .filter_map(|n| n["tag"].as_str())
        .map(str::to_string)
        .collect();

    let selectors = populate_selectors(template, &tags);

    let mut outbounds = vec![json!({"type": "direct", "tag": "direct"})];
    outbounds.extend(nodes);
    outbounds.extend(selectors);
    template["outbounds"] = Value::Array(outbounds);
    Ok(())
}

/// 底模 → 完整配置。任何解析错误 fail-fast。
/// 生产路径（main.rs）已拆为 collect_nodes → generate → finalize；此函数保留给
/// 测试与 TS 版对齐用（单次调用完成全流程，local 由调用方先行 merge）。
#[cfg_attr(not(test), allow(dead_code))]
pub fn build_config(template: &Value, input: &AssembleInput) -> Result<Value, String> {
    let mut tpl = template.clone();

    if let Some(local) = &input.local {
        merge_local_config(&mut tpl, &local);
    }

    let nodes = collect_nodes(&input.sources, input)?;
    finalize(&mut tpl, nodes)?;
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

    /// 回归:订阅无匹配节点时空 urltest 组会被 sing-box 拒绝(missing tags),
    /// 装配器必须跳过该组而不是产出空 outbounds。
    #[test]
    fn empty_group_is_skipped() {
        let tpl = crate::template::embedded_template();
        let input = AssembleInput {
            // 仅一个日本节点:kr/sg/tw/us/hk 等组展开为空,应整体消失
            sources: "hy2://pass@192.0.2.1:8388#jp-osaka-01".into(),
            local: None,
            fetch_subscription: Some(Box::new(|_| Ok(String::new()))),
        };
        let config = build_config(&tpl, &input).unwrap();
        let groups: Vec<&Value> = config["outbounds"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|o| o["type"] == "selector" || o["type"] == "urltest")
            .collect();
        assert!(
            groups.iter().all(|g| !g["outbounds"].as_array().unwrap().is_empty()),
            "任何策略组都不应为空: {groups:?}"
        );
        assert!(
            groups.iter().any(|g| g["tag"] == "jp"),
            "jp 组应保留(有匹配节点)"
        );
        assert!(
            !groups.iter().any(|g| g["tag"] == "kr"),
            "kr 组应被跳过(无匹配节点)"
        );
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

    /// 回归：节点反回环规则生成——在"所有节点确定后"（collect_nodes 之后）调用，
    /// 覆盖 IP/IPv6/域名三类 server；域名用保留 TLD `.invalid` 保证解析必败，
    /// 测试封闭不依赖网络。build_config 本体不得改动产物路由（规则归属 local）。
    #[test]
    fn node_direct_rule_generated_after_collect() {
        let tpl = crate::template::embedded_template();
        let input = AssembleInput {
            sources: "hy2://pass@192.0.2.1:8388#selfhost|hy2://pass@node.invalid:8388#dom|anytls://pass@[2001:db8::1]:8443#v6".into(),
            local: None,
            fetch_subscription: Some(Box::new(|_| Ok(String::new()))),
        };
        let config = build_config(&tpl, &input).unwrap();
        assert!(
            config["route"]["rules"][0].get("ip_cidr").is_none(),
            "build_config 不应直接注入规则(归属 local)"
        );

        let nodes = collect_nodes(&input.sources, &input).unwrap();
        let rule = generate_node_direct_rule(&nodes, &tpl).expect("应生成反回环规则");
        assert_eq!(rule["outbound"], "direct");
        let cidrs = rule["ip_cidr"].as_array().expect("应含 ip_cidr");
        for expected in ["192.0.2.1/32", "2001:db8::1/128"] {
            assert!(
                cidrs.iter().any(|c| c == expected),
                "ip_cidr 应含 {expected}，实际: {cidrs:?}"
            );
        }
        assert_eq!(rule["domain"], json!(["node.invalid"]), "域名 server 进 domain");
    }

    /// 回归：node_direct_rule 在 local 无自定义 rules 时也必须合并置顶（吞规则 bug），
    /// 且压过用户 local 自带置顶规则。
    #[test]
    fn node_direct_rule_merges_above_local_rules() {
        let tpl = crate::template::embedded_template();

        // 场景 1: local 只有 node_direct_rule，无自定义 rules
        let mut merged = tpl.clone();
        merge_local_config(&mut merged, &json!({
            "route": {"node_direct_rule": {
                "domain": ["node.invalid"], "ip_cidr": ["192.0.2.1/32"], "outbound": "direct"
            }}
        }));
        let rules = merged["route"]["rules"].as_array().unwrap();
        assert_eq!(
            rules[0],
            json!({"domain": ["node.invalid"], "ip_cidr": ["192.0.2.1/32"], "outbound": "direct"}),
            "仅 node_direct_rule 时也应置顶合并"
        );

        // 场景 2: local 同时有用户置顶规则 → 反回环压过它
        let mut merged = tpl.clone();
        merge_local_config(&mut merged, &json!({
            "route": {
                "node_direct_rule": {"domain": ["node.invalid"], "outbound": "direct"},
                "rules": [{"domain_suffix": ["home.example"], "outbound": "direct"}]
            }
        }));
        let rules = merged["route"]["rules"].as_array().unwrap();
        assert_eq!(rules[0]["domain"], json!(["node.invalid"]), "反回环置顶");
        assert_eq!(rules[1]["domain_suffix"], json!(["home.example"]), "用户规则紧随");
    }
}
