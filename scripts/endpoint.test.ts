#!/usr/bin/env bun
// 端点核心的单 URL 契约组装测试。

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  POLICY_GROUPS,
  RESERVED_TAGS,
  buildConfig,
  serveEndpoint,
  type OutboundNode,
  type SingBoxTemplate,
} from "./endpoint.ts";

const TEMPLATE = JSON.parse(
  await Bun.file(`${import.meta.dir}/../config/sing-box/template.json`).text(),
) as SingBoxTemplate;

/** 期望的策略组顺序：主分组在前，其余分流分组随后。 */
const GROUP_TAGS = ["proxy", ...POLICY_GROUPS];

function node(tag: string, type = "shadowsocks"): OutboundNode {
  return {
    type,
    tag,
    server: "192.0.2.1",
    server_port: 8388,
    method: "aes-128-gcm",
    password: "fixture",
  };
}

/** 用注入的解析结果跑一次组装，返回产物。 */
function assemble(nodes: OutboundNode[], input = { source: "fixture" }) {
  return buildConfig(input, {
    parse: async () => structuredClone(nodes),
    template: TEMPLATE,
  });
}

function nodeTagsOf(config: SingBoxTemplate): string[] {
  const groups = new Set(["selector", "urltest", "direct", "block", "dns"]);
  return (config.outbounds ?? [])
    .filter((outbound) => !groups.has(outbound.type))
    .map((outbound) => outbound.tag);
}

describe("buildConfig", () => {
  test("九个策略组齐全，且候选池正确展开", async () => {
    const config = await assemble([node("hk-01"), node("jp-02")]);
    const selectors = (config.outbounds ?? []).filter((item) => item.type === "selector");

    expect(selectors.map((item) => item.tag)).toEqual(GROUP_TAGS);

    const main = selectors.find((item) => item.tag === "proxy")!;
    expect(main.outbounds).toEqual(["hk-01", "jp-02"]);
    expect(main.default).toBe("hk-01");

    const appleai = selectors.find((item) => item.tag === "appleai")!;
    expect(appleai.default).toBe("direct");
    expect(appleai.outbounds).toEqual(["direct", "proxy"]);
  });

  test("节点顺序与输入一致，且 direct 只出现一次", async () => {
    const config = await assemble([node("zulu"), node("alpha"), node("mike")]);

    expect(nodeTagsOf(config)).toEqual(["zulu", "alpha", "mike"]);
    expect((config.outbounds ?? []).filter((item) => item.tag === "direct")).toHaveLength(1);
  });

  test("节点名撞上保留标签或彼此重名时让位，产物内标签唯一", async () => {
    const config = await assemble([
      node("proxy"),
      node("openai"),
      node("dup"),
      node("dup"),
    ]);

    expect(nodeTagsOf(config)).toEqual([
      "proxy-node",
      "openai-node",
      "dup",
      "dup-node",
    ]);

    const allTags = (config.outbounds ?? []).map((outbound) => outbound.tag);
    expect(new Set(allTags).size).toBe(allTags.length);
  });

  test("保留标签表与底模的契约一致", () => {
    const expected = (TEMPLATE.outbounds ?? []).map((o) => o.tag);
    expect(RESERVED_TAGS).toEqual(expected);
  });

  test("解析不出节点时当场失败", async () => {
    await expect(assemble([])).rejects.toThrow("未解析出任何节点");
  });

  test("内网参数缺省沿用底模，传入即覆盖", async () => {
    const baseline = await assemble([node("hk-01")]);
    const baselineDns = baseline.dns?.servers?.find(
      (server) => server.tag === "dns-internal",
    )?.server;
    expect(baselineDns).toBe("192.168.6.1");

    const custom = await buildConfig(
      { source: "fixture", dns: "10.0.0.53", zone: "corp.internal" },
      {
        parse: async () => [node("hk-01")],
        template: TEMPLATE,
      },
    );

    const customDns = custom.dns?.servers?.find(
      (server) => server.tag === "dns-internal",
    )?.server;
    expect(customDns).toBe("10.0.0.53");

    const customZone = custom.route?.rule_set?.find(
      (ruleSet) => ruleSet.tag === "zone-internal",
    );
    expect(customZone?.rules).toEqual([{ domain_suffix: ["corp.internal"] }]);
  });

  test("不改动传入的底模，同一模板可反复使用", async () => {
    const snapshot = JSON.stringify(TEMPLATE);

    await buildConfig(
      { source: "fixture", dns: "10.0.0.53", zone: "corp.internal" },
      {
        parse: async () => [node("hk-01")],
        template: TEMPLATE,
      },
    );

    expect(JSON.stringify(TEMPLATE)).toBe(snapshot);
  });

  test("私有自建节点严格排在 Index 0，机场节点保持物理顺序追加", async () => {
    const config = await buildConfig(
      { sub: "https://example.com/sub", nodes: ["hysteria2://pass@1.1.1.1:443#SelfHost"] },
      {
        parse: async () => [node("US-Airport"), node("HK-Airport")],
        template: TEMPLATE,
      },
    );

    const tags = nodeTagsOf(config);
    expect(tags).toEqual(["SelfHost", "US-Airport", "HK-Airport"]);

    const main = (config.outbounds ?? []).find((item) => item.tag === "proxy")!;
    expect(main.outbounds).toEqual(["SelfHost", "US-Airport", "HK-Airport"]);
    expect(main.default).toBe("SelfHost");

    const openai = (config.outbounds ?? []).find((item) => item.tag === "openai")!;
    expect(openai.default).toBe("SelfHost");
    expect(openai.outbounds?.[0]).toBe("SelfHost");

    const gemini = (config.outbounds ?? []).find((item) => item.tag === "gemini")!;
    expect(gemini.default).toBe("openai");

    const appleai = (config.outbounds ?? []).find((item) => item.tag === "appleai")!;
    expect(appleai.default).toBe("direct");
  });
});

describe("serveEndpoint", () => {
  let server: { port: number; stop: () => Promise<void> | void };

  beforeAll(async () => {
    server = await serveEndpoint({
      port: 0,
      deps: {
        parse: async () => [node("hk-01"), node("jp-02")],
        template: TEMPLATE,
      },
    });
  });

  afterAll(async () => {
    await server.stop();
  });

  test("正常拉取返回 200 与合法 JSON", async () => {
    const res = await fetch(
      `http://127.0.0.1:${server.port}/darwin?sub=https://example.com/sub&node=hysteria2://pass@1.1.1.1:443%23my-node`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");

    const payload = (await res.json()) as SingBoxTemplate;
    const outboundTags = (payload.outbounds ?? []).map((outbound) => outbound.tag);
    expect(outboundTags).toContain("my-node");
    expect(outboundTags).toContain("hk-01");
  });

  test("缺少 sub 参数返回 400", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/darwin`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("缺少 sub 参数");
  });

  test("不支持的 target 返回 400", async () => {
    const res = await fetch(
      `http://127.0.0.1:${server.port}/linux-router?sub=https://example.com`,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("不支持的 target");
  });

  test("解析后端抛错时返回 502", async () => {
    const broken = await serveEndpoint({
      port: 0,
      deps: {
        parse: async () => {
          throw new Error("解析后端返回 HTTP 500");
        },
        template: TEMPLATE,
      },
    });

    try {
      const res = await fetch(
        `http://127.0.0.1:${broken.port}/darwin?sub=https://example.com`,
      );
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("解析后端返回 HTTP 500");
    } finally {
      await broken.stop();
    }
  });

  test("传了节点但解析不到任何节点时返回 502 而不是空数组", async () => {
    const broken = await serveEndpoint({
      port: 0,
      deps: {
        parse: async () => [],
        template: TEMPLATE,
      },
    });

    try {
      const res = await fetch(
        `http://127.0.0.1:${broken.port}/darwin?sub=https://example.com`,
      );
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("未解析出任何节点");
    } finally {
      await broken.stop();
    }
  });
});
