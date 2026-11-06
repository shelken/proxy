#!/usr/bin/env bun
// 规则编译器的单元测试。
//
// 只驱动纯转换逻辑（不联网、不写仓库目录），因此不依赖任何上游列表的当前内容。
// 用法：bun test scripts/rules-compile.test.ts

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  emitClash,
  emitPlain,
  emitSingbox,
  emitSingboxDns,
  externalUrls,
  orphanCustomLists,
  parseYamlAst,
  type RuleAST,
  type SingBoxRule,
} from "./rules-compile.ts";
import { artifactName, type Rule } from "./settings.ts";

/** 取出某个字段的全部值，跨 rule 合并。 */
function fieldValues(rules: SingBoxRule[], field: string): unknown[] {
  return rules.flatMap((rule) => (rule[field] as unknown[]) ?? []);
}

function singboxRules(ast: RuleAST): SingBoxRule[] {
  return JSON.parse(emitSingbox(ast)).rules;
}

describe("外部原生引用", () => {
  test("geosite:/geoip: 展开为三端同源 URL", () => {
    const urls = externalUrls("geosite:telegram")!;
    expect(urls.singbox).toBe(
      "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo/geosite/telegram.srs",
    );
    expect(urls.clash).toBe(
      "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geosite/telegram.yaml",
    );
    expect(urls.plain).toBe(
      "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geosite/telegram.list",
    );

    const geoip = externalUrls("geoip:cn")!;
    expect(geoip.singbox).toContain("/geoip/cn.srs");
  });

  test("本地路径与非引用格式返回 null", () => {
    expect(externalUrls("config/rules/custom/Adult.yaml")).toBeNull();
    expect(externalUrls("geosite:")).toBeNull();
    expect(externalUrls("geosite:Bad_Name!")).toBeNull();
    expect(externalUrls("http://example.com/x.list")).toBeNull();
  });
});

describe("内部 YAML AST 解析", () => {
  test("紧凑字典展开为各字段数组，连字符键名归一化", () => {
    const yaml = `
rules:
  - domain_suffix:
      - example.com
  - domain-keyword:
      - ads
  - port: 8080
  - ip-asn:
      - 396982
`;
    const ast = parseYamlAst(yaml);
    expect(ast.domain_suffix).toEqual(["example.com"]);
    expect(ast.domain_keyword).toEqual(["ads"]);
    expect(ast.port).toEqual([8080]);
    expect(ast.ip_asn).toEqual(["396982"]);
  });

  test("同字段跨条目去重合并", () => {
    const ast = parseYamlAst(`
rules:
  - domain_suffix: [a.test]
  - domain_suffix: [b.test]
  - domain_suffix: [a.test]
`);
    expect(ast.domain_suffix).toEqual(["a.test", "b.test"]);
  });

  test("logical 节点原样进树", () => {
    const ast = parseYamlAst(`
rules:
  - logical:
      - mode: and
        rules:
          - domain_suffix: online
          - domain_keyword: ads-
`);
    expect(ast.logical).toHaveLength(1);
    expect(ast.logical![0].mode).toBe("and");
  });

  test("logical 条目必须包含 mode 与 rules 数组", () => {
    expect(() => parseYamlAst("rules:\n  - logical:\n      - domain_suffix: x\n")).toThrow(
      /mode 与 rules/,
    );
  });

  test("顶层与 rules 容器形态错误直接抛错", () => {
    expect(() => parseYamlAst("- a\n- b\n")).toThrow(/顶层必须是对象/);
    expect(() => parseYamlAst("foo: bar\n")).toThrow(/缺少 rules/);
    expect(() => parseYamlAst("rules: null\n")).toThrow(/缺少 rules/);
  });

  test("未知字段直接抛错，不静默丢规则", () => {
    expect(() => parseYamlAst("rules:\n  - user-agent:\n      - SomeApp*\n")).toThrow(
      /未知的规则字段/,
    );
  });

  test("已删除的零使用字段按未知字段报错", () => {
    for (const f of [
      "domain_regex",
      "source_ip_cidr",
      "port_range",
      "source_port",
      "source_port_range",
      "network",
    ]) {
      expect(() => parseYamlAst(`rules:\n  - ${f}: x\n`)).toThrow(/未知的规则字段/);
    }
  });

  test("非标量字段值（null/映射对象/嵌套数组）构建期报错，不字符串化", () => {
    expect(() => parseYamlAst("rules:\n  - domain_suffix:\n      domains:\n        - example.com\n")).toThrow(
      /必须是字符串或数字/,
    );
    expect(() => parseYamlAst("rules:\n  - domain_suffix: null\n")).toThrow(/必须是字符串或数字/);
    expect(() => parseYamlAst("rules:\n  - domain_suffix:\n      - - a.test\n")).toThrow(
      /必须是字符串或数字/,
    );
    expect(() => parseYamlAst("rules:\n  - port: not-a-number\n")).toThrow(/必须是数字/);
  });

  test("logical 叶节点必须是白名单内的单字段标量，连字符键名归一化", () => {
    expect(() =>
      parseYamlAst("rules:\n  - logical:\n      - mode: and\n        rules:\n          - user-agent: X\n"),
    ).toThrow(/logical 未知字段/);
    expect(() =>
      parseYamlAst("rules:\n  - logical:\n      - mode: and\n        rules:\n          - domain_suffix: [a.test, b.test]\n"),
    ).toThrow(/单个标量/);
    expect(() =>
      parseYamlAst("rules:\n  - logical:\n      - mode: and\n        rules:\n          - domain_suffix: a.test\n            port: 443\n"),
    ).toThrow(/恰好一个字段/);
    const ast = parseYamlAst(
      "rules:\n  - logical:\n      - mode: and\n        rules:\n          - domain-suffix: a.test\n",
    );
    expect(ast.logical![0].rules).toEqual([{ domain_suffix: "a.test" }]);
  });
});

describe("emitSingbox", () => {
  test("字段映射：域名/IP/端口/进程各自成规则，值合并去重", () => {
    const rules = singboxRules({
      domain: ["a.test"],
      domain_suffix: ["b.test", "c.test"],
      domain_keyword: ["keyword"],
      ip_cidr: ["10.0.0.0/8,no-resolve", "2001:db8::/32"],
      port: [443],
      process_name: ["curl"],
    });

    expect(fieldValues(rules, "domain")).toEqual(["a.test"]);
    expect(fieldValues(rules, "domain_suffix")).toEqual(["b.test", "c.test"]);
    expect(fieldValues(rules, "domain_keyword")).toEqual(["keyword"]);
    // no-resolve 是 mihomo/Loon 专用选项，sing-box 规则集剥离
    expect(fieldValues(rules, "ip_cidr")).toEqual(["10.0.0.0/8", "2001:db8::/32"]);
    expect(fieldValues(rules, "port")).toEqual([443]);
    expect(fieldValues(rules, "process_name")).toEqual(["curl"]);
  });

  test("结构化逻辑规则完整保留为 logical 树", () => {
    const rules = singboxRules({
      logical: [
        {
          mode: "and",
          rules: [
            { mode: "or", rules: [{ domain_suffix: "online" }, { domain_suffix: "site" }] },
            { domain_keyword: "assets-" },
          ],
        },
      ],
    });
    expect(rules).toHaveLength(1);
    expect(rules[0].type).toBe("logical");
    expect(rules[0].mode).toBe("and");
    const sub = (rules[0].rules as SingBoxRule[])[0];
    expect(sub.mode).toBe("or");
    expect((sub.rules as SingBoxRule[]).length).toBe(2);
  });

  test("NOT 单子节点折叠为 invert，双重否定还原", () => {
    const not = singboxRules({ logical: [{ mode: "not", rules: [{ domain: "a.test" }] }] });
    expect(not[0]).toEqual({ domain: ["a.test"], invert: true });

    const double = singboxRules({
      logical: [{ mode: "not", rules: [{ mode: "not", rules: [{ domain: "a.test" }] }] }],
    });
    expect(double[0]).toEqual({ domain: ["a.test"] });
  });

  test("空 AST 产出空规则集", () => {
    expect(JSON.parse(emitSingbox({}))).toEqual({ version: 3, rules: [] });
  });
});

describe("emitSingboxDns", () => {
  test("只保留按查询名匹配的字段", () => {
    // DNS 规则在拿到响应前只能按查询名判定，IP 类条目在 DNS 规则里没有可判定语义。
    const dns = JSON.parse(
      emitSingboxDns({
        domain: ["a.test"],
        domain_suffix: ["cn"],
        ip_cidr: ["10.0.0.0/8"],
        port: [443],
      }),
    );
    expect(dns.rules).toEqual([{ domain: ["a.test"] }, { domain_suffix: ["cn"] }]);
  });

  test("没有域名条目的列表产出空规则集，而不是构建失败", () => {
    // 空规则集是合法的（内核接受 rules: []），且任何清单都可能被设备 overlay 的
    // DNS 规则引用；构建期无法预知谁会被引用，所以这里不能抛错。
    expect(JSON.parse(emitSingboxDns({ ip_cidr: ["10.0.0.0/8"] }))).toEqual({
      version: 3,
      rules: [],
    });
  });

  test("叶子全为域名字段的逻辑树保留，混合树丢弃", () => {
    const dns = JSON.parse(
      emitSingboxDns({
        logical: [
          { mode: "and", rules: [{ domain_suffix: "online" }, { domain_keyword: "assets-" }] },
          { mode: "and", rules: [{ domain_suffix: "x" }, { port: 443 }] },
        ],
      }),
    );
    expect(dns.rules).toEqual([
      { type: "logical", mode: "and", rules: [{ domain_suffix: ["online"] }, { domain_keyword: ["assets-"] }] },
    ]);
  });
});

describe("emitClash（mihomo classical）", () => {
  test("字段展开为 classical 行，no-resolve 保留", () => {
    const text = emitClash({
      domain: ["a.test"],
      ip_cidr: ["1.1.1.1/32,no-resolve"],
      ip_asn: ["396982,no-resolve"],
      port: [22],
    });
    expect(text).toContain("- 'DOMAIN,a.test'");
    expect(text).toContain("- 'IP-CIDR,1.1.1.1/32,no-resolve'");
    expect(text).toContain("- 'IP-ASN,396982,no-resolve'");
    expect(text).toContain("- 'DST-PORT,22'");
  });

  test("空 AST 产出空 payload", () => {
    expect(emitClash({})).toBe("payload: []\n");
  });
});

describe("emitPlain（Loon / Surge）", () => {
  test("DEST-PORT 拼写、IPv6 用 IP-CIDR6", () => {
    const text = emitPlain({
      port: [22],
      ip_cidr: ["240e::/18,no-resolve", "1.1.1.1/32,no-resolve"],
    });
    expect(text).toContain("DEST-PORT,22");
    expect(text).toContain("IP-CIDR6,240e::/18,no-resolve");
    expect(text).toContain("IP-CIDR,1.1.1.1/32,no-resolve");
  });
});


describe("产物命名与孤儿检测", () => {
  test("产物名保留 CJK，折叠非法字符", () => {
    expect(artifactName("小米追踪")).toBe("小米追踪");
    expect(artifactName("My/Weird Tag")).toBe("My_Weird_Tag");
    expect(artifactName("***")).toBe("rule");
  });

  test("只在 custom/ 放文件、不写进 settings 时能被识别为孤儿", () => {
    // 真实踩过的坑：把新列表丢进 custom/ 就以为 CI 会发现它。
    // settings.yaml 的 rules 是唯一入口，孤儿文件不产出任何规则，所以必须显式提醒。
    const referenced = {
      name: "Known",
      source: "../rules/custom/MyReject.yaml",
      to: "reject",
      kind: "local",
      artifact: "Known",
      companion: true,
      path: "config/rules/custom/MyReject.yaml",
    } as Rule;
    const orphans = orphanCustomLists([referenced]);
    expect(orphans).toContain("config/rules/custom/OpenAI.yaml");
    expect(orphans).not.toContain("config/rules/custom/MyReject.yaml");
  });
});

describe("真实 custom 文件端到端", () => {
  test("Adult.yaml 三条嵌套逻辑规则在三端完整保留", () => {
    const ast = parseYamlAst(readFileSync("config/rules/custom/Adult.yaml", "utf-8"));
    expect(ast.domain_keyword).toContain("123av");

    const parsed = JSON.parse(emitSingbox(ast)) as { rules: Record<string, unknown>[] };
    expect(parsed.rules.filter((r) => r.type === "logical")).toHaveLength(3);

    expect(emitClash(ast)).toContain("AND,((OR,((DOMAIN-SUFFIX,online)");
    expect(emitPlain(ast)).toContain("AND,((OR,((DOMAIN-SUFFIX,online)");
  });

  test("ptcg.yaml 的 IP-ASN 在 mihomo/Loon 端保留 no-resolve", () => {
    const ast = parseYamlAst(readFileSync("config/rules/custom/ptcg.yaml", "utf-8"));
    expect(emitClash(ast)).toContain("'IP-ASN,396982,no-resolve'");
    expect(emitPlain(ast)).toContain("IP-ASN,396982,no-resolve");
  });

  test("Lan.yaml 保留私网 IP 段与本地域名", () => {
    const ast = parseYamlAst(readFileSync("config/rules/custom/Lan.yaml", "utf-8"));
    expect(ast.ip_cidr).toContain("192.168.0.0/16,no-resolve");
    expect(ast.domain_suffix).toContain("home.arpa");
  });
});
