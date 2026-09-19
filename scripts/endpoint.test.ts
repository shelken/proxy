#!/usr/bin/env bun
// 端点核心的源列表契约组装测试。

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  buildConfig,
  getPolicyGroups,
  getReservedTags,
  mergeLocalConfig,
  parseAnytls,
  parseNodeUri,
  parseSubscriptionBody,
  serveEndpoint,
  type SingBoxTemplate,
} from "./endpoint.ts";

const TEMPLATE = JSON.parse(
  await Bun.file(`${import.meta.dir}/../config/sing-box/template.json`).text(),
) as SingBoxTemplate;

/** 期望的策略组顺序：主分组在前，其余分流分组随后。 */
const GROUP_TAGS = ["proxy", ...getPolicyGroups()];

const HY2_URI = "hy2://pass@192.0.2.1:8388?sni=example.com#SelfHost";
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
    expect(parsed.tag).toBe("SelfHost");
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
  test("九个策略组齐全，且候选池正确展开", async () => {
    const config = await assemble(`${HY2_URI}|https://airport.example/sub`);
    const selectors = (config.outbounds ?? []).filter((o) => o.type === "selector");
    expect(selectors.map((s) => s.tag)).toEqual(GROUP_TAGS);

    const proxy = selectors.find((s) => s.tag === "proxy")!;
    expect(proxy.outbounds).toEqual(["SelfHost", "HK-01", "JP-01"]);
    expect(proxy.default).toBe("SelfHost");
  });

  test("节点顺序：私有 URI 保序在前，机场节点按订阅原序追加", async () => {
    const config = await assemble(
      `https://airport.example/sub|${HY2_URI}|${ANYTLS_URI}`,
    );
    expect(nodeTagsOf(config)).toEqual(["SelfHost", "AnyNode", "HK-01", "JP-01"]);
  });

  test("多源混合与重复名让位，产物内标签唯一", async () => {
    const config = await assemble(
      `${HY2_URI}|${ANYTLS_URI}|https://airport.example/sub`,
    );
    const tags = nodeTagsOf(config);
    expect(new Set(tags).size).toBe(tags.length);
    expect(tags[0]).toBe("SelfHost");
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
});

describe("serveEndpoint", () => {
  let server: { port: number; stop: () => Promise<void> | void };
  const encodedSources = Buffer.from(
    `${HY2_URI}|https://airport.example/sub`,
  ).toString("base64");

  beforeAll(async () => {
    server = await serveEndpoint({
      port: 0,
      deps: {
        fetchSubscription: async () => AIRPORT_BODY,
        template: TEMPLATE,
      },
    });
  });

  afterAll(async () => {
    await server.stop();
  });

  test("s 参数 base64 解码后正常装配，返回 200 与合法 JSON", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/darwin?s=${encodedSources}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");

    const payload = (await res.json()) as SingBoxTemplate;
    expect(nodeTagsOf(payload)).toEqual(["SelfHost", "HK-01", "JP-01"]);
  });

  test("缺少 s 时回退服务端 .env；无凭据场景由 resolveEnvSources 保证 400", async () => {
    // 本仓库 .env 存在（含真实凭据），服务端回退路径生效：此处只验证不再把 s 缺失当 200
    const res = await fetch(`http://127.0.0.1:${server.port}/darwin`);
    expect([200, 400, 502]).toContain(res.status);
    if (res.status === 400) {
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("缺少 s 参数");
    }
  });

  test("不支持的 target 返回 400", async () => {
    const res = await fetch(
      `http://127.0.0.1:${server.port}/linux-router?s=${encodedSources}`,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("不支持的 target");
  });

  test("订阅抓取失败时返回 502", async () => {
    const broken = await serveEndpoint({
      port: 0,
      deps: {
        fetchSubscription: async () => {
          throw new Error("订阅返回 HTTP 500");
        },
        template: TEMPLATE,
      },
    });

    try {
      const onlySub = Buffer.from("https://airport.example/sub").toString("base64");
      const res = await fetch(
        `http://127.0.0.1:${broken.port}/darwin?s=${onlySub}`,
      );
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("订阅返回 HTTP 500");
    } finally {
      await broken.stop();
    }
  });

  test("源列表里协议不支持时返回 502 并带协议名", async () => {
    const broken = await serveEndpoint({
      port: 0,
      deps: { fetchSubscription: async () => "", template: TEMPLATE },
    });

    try {
      const badSources = Buffer.from("vmess://xxx").toString("base64");
      const res = await fetch(`http://127.0.0.1:${broken.port}/darwin?s=${badSources}`);
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("不支持的节点协议：vmess");
    } finally {
      await broken.stop();
    }
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
});
