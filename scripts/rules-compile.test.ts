#!/usr/bin/env bun
// 规则编译器的单元测试。
//
// 只驱动纯转换逻辑（不联网、不写仓库目录），因此不依赖任何上游列表的当前内容。
// 用法：bun test scripts/rules-compile.test.ts

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  dnsCompanionNames,
  emitClash,
  emitPlain,
  emitSingbox,
  emitSingboxDns,
  externalUrls,
  loadManifest,
  orphanCustomLists,
  outputName,
  parseYamlAst,
  validateTemplate,
  type ManifestItem,
  type RuleAST,
  type SingBoxRule,
} from "./rules-compile.ts";

/** 取出某个字段的全部值，跨 rule 合并。 */
function fieldValues(rules: SingBoxRule[], field: string): unknown[] {
  return rules.flatMap((rule) => (rule[field] as unknown[]) ?? []);
}

function singboxRules(ast: RuleAST): SingBoxRule[] {
  return JSON.parse(emitSingbox(ast)).rules;
}

/** 把清单内容写到临时文件，返回路径。测试只读不写仓库目录。 */
function writeManifest(content: string): string {
  const path = `/tmp/rules-manifest-${Math.random().toString(36).slice(2)}.yaml`;
  Bun.write(path, content);
  return path;
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
  - port_range:
      - 6881:6889
`;
    const ast = parseYamlAst(yaml);
    expect(ast.domain_suffix).toEqual(["example.com"]);
    expect(ast.domain_keyword).toEqual(["ads"]);
    expect(ast.port).toEqual([8080]);
    expect(ast.port_range).toEqual(["6881:6889"]);
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
});

describe("emitSingbox", () => {
  test("字段映射：域名/IP/端口/进程各自成规则，值合并去重", () => {
    const rules = singboxRules({
      domain: ["a.test"],
      domain_suffix: ["b.test", "c.test"],
      domain_keyword: ["keyword"],
      domain_regex: ["^regex\\..+"],
      ip_cidr: ["10.0.0.0/8,no-resolve", "2001:db8::/32"],
      source_ip_cidr: ["10.1.0.0/16"],
      port: [443],
      source_port: [1234],
      process_name: ["curl"],
    });

    expect(fieldValues(rules, "domain")).toEqual(["a.test"]);
    expect(fieldValues(rules, "domain_suffix")).toEqual(["b.test", "c.test"]);
    expect(fieldValues(rules, "domain_keyword")).toEqual(["keyword"]);
    expect(fieldValues(rules, "domain_regex")).toEqual(["^regex\\..+"]);
    // no-resolve 是 mihomo/Loon 专用选项，sing-box 规则集剥离
    expect(fieldValues(rules, "ip_cidr")).toEqual(["10.0.0.0/8", "2001:db8::/32"]);
    expect(fieldValues(rules, "source_ip_cidr")).toEqual(["10.1.0.0/16"]);
    expect(fieldValues(rules, "port")).toEqual([443]);
    expect(fieldValues(rules, "source_port")).toEqual([1234]);
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
});

describe("emitClash（mihomo classical）", () => {
  test("字段展开为 classical 行，端口范围转连字符，no-resolve 保留", () => {
    const text = emitClash({
      domain: ["a.test"],
      ip_cidr: ["1.1.1.1/32,no-resolve"],
      ip_asn: ["396982,no-resolve"],
      port: [22],
      port_range: ["6881:6889"],
      source_port_range: ["1000:2000"],
    });
    expect(text).toContain("- 'DOMAIN,a.test'");
    expect(text).toContain("- 'IP-CIDR,1.1.1.1/32,no-resolve'");
    expect(text).toContain("- 'IP-ASN,396982,no-resolve'");
    expect(text).toContain("- 'DST-PORT,22'");
    expect(text).toContain("- 'DST-PORT,6881-6889'");
    expect(text).toContain("- 'SRC-PORT,1000-2000'");
  });

  test("空 AST 产出空 payload", () => {
    expect(emitClash({})).toBe("payload: []\n");
  });
});

describe("emitPlain（Loon / Surge）", () => {
  test("DEST-PORT 拼写、连字符范围、IPv6 用 IP-CIDR6", () => {
    const text = emitPlain({
      port: [22],
      port_range: ["6881:6889"],
      ip_cidr: ["240e::/18,no-resolve", "1.1.1.1/32,no-resolve"],
    });
    expect(text).toContain("DEST-PORT,22");
    expect(text).toContain("DEST-PORT,6881-6889");
    expect(text).toContain("IP-CIDR6,240e::/18,no-resolve");
    expect(text).toContain("IP-CIDR,1.1.1.1/32,no-resolve");
  });
});


describe("清单解析", () => {
  test("输出名净化，去掉路径分隔符等非法字符", () => {
    expect(outputName("My/Weird Tag")).toBe("My_Weird_Tag");
    expect(outputName("***")).toBe("rule");
  });

  test("解析 tag: source 映射，注释与空行被忽略", () => {
    const path = writeManifest(
      [
        "# 注释",
        "OpenAI: config/rules/custom/OpenAI.list",
        "",
        "Twitter: https://example.com/Twitter.list",
      ].join("\n"),
    );
    expect(loadManifest(path)).toEqual([
      { tag: "OpenAI", source: "config/rules/custom/OpenAI.list" },
      { tag: "Twitter", source: "https://example.com/Twitter.list" },
    ]);
  });

  test("数字键带引号时仍是字符串 tag", () => {
    const path = writeManifest('"867": config/rules/custom/x.list');
    expect(loadManifest(path)).toEqual([{ tag: "867", source: "config/rules/custom/x.list" }]);
  });

  test("source 非字符串或为空时直接报错", () => {
    expect(() => loadManifest(writeManifest("OpenAI:\n"))).toThrow(/必须是非空字符串/);
    expect(() => loadManifest(writeManifest("OpenAI: ''\n"))).toThrow(/必须是非空字符串/);
  });

  test("顶层不是映射时报错", () => {
    expect(() => loadManifest(writeManifest("- a\n- b\n"))).toThrow(/必须是 tag: source 映射/);
  });

  test("只在 custom/ 放文件、不写进清单时能被识别为孤儿", () => {
    // 真实踩过的坑：把新列表丢进 custom/ 就以为 CI 会发现它。
    // 清单是唯一入口，孤儿文件不产出任何规则，所以必须显式提醒。
    const orphans = orphanCustomLists([
      { tag: "Known", source: "config/rules/custom/MyReject.yaml" },
    ]);
    expect(orphans).toContain("config/rules/custom/OpenAI.yaml");
    expect(orphans).not.toContain("config/rules/custom/MyReject.yaml");
  });
});

describe("底模契约校验", () => {
  const items: ManifestItem[] = [
    { tag: "MyReject", source: "config/rules/custom/MyReject.yaml" },
    { tag: "OpenAI", source: "config/rules/custom/OpenAI.yaml" },
  ];
  const template = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    route: {
      rule_set: [{ tag: "MyReject" }, { tag: "OpenAI" }],
      rules: [
        { rule_set: ["MyReject"], action: "reject" },
        { rule_set: ["OpenAI"], action: "route", outbound: "openai" },
      ],
    },
    dns: { rules: [] },
    ...over,
  });

  test("清单与底模一致时不报错", () => {
    expect(validateTemplate(template(), items)).toEqual([]);
  });

  test("清单里的 tag 未出现在 route.rules 时报错", () => {
    // 模板声明了 rule_set 却没写路由规则：规则集不会生效，属于配置漏写。
    const drift = validateTemplate(
      template({
        route: {
          rule_set: [{ tag: "MyReject" }, { tag: "OpenAI" }],
          rules: [{ rule_set: ["MyReject"], action: "reject" }],
        },
      }),
      items,
    );
    expect(drift.some((e) => e.includes("OpenAI") && e.includes("未出现在底模 route.rules"))).toBe(
      true,
    );
  });

  test("底模漏声明清单里的 tag 时报错", () => {
    const drift = validateTemplate(
      { route: { rule_set: [{ tag: "MyReject" }], rules: [{ rule_set: ["MyReject"], action: "reject" }] }, dns: {} },
      items,
    );
    expect(drift.some((e) => e.includes("OpenAI") && e.includes("未在底模"))).toBe(true);
  });

  test("底模声明了清单外的 tag 时报错", () => {
    const drift = validateTemplate(
      template({ route: { rule_set: [{ tag: "MyReject" }, { tag: "OpenAI" }, { tag: "Ghost" }], rules: [] } }),
      items,
    );
    expect(drift.some((e) => e.includes("Ghost") && e.includes("既不在清单里"))).toBe(true);
  });

  test("DNS 伴生被路由引用时报错", () => {
    const t = {
      route: {
        rule_set: [{ tag: "MyReject" }, { tag: "OpenAI" }, { tag: "OpenAI-dns" }],
        rules: [
          { rule_set: ["MyReject"], action: "reject" },
          { rule_set: ["OpenAI"], action: "route", outbound: "openai" },
          { rule_set: ["OpenAI-dns"], action: "route", outbound: "proxy" },
        ],
      },
      dns: { rules: [{ rule_set: ["OpenAI-dns"], server: "dns-direct-cn" }] },
    };
    const drift = validateTemplate(t, items);
    expect(drift.some((e) => e.includes("OpenAI-dns") && e.includes("不应参与路由"))).toBe(true);
  });

  test("DNS 规则引用了清单外的规则集时报错", () => {
    const t = template({ dns: { rules: [{ rule_set: ["DoesNotExist"], server: "dns-direct-cn" }] } });
    expect(() => dnsCompanionNames(t, items)).toThrow(/既不在清单里/);
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
