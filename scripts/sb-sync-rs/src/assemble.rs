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
    let lines: Vec<&str> = decoded
        .split('\n')
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
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
            .map_or_else(|| format!("node-{}", index + 1), str::to_string);
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

/// 节点全集 → 反回环直连规则（纯内存，由调用方决定归属）。
/// IP server → ip_cidr(/32|/128)；域名 server → domain + 尽力解析 IPv4 → ip_cidr。
/// 服务端视角解析：系统 getaddrinfo → DoH 兜底；两级都失败则只留 domain 规则。
pub fn generate_node_direct_rule(nodes: &[Value], _template: &Value) -> Option<Value> {
    let mut domains: Vec<String> = Vec::new();
    let mut cidrs: Vec<String> = Vec::new();
    for node in nodes {
        let Some(server) = node["server"].as_str() else {
            continue;
        };
        // url crate 的 host_str() 对 IPv6 返回 "[2001:db8::1]"，剥括号
        let server = server.trim().trim_start_matches('[').trim_end_matches(']');
        if server.is_empty() {
            continue;
        }
        if let Ok(ip) = server.parse::<std::net::IpAddr>() {
            let cidr = if ip.is_ipv6() {
                format!("{server}/128")
            } else {
                format!("{server}/32")
            };
            if !cidrs.contains(&cidr) {
                cidrs.push(cidr);
            }
        } else {
            if domains.iter().any(|d| d == server) {
                continue;
            }
            domains.push(server.to_string());
            // 服务端视角解析：系统 getaddrinfo（无 TUN/fakeip 场景）→ DoH 兜底
            if let Some(ip) = system_resolve_a(server).or_else(|| doh_resolve_a(server)) {
                let cidr = format!("{ip}/32");
                if !cidrs.contains(&cidr) {
                    cidrs.push(cidr);
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
            for item in sel["outbounds"]
                .as_array()
                .map(|a| a.iter())
                .unwrap_or_default()
            {
                let Some(item_str) = item.as_str() else {
                    continue;
                };
                if item_str == "direct"
                    || selector_tags.contains(item_str)
                    || tags.iter().any(|t| t == item_str)
                {
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

/// 订阅抓取函数类型。抽成别名以免在结构体字段里内联复杂类型。
pub type SubscriptionFetcher = Box<dyn Fn(&str) -> Result<String, String>>;

#[derive(Default)]
pub struct AssembleInput {
    /// `|` 分隔的源列表：订阅 URL 与私有节点 URI 任意混合。
    pub sources: String,
    /// 订阅抓取注入点（测试用）。
    pub fetch_subscription: Option<SubscriptionFetcher>,
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
    // 远程底模可能缺这一层；缺失时直接报错，避免产出的配置静默丢掉全部策略组
    if !template["outbounds"].is_array() {
        return Err("底模缺少 outbounds 数组".into());
    }

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

        let re2 =
            compile_pattern("(?i)(日本|川日|东京|大阪|泉日|埼玉|沪日|深日|JP|Japan)").unwrap();
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
        let mut tpl = crate::template::embedded_template().expect("内嵌底模");
        let input = AssembleInput {
            // 仅一个日本节点:kr/sg/tw/us/hk 等组展开为空,应整体消失
            sources: "hy2://pass@192.0.2.1:8388#jp-osaka-01".into(),
            fetch_subscription: Some(Box::new(|_| Ok(String::new()))),
        };
        let nodes = collect_nodes(&input.sources, &input).expect("节点解析");
        finalize(&mut tpl, nodes).expect("装配");
        let groups: Vec<&Value> = tpl["outbounds"]
            .as_array()
            .expect("outbounds 为数组")
            .iter()
            .filter(|o| o["type"] == "selector" || o["type"] == "urltest")
            .collect();
        assert!(
            groups
                .iter()
                .all(|g| !g["outbounds"].as_array().is_some_and(Vec::is_empty)),
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
        let mut tpl = crate::template::embedded_template().expect("内嵌底模");
        let input = AssembleInput {
            sources: "hy2://pass@192.0.2.1:8388#hk-02".into(),
            fetch_subscription: Some(Box::new(|_| Ok(String::new()))),
        };
        let nodes = collect_nodes(&input.sources, &input).expect("节点解析");
        finalize(&mut tpl, nodes).expect("装配");
        let hk = tpl["outbounds"]
            .as_array()
            .expect("outbounds 为数组")
            .iter()
            .find(|o| o["tag"] == "hk")
            .expect("hk 组缺失");
        let expanded = hk["outbounds"].as_array().expect("组内为数组");
        assert!(
            expanded.iter().any(|t| t == "hk-02"),
            "hk 组应包含小写节点 hk-02，实际: {expanded:?}"
        );
    }

    /// 回归：节点反回环规则生成——在"所有节点确定后"（collect_nodes 之后）调用，
    /// 覆盖 IP/IPv6/域名三类 server；域名用保留 TLD `.invalid` 保证解析必败，
    /// 测试封闭不依赖网络。
    #[test]
    fn node_direct_rule_generated_after_collect() {
        let tpl = crate::template::embedded_template().expect("内嵌底模");
        let input = AssembleInput {
            sources: "hy2://pass@192.0.2.1:8388#selfhost|hy2://pass@node.invalid:8388#dom|anytls://pass@[2001:db8::1]:8443#v6".into(),
            fetch_subscription: Some(Box::new(|_| Ok(String::new()))),
        };

        let nodes = collect_nodes(&input.sources, &input).expect("节点解析");
        let rule = generate_node_direct_rule(&nodes, &tpl).expect("应生成反回环规则");
        assert_eq!(rule["outbound"], "direct");
        let cidrs = rule["ip_cidr"].as_array().expect("应含 ip_cidr");
        for expected in ["192.0.2.1/32", "2001:db8::1/128"] {
            assert!(
                cidrs.iter().any(|c| c == expected),
                "ip_cidr 应含 {expected}，实际: {cidrs:?}"
            );
        }
        assert_eq!(
            rule["domain"],
            json!(["node.invalid"]),
            "域名 server 进 domain"
        );
    }

    /// finalize 的前置校验：底模缺 outbounds 时直接报错，不静默产出空策略组配置。
    #[test]
    fn finalize_rejects_template_without_outbounds() {
        let mut tpl = json!({"route": {"rules": []}});
        let input = AssembleInput {
            sources: "hy2://pass@192.0.2.1:8388#a".into(),
            fetch_subscription: Some(Box::new(|_| Ok(String::new()))),
        };
        let nodes = collect_nodes(&input.sources, &input).expect("节点解析");
        let err = finalize(&mut tpl, nodes).expect_err("应拒绝缺 outbounds 的底模");
        assert!(err.contains("outbounds"), "实际: {err}");
    }

    /// 同一 server 出现多次时不得产生重复 cidr（重复项会被 sing-box 拒）。
    /// 只用 IP 字面量：域名会走本机解析，结果随环境变（TUN 劫持返回 fakeip）。
    #[test]
    fn node_direct_rule_deduplicates() {
        let tpl = crate::template::embedded_template().expect("内嵌底模");
        let input = AssembleInput {
            sources: "hy2://pass@192.0.2.1:8388#a|hy2://pass@192.0.2.1:8443#b|\
                      anytls://pass@[2001:db8::1]:8443#c|anytls://pass@[2001:db8::1]:9443#d"
                .into(),
            fetch_subscription: Some(Box::new(|_| Ok(String::new()))),
        };
        let nodes = collect_nodes(&input.sources, &input).expect("节点解析");
        let rule = generate_node_direct_rule(&nodes, &tpl).expect("应生成反回环规则");
        let cidrs = rule["ip_cidr"].as_array().expect("应含 ip_cidr");
        assert_eq!(
            cidrs.len(),
            2,
            "两个不同 server 各留一个 cidr，实际: {cidrs:?}"
        );
        for expected in ["192.0.2.1/32", "2001:db8::1/128"] {
            assert!(
                cidrs.iter().any(|c| c == expected),
                "ip_cidr 应含 {expected}，实际: {cidrs:?}"
            );
        }
        assert_eq!(
            cidrs.iter().filter(|c| *c == "192.0.2.1/32").count(),
            1,
            "同 IP 只留一个"
        );
    }

    /// 模拟机场订阅响应体：base64(URI 列表)，两行 ss URI（SIP002）。
    /// 与旧 endpoint.test.ts 的 AIRPORT_BODY 同构，保证两端期望值可比对。
    fn airport_body() -> String {
        use base64::Engine;
        let userinfo = base64::engine::general_purpose::STANDARD.encode("aes-128-gcm:fx");
        let plain =
            format!("ss://{userinfo}@192.0.2.10:8388#HK-01\nss://{userinfo}@192.0.2.11:8388#JP-01");
        base64::engine::general_purpose::STANDARD.encode(plain)
    }

    fn input_with_fetcher(sources: &str, body: &str) -> AssembleInput {
        let owned = body.to_string();
        AssembleInput {
            sources: sources.into(),
            fetch_subscription: Some(Box::new(move |_| Ok(owned.clone()))),
        }
    }

    /// 订阅正文 base64 解码后逐行解析，保持原行序。
    /// 顺序错了会让节点入池顺序变，进而影响策略组候选池。
    #[test]
    fn subscription_body_decodes_lines_in_order() {
        let nodes = parse_subscription_body(&airport_body()).expect("订阅解析失败");
        let tags: Vec<String> = nodes
            .iter()
            .filter_map(|n| n["tag"].as_str().map(str::to_string))
            .collect();
        assert_eq!(tags, vec!["HK-01", "JP-01"]);
    }

    /// 坏行报错必须带行号：订阅动辄上百行，没有行号无从定位。
    /// 首行坏、末行坏都要报出正确行号（差一错误会让人找到相邻的正确行）。
    #[test]
    fn subscription_body_reports_line_number_on_bad_line() {
        use base64::Engine;
        let bad_first = base64::engine::general_purpose::STANDARD
            .encode("vmess://broken\nss://YWVzLTEyOC1nY206Zng=@192.0.2.11:8388#JP-01");
        let err = parse_subscription_body(&bad_first).expect_err("首行坏应报错");
        assert!(err.contains("订阅第 1 行"), "实际: {err}");

        let userinfo = base64::engine::general_purpose::STANDARD.encode("aes-128-gcm:fx");
        let bad_last = base64::engine::general_purpose::STANDARD
            .encode(format!("ss://{userinfo}@192.0.2.10:8388#HK-01\ntrojan://x"));
        let err2 = parse_subscription_body(&bad_last).expect_err("末行坏应报错");
        assert!(err2.contains("订阅第 2 行"), "实际: {err2}");
    }

    /// 空订阅正文直接报错，不产出空节点列表（否则下游会产出空策略组）。
    #[test]
    fn subscription_body_rejects_empty() {
        let err = parse_subscription_body("   ").expect_err("空订阅应报错");
        assert!(err.contains("订阅内容"), "实际: {err}");
    }

    /// 标签唯一化：节点名撞上保留标签（底模 outbounds 的 tag）时必须让位，
    /// 否则同 tag 重复出站会被 sing-box 拒绝。
    /// selfhost 是底模 urltest 组保留 tag，同名的 hy2 节点让位为 selfhost-node。
    #[test]
    fn node_tag_yields_to_reserved_template_tags() {
        let mut tpl = crate::template::embedded_template().expect("内嵌底模");
        let input = input_with_fetcher(
            "hy2://pass@192.0.2.1:8388#selfhost|anytls://pass@192.0.2.2:8443#AnyNode",
            "",
        );
        let nodes = collect_nodes(&input.sources, &input).expect("节点解析");
        finalize(&mut tpl, nodes).expect("装配");

        let tags: Vec<&str> = tpl["outbounds"]
            .as_array()
            .expect("outbounds 为数组")
            .iter()
            .filter(|o| o["type"] != "selector" && o["type"] != "urltest")
            .filter(|o| o["type"] != "direct")
            .filter_map(|o| o["tag"].as_str())
            .collect();
        assert_eq!(
            tags,
            vec!["selfhost-node", "AnyNode"],
            "撞保留标签的节点须改名，未撞的保持原名"
        );
    }

    /// 节点重名时的让位链：第二个同名节点加 -node 后缀，第三个再叠加序号，
    /// 且节点互相之间也必须唯一（保留标签之外的第二层冲突）。
    #[test]
    fn duplicate_node_tags_get_unique_suffixes() {
        let mut tpl = crate::template::embedded_template().expect("内嵌底模");
        let input = input_with_fetcher(
            "hy2://pass@192.0.2.1:8388#dup|hy2://pass@192.0.2.2:8388#dup|hy2://pass@192.0.2.3:8388#dup",
            "",
        );
        let nodes = collect_nodes(&input.sources, &input).expect("节点解析");
        finalize(&mut tpl, nodes).expect("装配");

        let mut tags: Vec<&str> = tpl["outbounds"]
            .as_array()
            .expect("outbounds 为数组")
            .iter()
            .filter(|o| o["type"] == "hysteria2")
            .filter_map(|o| o["tag"].as_str())
            .collect();
        tags.sort_unstable();
        assert_eq!(tags, vec!["dup", "dup-node", "dup-node-2"]);
    }

    /// 节点顺序：私有 URI 保序前插，机场节点按订阅原序追加。
    /// 源列表里机场写在最前也一样，私有节点优先是刻意约定。
    #[test]
    fn private_nodes_precede_airport_nodes_in_order() {
        let input = input_with_fetcher(
            "https://airport.example/sub|hy2://pass@192.0.2.1:8388#selfhost|anytls://pass@192.0.2.2:8443#AnyNode",
            &airport_body(),
        );
        let nodes = collect_nodes(&input.sources, &input).expect("节点解析");
        let tags: Vec<&str> = nodes.iter().filter_map(|n| n["tag"].as_str()).collect();
        assert_eq!(
            tags,
            vec!["selfhost", "AnyNode", "HK-01", "JP-01"],
            "私有节点按源列表顺序在前，机场节点按订阅行序在后"
        );
    }

    /// 策略组候选池展开的完整契约：
    /// - 全部 selector 按底模顺序保留（跳过无节点的组）
    /// - proxy 组池 = selfhost 组引用 + 让位节点 + 机场节点，默认 selfhost
    /// - 组内引用先于节点，去重且不包含自身
    #[test]
    fn policy_groups_expand_candidates_in_template_order() {
        let mut tpl = crate::template::embedded_template().expect("内嵌底模");
        let input = input_with_fetcher(
            "hy2://pass@192.0.2.1:8388#selfhost|https://airport.example/sub",
            &airport_body(),
        );
        let nodes = collect_nodes(&input.sources, &input).expect("节点解析");
        finalize(&mut tpl, nodes).expect("装配");

        let outbounds = tpl["outbounds"].as_array().expect("outbounds 为数组");
        let selectors: Vec<&Value> = outbounds
            .iter()
            .filter(|o| o["type"] == "selector")
            .collect();

        // 底模的 selector 顺序：proxy 在首位，其余依次
        let selector_tags: Vec<&str> = selectors.iter().filter_map(|s| s["tag"].as_str()).collect();
        assert_eq!(
            selector_tags,
            vec![
                "proxy",
                "openai",
                "gemini",
                "dev",
                "adultnsfw",
                "appleai",
                "ptcg",
                "japansite",
                "opencode",
                "zai",
                "microsoft",
                "apple",
                "paypal",
                "grok",
                "1024",
                "tailscale",
            ],
            "selector 组集合与底模顺序"
        );

        let proxy = selectors
            .iter()
            .find(|s| s["tag"] == "proxy")
            .expect("proxy 组缺失");
        // selfhost 是 urltest 组引用（先于节点），"selfhost" 节点已让位为 selfhost-node，
        // 由 .* 模式展开在尾部
        assert_eq!(
            proxy["outbounds"],
            json!(["selfhost", "selfhost-node", "HK-01", "JP-01"]),
            "proxy 池：组引用在前，节点按入池顺序在后"
        );
        assert_eq!(proxy["default"], json!("selfhost"));
    }

    /// urltest 组同样是填充对象，且 selfhost 组须按模式命中让位后的节点。
    #[test]
    fn urltest_groups_are_populated() {
        let mut tpl = crate::template::embedded_template().expect("内嵌底模");
        let input = input_with_fetcher(
            "hy2://pass@192.0.2.1:8388#selfhost|hy2://pass@192.0.2.2:8388#hk-02",
            "",
        );
        let nodes = collect_nodes(&input.sources, &input).expect("节点解析");
        finalize(&mut tpl, nodes).expect("装配");

        let outbounds = tpl["outbounds"].as_array().expect("outbounds 为数组");
        let selfhost = outbounds
            .iter()
            .find(|o| o["type"] == "urltest" && o["tag"] == "selfhost")
            .expect("selfhost urltest 组缺失");
        assert_eq!(
            selfhost["outbounds"],
            json!(["selfhost-node"]),
            "selfhost 组模式 (?i)(vps|hy2|selfhost) 应命中让位后的 selfhost-node"
        );
    }

    /// 保留标签表 = 底模 outbounds 的全部 tag，与底模契约一致。
    /// 这张表决定节点改名，漂移会让节点与策略组引用对不上。
    #[test]
    fn reserved_tags_match_template_outbound_tags() {
        let tpl = crate::template::embedded_template().expect("内嵌底模");
        let expected: Vec<String> = tpl["outbounds"]
            .as_array()
            .expect("outbounds 为数组")
            .iter()
            .filter_map(|o| o["tag"].as_str().map(str::to_string))
            .collect();
        assert_eq!(reserved_tags(&tpl), expected);
        assert!(
            expected.contains(&"selfhost".to_string()),
            "selfhost 应在保留表内（节点名撞上须让位）"
        );
    }

    /// 解析不出节点时当场失败，不产出空配置。
    #[test]
    fn empty_sources_fail_fast() {
        let input = input_with_fetcher("", "");
        let err = collect_nodes(&input.sources, &input).expect_err("空源应报错");
        assert!(err.contains("未解析出任何节点"), "实际: {err}");
    }

    /// 公共底模不得含私有 DNS 与内网直连规则：
    /// 这些是设备本地专有内容，混进公共产物会泄露内网拓扑。
    #[test]
    fn public_template_has_no_private_dns_or_zone_rules() {
        let tpl = crate::template::embedded_template().expect("内嵌底模");
        let dns_tags: Vec<&str> = tpl["dns"]["servers"]
            .as_array()
            .map(|a| a.iter().filter_map(|s| s["tag"].as_str()).collect())
            .unwrap_or_default();
        assert!(
            !dns_tags.contains(&"dns-internal"),
            "公共底模不应含 dns-internal，实际: {dns_tags:?}"
        );

        let rule_set_tags: Vec<&str> = tpl["route"]["rule_set"]
            .as_array()
            .map(|a| a.iter().filter_map(|s| s["tag"].as_str()).collect())
            .unwrap_or_default();
        assert!(
            !rule_set_tags.contains(&"zone-internal"),
            "公共底模不应含 zone-internal"
        );
    }
}
