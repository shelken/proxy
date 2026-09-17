#!/usr/bin/env bun
// 端点核心的单 URL 契约组装测试。
//
// 只断言外部可观察的产出：给定注入的解析结果与底模，配置长什么样。
// 解析后端经 deps.parse 注入假实现，因此这些用例不启动容器、不联网。
//
// 用法：bun test scripts/endpoint.test.js

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { POLICY_GROUPS, RESERVED_TAGS, buildConfig, serveEndpoint } from "./endpoint.mjs";

const TEMPLATE = JSON.parse(
  await Bun.file(`${import.meta.dir}/../config/sing-box/template.json`).text(),
);

/** 期望的策略组顺序：主分组在前，其余分流分组随后。 */
const GROUP_TAGS = ["proxy", ...POLICY_GROUPS];

function node(tag, type = "shadowsocks") {
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
function assemble(nodes, input = { source: "fixture" }) {
  return buildConfig(input, {
    parse: async () => structuredClone(nodes),
    template: TEMPLATE,
  });
}

function nodeTagsOf(config) {
  const groups = new Set(["selector", "urltest", "direct", "block", "dns"]);
  return config.outbounds
    .filter((outbound) => !groups.has(outbound.type))
    .map((outbound) => outbound.tag);
}

describe("buildConfig", () => {
  test("九个策略组齐全，主分组以首个节点为默认，其余跟随主分组", async () => {
    const config = await assemble([node("hk-01"), node("jp-02")]);
    const selectors = config.outbounds.filter((item) => item.type === "selector");

    expect(selectors.map((item) => item.tag)).toEqual(GROUP_TAGS);

    const main = selectors.find((item) => item.tag === "proxy");
    expect(main.outbounds).toEqual(["hk-01", "jp-02"]);
    expect(main.default).toBe("hk-01");

    for (const group of selectors.filter((item) => item.tag !== "proxy")) {
      expect(group.default).toBe("proxy");
      expect(group.outbounds).toEqual(["proxy", "hk-01", "jp-02"]);
    }
  });

  test("节点顺序与输入一致，且 direct 只出现一次", async () => {
    const config = await assemble([node("zulu"), node("alpha"), node("mike")]);

    expect(nodeTagsOf(config)).toEqual(["zulu", "alpha", "mike"]);
    expect(config.outbounds.filter((item) => item.tag === "direct")).toHaveLength(1);
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

    const tags = config.outbounds.map((item) => item.tag);
    expect(new Set(tags).size).toBe(tags.length);

    // 改名后分组引用的仍是这些节点，route.final 仍指向本仓库的主分组。
    const main = config.outbounds.find((item) => item.tag === "proxy");
    expect(main.outbounds).toEqual(nodeTagsOf(config));
    expect(config.route.final).toBe("proxy");
  });

  test("保留标签表与底模的契约一致", async () => {
    const referenced = new Set(
      TEMPLATE.route.rules
        .map((rule) => rule.outbound)
        .filter((tag) => tag !== undefined),
    );
    for (const tag of referenced) {
      expect(RESERVED_TAGS).toContain(tag);
    }
    expect(GROUP_TAGS).toHaveLength(9);
  });

  test("解析不出节点时当场失败", async () => {
    await expect(assemble([])).rejects.toThrow("未解析出任何节点");
  });

  test("内网参数缺省沿用底模，传入即覆盖", async () => {
    const defaults = await assemble([node("hk-01")]);
    expect(
      defaults.dns.servers.find((server) => server.tag === "dns-internal").server,
    ).toBe("192.168.6.1");
    expect(
      defaults.route.rule_set.find((item) => item.tag === "zone-internal").rules,
    ).toEqual([{ domain_suffix: ["ooooo.space"] }]);
    expect(defaults.route.final).toBe("proxy");
    expect(defaults.route.rule_set).toHaveLength(28);

    const overridden = await assemble([node("hk-01")], {
      source: "fixture",
      dns: "192.0.2.10",
      zone: "lab.test",
    });
    expect(
      overridden.dns.servers.find((server) => server.tag === "dns-internal").server,
    ).toBe("192.0.2.10");
    expect(
      overridden.route.rule_set.find((item) => item.tag === "zone-internal").rules,
    ).toEqual([{ domain_suffix: ["lab.test"] }]);
  });

  test("不改动传入的底模，同一模板可反复使用", async () => {
    const config = await assemble([node("hk-01")], {
      source: "fixture",
      dns: "192.0.2.10",
      zone: "lab.test",
    });

    expect(
      config.dns.servers.find((server) => server.tag === "dns-internal").server,
    ).toBe("192.0.2.10");
    expect(
      TEMPLATE.dns.servers.find((server) => server.tag === "dns-internal").server,
    ).toBe("192.168.6.1");
    expect(TEMPLATE.route.rule_set).toHaveLength(28);
    expect(TEMPLATE.route.rule_set.find((item) => item.tag === "zone-internal").rules).toEqual(
      [{ domain_suffix: ["ooooo.space"] }],
    );
  });
});

describe("serveEndpoint", () => {
  let server;

  beforeAll(async () => {
    server = await serveEndpoint({
      port: 0,
      deps: { parse: async () => [node("hk-01")], template: TEMPLATE },
    });
  });

  afterAll(() => server.stop(true));

  const endpoint = (path) => `http://127.0.0.1:${server.port}${path}`;
  const SUB = encodeURIComponent("https://example.test/sub");

  test("一条 URL 直出完整配置", async () => {
    const res = await fetch(endpoint(`/darwin?sub=${SUB}`));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");

    const config = await res.json();
    expect(
      config.outbounds.filter((item) => item.type === "selector").map((item) => item.tag),
    ).toEqual(GROUP_TAGS);
    expect(config.route.final).toBe("proxy");
    expect(config.route.rule_set).toHaveLength(28);
  });

  test("node 参数可重复，dns 与 zone 跟着 URL 走", async () => {
    const res = await fetch(
      endpoint(`/darwin?sub=${SUB}&node=ss%3A%2F%2Fa%3Ab%401.1.1.1%3A80%23x&dns=192.0.2.10&zone=lab.test`),
    );
    const config = await res.json();

    expect(config.dns.servers.find((server) => server.tag === "dns-internal").server).toBe(
      "192.0.2.10",
    );
    expect(config.route.rule_set.find((item) => item.tag === "zone-internal").rules).toEqual([
      { domain_suffix: ["lab.test"] },
    ]);
  });

  test("target 不在支持范围内 → 400 且不返回配置", async () => {
    const res = await fetch(endpoint(`/linux-router?sub=${SUB}`));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("不支持的 target");
    expect(body.outbounds).toBeUndefined();
  });

  test("缺 sub → 400", async () => {
    const res = await fetch(endpoint("/darwin"));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("缺少 sub");
  });

  test("解析失败 → 502，且响应里没有半成品配置", async () => {
    const broken = await serveEndpoint({
      port: 0,
      deps: {
        parse: async () => {
          throw new Error("解析后端不可用");
        },
        template: TEMPLATE,
      },
    });
    try {
      const res = await fetch(`http://127.0.0.1:${broken.port}/darwin?sub=${SUB}`);
      const body = await res.json();

      expect(res.status).toBe(502);
      expect(body.error).toContain("解析后端不可用");
      expect(body.outbounds).toBeUndefined();
    } finally {
      broken.stop(true);
    }
  });
});
