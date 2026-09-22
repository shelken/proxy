#!/usr/bin/env bun
// 端点核心的源列表契约组装测试。

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  buildConfig,
  generateNodeDirectRule,
  getPolicyGroups,
  getReservedTags,
  mergeLocalConfig,
  parseAnytls,
  parseNodeUri,
  parseSubscriptionBody,
  type SingBoxTemplate,
} from "./endpoint.ts";

const TEMPLATE = JSON.parse(
  await Bun.file(`${import.meta.dir}/../config/sing-box/template.json`).text(),
) as SingBoxTemplate;

/** 期望的策略组顺序：主分组在前，其余分流分组随后。 */
const GROUP_TAGS = ["proxy", ...getPolicyGroups()];

const HY2_URI = "hy2://pass@192.0.2.1:8388?sni=example.com#selfhost";
const ANYTLS_URI = "anytls://pass2@192.0.2.2:8443?sni=cdn.example.net#AnyNode";
/** 模拟机场订阅响应体：base64(URI 列表)，两行 ss URI（SIP002）。 */
const AIRPORT_BODY = Buffer.from(
  [
    `ss://${Buffer.from("aes-128-gcm:fx").toString("base64")}@192.0.2.10:8388#HK-01`,
    `ss://${Buffer.from("aes-128-gcm:fx").toString("base64")}@192.0.2.11:8388#JP-01`,
  ].join("\n"),
).toString("base64");

function nodeTagsOf(config: SingBoxTemplate): string[] {
  const groups = new Set(["selector", "urltest", "direct", "block", "dns"]);
  return (config.outbounds ?? [])
    .filter((outbound) => !groups.has(outbound.type))
    .map((outbound) => outbound.tag);
}

/** 用注入的订阅响应跑一次组装（源列表里必有 1 个机场订阅）。 */
function assemble(sources: string, inputOverride: Partial<{ sources: string; localConfigPath: string }> = {}, airportBody = AIRPORT_BODY) {
  return buildConfig(
    { sources, ...inputOverride },
    {
      fetchSubscription: async () => airportBody,
      template: TEMPLATE,
    },
  );
}

describe("parseNodeUri / parseSubscriptionBody", () => {
  test("hy2 URI 解析出 hysteria2 出站", () => {
    const parsed = parseNodeUri(HY2_URI);
    expect(parsed.type).toBe("hysteria2");
    expect(parsed.tag).toBe("selfhost");
    expect(parsed.server).toBe("192.0.2.1");
    expect(parsed.password).toBe("pass");
  });

  test("anytls URI 解析出 anytls 出站，参数映射正确", () => {
    const parsed = parseAnytls(ANYTLS_URI);
    expect(parsed.type).toBe("anytls");
    expect(parsed.tag).toBe("AnyNode");
    expect(parsed.server_port).toBe(8443);
    expect(parsed.tls).toMatchObject({ enabled: true, server_name: "cdn.example.net" });
  });

  test("ss URI（SIP002）解析出 shadowsocks 出站", () => {
    const uri = `ss://${Buffer.from("aes-128-gcm:fx").toString("base64")}@192.0.2.10:8388#HK-01`;
    const parsed = parseNodeUri(uri);
    expect(parsed.type).toBe("shadowsocks");
    expect(parsed.tag).toBe("HK-01");
    expect(parsed.method).toBe("aes-128-gcm");
    expect(parsed.password).toBe("fx");
    expect(parsed.server_port).toBe(8388);
  });

  test("ss URI（legacy 整段 base64）解析成功", () => {
    const inner = "aes-128-gcm:fx@192.0.2.11:8388";
    const uri = `ss://${Buffer.from(inner).toString("base64")}#JP-01`;
    const parsed = parseNodeUri(uri);
    expect(parsed.type).toBe("shadowsocks");
    expect(parsed.tag).toBe("JP-01");
    expect(parsed.server).toBe("192.0.2.11");
  });

  test("不支持的协议带协议名报错", () => {
    expect(() => parseNodeUri("vmess://xxx")).toThrow("不支持的节点协议：vmess");
  });

  test("订阅正文 base64 解码后逐行解析", () => {
    const nodes = parseSubscriptionBody(AIRPORT_BODY);
    expect(nodes.map((n) => n.tag)).toEqual(["HK-01", "JP-01"]);
  });

  test("订阅正文里不支持的行带行号报错", () => {
    const bad = Buffer.from("vmess://broken\nss://YWVzLTEyOC1nY206Zng=@192.0.2.11:8388#JP-01").toString("base64");
    expect(() => parseSubscriptionBody(bad)).toThrow("订阅第 1 行");
  });
});

describe("buildConfig", () => {
  test("全部策略组齐全，且候选池正确展开", async () => {
    const config = await assemble(`${HY2_URI}|https://airport.example/sub`);
    const outbounds = config.outbounds ?? [];

    // selfhost urltest 组存在且排在主分组前（底模顺序）
    const selfhost = outbounds.find((o) => o.type === "urltest" && o.tag === "selfhost");
    expect(selfhost?.outbounds).toEqual(["selfhost-node"]);

    const selectors = outbounds.filter((o) => o.type === "selector");
    expect(selectors.map((s) => s.tag)).toEqual(GROUP_TAGS);

    const proxy = selectors.find((s) => s.tag === "proxy")!;
    // "selfhost" 为 urltest 组引用；同名节点让位为 selfhost-node 由 .* 展开
    expect(proxy.outbounds).toEqual(["selfhost", "selfhost-node", "HK-01", "JP-01"]);
    expect(proxy.default).toBe("selfhost");
  });

  test("节点顺序：私有 URI 保序在前，机场节点按订阅原序追加", async () => {
    const config = await assemble(
      `https://airport.example/sub|${HY2_URI}|${ANYTLS_URI}`,
    );
    // "selfhost" 现为 urltest 组的保留 tag，同名节点自动改名
    expect(nodeTagsOf(config)).toEqual(["selfhost-node", "AnyNode", "HK-01", "JP-01"]);
  });

  test("多源混合与重复名让位，产物内标签唯一", async () => {
    const config = await assemble(
      `${HY2_URI}|${ANYTLS_URI}|https://airport.example/sub`,
    );
    const tags = nodeTagsOf(config);
    expect(new Set(tags).size).toBe(tags.length);
    // "selfhost" 为 urltest 组保留 tag，同名节点让位
    expect(tags[0]).toBe("selfhost-node");
  });

  test("保留标签表与底模的契约一致", () => {
    const expected = (TEMPLATE.outbounds ?? []).map((o) => o.tag);
    expect(getReservedTags()).toEqual(expected);
  });

  test("解析不出节点时当场失败", async () => {
    await expect(assemble("")).rejects.toThrow("未解析出任何节点");
  });

  test("公共底模不包含任何私有 zone-internal 或内网私有 DNS", async () => {
    // localConfigPath 置空路径显式禁用本机 local.json 注入，保证断言的是"装配器公共产物"
    const baseline = await assemble(HY2_URI, { localConfigPath: "/nonexistent/local.json" });
    const baselineDns = baseline.dns?.servers?.find(
      (server) => server.tag === "dns-internal",
    );
    expect(baselineDns).toBeUndefined();

    const zoneSet = baseline.route?.rule_set?.find(
      (ruleSet) => ruleSet.tag === "zone-internal",
    );
    expect(zoneSet).toBeUndefined();
  });

  test("不改动传入的底模，同一模板可反复使用", async () => {
    const snapshot = JSON.stringify(TEMPLATE);

    await buildConfig(
      { sources: HY2_URI },
      { fetchSubscription: async () => "", template: TEMPLATE },
    );

    expect(JSON.stringify(TEMPLATE)).toBe(snapshot);
  });

  test("支持本地专有配置 (local.json) 注入私有 DNS 与内网直连规则", async () => {
    const examplePath = `${import.meta.dir}/../config/sing-box/local.json.example`;
    const config = await buildConfig(
      { sources: HY2_URI, localConfigPath: examplePath },
      { fetchSubscription: async () => "", template: TEMPLATE },
    );

    const firstRule = config.route?.rules?.[0] as Record<string, unknown>;
    expect(firstRule?.domain_suffix).toEqual(["ooooo.space"]);
    expect(firstRule?.outbound).toBe("direct");

    const internalDns = config.dns?.servers?.find((s) => s.tag === "dns-internal");
    expect(internalDns?.server).toBe("192.168.6.1");
  });

  test("节点反回环: generateNodeDirectRule 在所有节点确定后生成, buildConfig 不直改路由", async () => {
    const config = await buildConfig(
      {
        sources:
          "hy2://pass@192.0.2.1:8388#selfhost|anytls://pass@[2001:db8::1]:8443#v6|hy2://pass@node.invalid:8388#dom",
      },
      { fetchSubscription: async () => "", template: TEMPLATE },
    );
    // buildConfig 本体不得改动产物路由（规则归属 local）
    expect((config.route?.rules?.[0] as Record<string, unknown>)?.ip_cidr).toBeUndefined();

    const rule = (await generateNodeDirectRule(config.outbounds ?? [], TEMPLATE)) as Record<string, unknown>;
    expect(rule).not.toBeNull();
    expect(rule.outbound).toBe("direct");
    const cidrs = rule.ip_cidr as string[];
    expect(cidrs).toContain("192.0.2.1/32");
    expect(cidrs).toContain("2001:db8::1/128");
    expect(rule.domain).toEqual(["node.invalid"]);
  });
});


describe("mergeLocalConfig", () => {
  test("同名 dns server 覆盖，不同名前置插入", () => {
    const template = JSON.parse(JSON.stringify(TEMPLATE)) as SingBoxTemplate;
    mergeLocalConfig(template, {
      dns: {
        servers: [
          { tag: "dns-foreign", server: "9.9.9.9" },
          { tag: "dns-home", type: "udp", server: "192.168.6.1" },
        ],
      },
    });

    const servers = template.dns?.servers ?? [];
    expect(servers.find((s) => s.tag === "dns-foreign")?.server).toBe("9.9.9.9");
    expect(servers[0].tag).toBe("dns-home");
  });

  test("node_direct_rule 在 local 无自定义 rules 时也置顶合并, 压过用户规则", () => {
    const template = JSON.parse(JSON.stringify(TEMPLATE)) as SingBoxTemplate;
    mergeLocalConfig(template, {
      route: {
        node_direct_rule: {
          domain: ["node.invalid"],
          ip_cidr: ["192.0.2.1/32"],
          outbound: "direct",
        },
      },
    } as never);
    const rules = template.route?.rules ?? [];
    expect(rules[0]).toMatchObject({ ip_cidr: ["192.0.2.1/32"], outbound: "direct" });

    const template2 = JSON.parse(JSON.stringify(TEMPLATE)) as SingBoxTemplate;
    mergeLocalConfig(template2, {
      route: {
        node_direct_rule: { domain: ["node.invalid"], outbound: "direct" },
        rules: [{ domain_suffix: ["home.example"], outbound: "direct" }],
      },
    } as never);
    const rules2 = template2.route?.rules ?? [];
    expect(rules2[0]).toMatchObject({ domain: ["node.invalid"] });
    expect(rules2[1]).toMatchObject({ domain_suffix: ["home.example"] });
  });
});
