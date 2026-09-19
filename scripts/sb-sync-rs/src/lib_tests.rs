//! 核心库测试：URI 解析、订阅解析、装配、local 覆盖合并。
//! 从 endpoint.test.ts 1:1 移植，断言对象与期望值一致（TS 版删除后为本文件）。

#[cfg(test)]
mod tests {
    use crate::assemble::{build_config, merge_local_config, parse_subscription_body, AssembleInput};
    use crate::node::{parse_anytls, parse_node_uri};
    use crate::template::embedded_template;
    use serde_json::{json, Value};

    const HY2_URI: &str = "hy2://pass@192.0.2.1:8388?sni=example.com#SelfHost";
    const ANYTLS_URI: &str = "anytls://pass2@192.0.2.2:8443?sni=cdn.example.net#AnyNode";

    /// 模拟机场订阅响应体：base64(URI 列表)，两行 ss URI（SIP002）。
    fn airport_body() -> String {
        let ss = |host: &str| {
            // base64("aes-128-gcm:fx") = YWVzLTEyOC1nY206Zng=
            format!("ss://YWVzLTEyOC1nY206Zng=@{host}:8388#TAGPLACEHOLDER")
        };
        let (a, b) = (ss("192.0.2.10"), ss("192.0.2.11"));
        let list = a.replace("TAGPLACEHOLDER", "HK-01") + "\n" + &b.replace("TAGPLACEHOLDER", "JP-01");
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(list)
    }

    fn node_tags_of(config: &Value) -> Vec<String> {
        let skip = ["selector", "urltest", "direct", "block", "dns"];
        config["outbounds"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter(|o| !skip.contains(&o["type"].as_str().unwrap_or("")))
                    .filter_map(|o| o["tag"].as_str())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default()
    }

    /// 用注入的订阅响应跑一次组装（源列表里必有 1 个机场订阅）。
    fn assemble(sources: &str) -> Value {
        let tpl = embedded_template();
        let input = AssembleInput {
            sources: sources.to_string(),
            local: None,
            fetch_subscription: Some(Box::new(|_| Ok(airport_body()))),
        };
        build_config(&tpl, &input).expect("装配失败")
    }

    #[test]
    fn hy2_uri_parses_to_hysteria2() {
        let parsed = parse_node_uri(HY2_URI).unwrap();
        assert_eq!(parsed["type"], "hysteria2");
        assert_eq!(parsed["tag"], "SelfHost");
        assert_eq!(parsed["server"], "192.0.2.1");
        assert_eq!(parsed["password"], "pass");
    }

    #[test]
    fn anytls_uri_maps_params() {
        let parsed = parse_anytls(ANYTLS_URI).unwrap();
        assert_eq!(parsed["type"], "anytls");
        assert_eq!(parsed["tag"], "AnyNode");
        assert_eq!(parsed["server_port"], 8443);
        assert_eq!(parsed["tls"]["enabled"], true);
        assert_eq!(parsed["tls"]["server_name"], "cdn.example.net");
    }

    #[test]
    fn ss_sip002_parses() {
        let uri = "ss://YWVzLTEyOC1nY206Zng=@192.0.2.10:8388#HK-01";
        let parsed = parse_node_uri(uri).unwrap();
        assert_eq!(parsed["type"], "shadowsocks");
        assert_eq!(parsed["tag"], "HK-01");
        assert_eq!(parsed["method"], "aes-128-gcm");
        assert_eq!(parsed["password"], "fx");
        assert_eq!(parsed["server_port"], 8388);
    }

    #[test]
    fn ss_legacy_whole_base64_parses() {
        use base64::Engine;
        let inner = "aes-128-gcm:fx@192.0.2.11:8388";
        let uri = format!(
            "ss://{}#JP-01",
            base64::engine::general_purpose::STANDARD.encode(inner)
        );
        let parsed = parse_node_uri(&uri).unwrap();
        assert_eq!(parsed["type"], "shadowsocks");
        assert_eq!(parsed["tag"], "JP-01");
        assert_eq!(parsed["server"], "192.0.2.11");
    }

    #[test]
    fn unsupported_protocol_errors_with_name() {
        let err = parse_node_uri("vmess://xxx").unwrap_err();
        assert!(err.contains("不支持的节点协议：vmess"), "实际: {err}");
    }

    #[test]
    fn subscription_body_decodes_and_parses_lines() {
        let nodes = parse_subscription_body(&airport_body()).unwrap();
        let tags: Vec<&str> = nodes.iter().filter_map(|n| n["tag"].as_str()).collect();
        assert_eq!(tags, vec!["HK-01", "JP-01"]);
    }

    #[test]
    fn subscription_bad_line_reports_line_number() {
        use base64::Engine;
        let bad = base64::engine::general_purpose::STANDARD
            .encode("vmess://broken\nss://YWVzLTEyOC1nY206Zng=@192.0.2.11:8388#JP-01");
        let err = parse_subscription_body(&bad).unwrap_err();
        assert!(err.contains("订阅第 1 行"), "实际: {err}");
    }

    #[test]
    fn nine_groups_populated_correctly() {
        let config = assemble(&format!("{HY2_URI}|https://airport.example/sub"));
        let selectors: Vec<&str> = config["outbounds"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|o| o["type"] == "selector")
            .filter_map(|o| o["tag"].as_str())
            .collect();
        // 底模声明 9 个 selector 组，顺序与底模一致
        let tpl = embedded_template();
        let tpl_selectors: Vec<&str> = tpl["outbounds"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|o| o["type"] == "selector")
            .filter_map(|o| o["tag"].as_str())
            .collect();
        assert_eq!(selectors, tpl_selectors);

        let proxy = config["outbounds"]
            .as_array()
            .unwrap()
            .iter()
            .find(|o| o["type"] == "selector" && o["tag"] == "proxy")
            .unwrap();
        assert_eq!(proxy["outbounds"], json!(["SelfHost", "HK-01", "JP-01"]));
        assert_eq!(proxy["default"], "SelfHost");
    }

    #[test]
    fn private_nodes_first_airport_appended_in_order() {
        let config = assemble(&format!("https://airport.example/sub|{HY2_URI}|{ANYTLS_URI}"));
        assert_eq!(node_tags_of(&config), vec!["SelfHost", "AnyNode", "HK-01", "JP-01"]);
    }

    #[test]
    fn duplicate_tags_yielded_unique() {
        let config = assemble(&format!("{HY2_URI}|{ANYTLS_URI}|https://airport.example/sub"));
        let tags = node_tags_of(&config);
        let set: std::collections::HashSet<&String> = tags.iter().collect();
        assert_eq!(set.len(), tags.len());
        assert_eq!(tags[0], "SelfHost");
    }

    #[test]
    fn reserved_tags_match_template() {
        let tpl = embedded_template();
        let reserved = crate::assemble::reserved_tags(&tpl);
        let expected: Vec<String> = tpl["outbounds"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|o| o["tag"].as_str())
            .map(str::to_string)
            .collect();
        assert_eq!(reserved, expected);
    }

    #[test]
    fn empty_sources_fails() {
        let tpl = embedded_template();
        let input = AssembleInput {
            sources: String::new(),
            local: None,
            fetch_subscription: Some(Box::new(|_| Ok(String::new()))),
        };
        let err = build_config(&tpl, &input).unwrap_err();
        assert!(err.contains("未解析出任何节点"), "实际: {err}");
    }

    #[test]
    fn public_template_has_no_private_internal_dns() {
        let baseline = assemble(HY2_URI);
        let has_internal = baseline["dns"]["servers"]
            .as_array()
            .map(|a| a.iter().any(|s| s["tag"] == "dns-internal"))
            .unwrap_or(false);
        assert!(!has_internal, "公共底模不应包含 dns-internal");

        let has_zone = baseline["route"]["rule_set"]
            .as_array()
            .map(|a| a.iter().any(|rs| rs["tag"] == "zone-internal"))
            .unwrap_or(false);
        assert!(!has_zone, "公共底模不应包含 zone-internal");
    }

    #[test]
    fn template_not_mutated_by_repeated_use() {
        let snapshot = embedded_template().to_string();
        let input = AssembleInput {
            sources: HY2_URI.to_string(),
            local: None,
            fetch_subscription: Some(Box::new(|_| Ok(String::new()))),
        };
        let _ = build_config(&embedded_template(), &input).unwrap();
        let _ = build_config(&embedded_template(), &input).unwrap();
        assert_eq!(embedded_template().to_string(), snapshot);
    }

    #[test]
    fn local_example_injects_dns_and_rule() {
        let local_text = include_str!("../../../config/sing-box/local.json.example");
        let local: Value = serde_json::from_str(local_text).unwrap();
        let tpl = embedded_template();
        let input = AssembleInput {
            sources: HY2_URI.to_string(),
            local: Some(local),
            fetch_subscription: Some(Box::new(|_| Ok(String::new()))),
        };
        let config = build_config(&tpl, &input).unwrap();

        let first_rule = &config["route"]["rules"][0];
        assert_eq!(
            first_rule["domain_suffix"],
            json!(["ooooo.space"]),
            "第一条规则应为 local 置顶的内网直连"
        );
        assert_eq!(first_rule["outbound"], "direct");

        let internal = config["dns"]["servers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["tag"] == "dns-internal")
            .expect("local 应注入 dns-internal");
        assert_eq!(internal["server"], "192.168.6.1");
    }

    #[test]
    fn same_name_dns_overrides_different_name_prepends() {
        let mut template = embedded_template();
        merge_local_config(
            &mut template,
            &json!({
                "dns": {
                    "servers": [
                        {"tag": "dns-foreign", "server": "9.9.9.9"},
                        {"tag": "dns-home", "type": "udp", "server": "192.168.6.1"}
                    ]
                }
            }),
        );
        let servers = template["dns"]["servers"].as_array().unwrap();
        let foreign = servers.iter().find(|s| s["tag"] == "dns-foreign").unwrap();
        assert_eq!(foreign["server"], "9.9.9.9");
        assert_eq!(servers[0]["tag"], "dns-home");
    }
}
