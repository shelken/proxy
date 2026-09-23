#!/usr/bin/env bun
// 规则编译器的单元测试。
//
// 只驱动纯转换逻辑（不联网、不写仓库目录），因此不依赖任何上游列表的当前内容。
// 用法：bun test scripts/rules-compile.test.ts

import { describe, expect, test } from "bun:test";
import {
  clashRuleLine,
  classifySimpleRule,
  convertRuleLines,
  dnsCompanionNames,
  emitClash,
  emitPlain,
  emitSingbox,
  emitSingboxDns,
  loadManifest,
  normalizeRuleLines,
  orphanCustomLists,
  outputName,
  splitTopLevel,
  stripOuterParens,
  toSourceJson,
  validateTemplate,
  type ManifestItem,
  type SingBoxRule,
} from "./rules-compile.ts";

/** 取出某个字段的全部值，跨 rule 合并。 */
function fieldValues(rules: SingBoxRule[], field: string): unknown[] {
  return rules.flatMap((rule) => (rule[field] as unknown[]) ?? []);
}

function singboxRules(input: string): SingBoxRule[] {
  return JSON.parse(emitSingbox(normalizeRuleLines(input)).text).rules;
}

describe("归一化", () => {
  test("丢掉注释、空行与 YAML payload 外壳", () => {
    const lines = normalizeRuleLines(
      ["payload:", "  - 'DOMAIN,a.test'", "  - 'DOMAIN,b.test'"].join("\n"),
    );
    expect(lines).toEqual(["DOMAIN,a.test", "DOMAIN,b.test"]);
  });

  test("普通列表只去注释与空白，不加解释", () => {
    expect(normalizeRuleLines(["# 注释", "", "DOMAIN,a.test", "  "].join("\n"))).toEqual([
      "DOMAIN,a.test",
    ]);
  });

  test("payload 段之后的顶格新键会终止解析", () => {
    const lines = normalizeRuleLines(
      ["payload:", "  - 'DOMAIN,a.test'", "other_key:", "  - 'DOMAIN,b.test'"].join("\n"),
    );
    expect(lines).toEqual(["DOMAIN,a.test"]);
  });
});

describe("单行判定", () => {
  test("省略写法还原：.domain 是 DOMAIN-SUFFIX，裸域名是 DOMAIN", () => {
    expect(classifySimpleRule(".example.com")).toEqual({
      kind: "rule",
      field: "domain_suffix",
      value: "example.com",
    });
    expect(classifySimpleRule("example.com")).toEqual({
      kind: "rule",
      field: "domain",
      value: "example.com",
    });
  });

  test("端口类转成数字，非数字算无法表达", () => {
    expect(classifySimpleRule("DST-PORT,443")).toEqual({
      kind: "rule",
      field: "port",
      value: 443,
    });
    expect(classifySimpleRule("DST-PORT,not-a-port").kind).toBe("unsupported");
  });

  test("GEOIP/GEOSITE 单独成类，不被当成无法表达", () => {
    expect(classifySimpleRule("GEOIP,CN,DIRECT")).toEqual({
      kind: "special",
      ref: { kind: "geoip", value: "cn" },
    });
  });

  test("大小写不敏感的类型名", () => {
    expect(classifySimpleRule("domain-suffix,a.test")).toEqual({
      kind: "rule",
      field: "domain_suffix",
      value: "a.test",
    });
  });
});

describe("convert --client singbox", () => {
  test("每种受支持类型都映射到对应字段", () => {
    const rules = singboxRules(
      [
        "DOMAIN,a.test",
        "DOMAIN-SUFFIX,b.test",
        "DOMAIN-KEYWORD,keyword",
        "DOMAIN-REGEX,^regex\\..+",
        "IP-CIDR,10.0.0.0/8,no-resolve",
        "IP-CIDR6,2001:db8::/32,no-resolve",
        "SRC-IP-CIDR,10.1.0.0/16",
        "SRC-PORT,1234",
        "DST-PORT,443",
        "PROCESS-NAME,curl",
      ].join("\n"),
    );

    expect(fieldValues(rules, "domain")).toEqual(["a.test"]);
    expect(fieldValues(rules, "domain_suffix")).toEqual(["b.test"]);
    expect(fieldValues(rules, "domain_keyword")).toEqual(["keyword"]);
    expect(fieldValues(rules, "domain_regex")).toEqual(["^regex\\..+"]);
    expect((fieldValues(rules, "ip_cidr") as string[]).sort()).toEqual([
      "10.0.0.0/8",
      "2001:db8::/32",
    ]);
    expect(fieldValues(rules, "source_ip_cidr")).toEqual(["10.1.0.0/16"]);
    expect(fieldValues(rules, "source_port")).toEqual([1234]);
    expect(fieldValues(rules, "port")).toEqual([443]);
    expect(fieldValues(rules, "process_name")).toEqual(["curl"]);
  });

  test("注释、空行与 no-resolve 后缀都不进产物", () => {
    const rules = singboxRules(
      ["# 注释", "", "IP-CIDR,1.1.1.1/32,no-resolve", "  ", "DOMAIN,a.test"].join("\n"),
    );
    expect(rules).toEqual([{ domain: ["a.test"] }, { ip_cidr: ["1.1.1.1/32"] }]);
  });

  test("同字段重复值合并进一条规则", () => {
    const rules = singboxRules(
      ["DOMAIN-SUFFIX,a.test", "DOMAIN-SUFFIX,b.test", "DOMAIN-SUFFIX,c.test"].join("\n"),
    );
    const suffixRules = rules.filter((rule) => rule.domain_suffix);
    expect(suffixRules).toHaveLength(1);
    expect(suffixRules[0].domain_suffix).toEqual(["a.test", "b.test", "c.test"]);
  });

  test("sing-box 无法表达的类型被跳过，且不留痕", () => {
    const emission = emitSingbox(
      normalizeRuleLines(
        ["DOMAIN,a.test", "IP-ASN,396982,no-resolve", "USER-AGENT,SomeApp*", "URL-REGEX,^https?://ads"].join(
          "\n",
        ),
      ),
    );
    const rules = JSON.parse(emission.text).rules as SingBoxRule[];
    expect(fieldValues(rules, "domain")).toEqual(["a.test"]);
    // 跳过项不得以任何形式出现在产物里。
    expect(emission.text).not.toContain("396982");
    expect(emission.text).not.toContain("SomeApp");
    expect(emission.skipped).toHaveLength(3);
  });

  test("纯 GEOIP 列表退化为对上游预编译规则集的引用", () => {
    // cn.list 全文只有 GEOIP,cn。行内 geoip 匹配已在 1.12.0 移除，
    // 但整份列表只有这一条时可以退化为对 sing-geoip 的引用。
    const payload = JSON.parse(emitSingbox(normalizeRuleLines("GEOIP,cn,DIRECT")).text);
    expect(payload.kind).toBe("external_rule_set");
    expect(payload.references[0].tag).toBe("geoip-cn");
    expect(payload.references[0].url).toContain("sing-geoip");
  });

  test("空输入产出空的规则列表", () => {
    expect(JSON.parse(emitSingbox([]).text)).toEqual({ version: 3, rules: [] });
  });

  test("逻辑规则（AND/OR/NOT）转成 logical 表达式", () => {
    const rules = singboxRules("AND,(DOMAIN,a.test),(DST-PORT,443)");
    expect(rules).toHaveLength(1);
    expect(rules[0].type).toBe("logical");
    expect(rules[0].mode).toBe("and");
    expect((rules[0].rules as SingBoxRule[]).length).toBe(2);
  });

  test("逻辑规则里有无法表达的子项时整条丢弃，不产出半截规则", () => {
    const emission = emitSingbox(normalizeRuleLines("AND,(DOMAIN,a.test),(IP-ASN,396982)"));
    const rules = JSON.parse(emission.text).rules as SingBoxRule[];
    expect(rules).toEqual([]);
    expect(emission.text).not.toContain("396982");
  });

  test("NOT 转成 invert", () => {
    const rules = singboxRules("NOT,(DOMAIN,a.test)");
    expect(rules[0]).toEqual({ domain: ["a.test"], invert: true });
  });

  test("DNS 伴生只保留按查询名匹配的字段", () => {
    // DNS 规则在拿到响应前只能按查询名判定，IP 类条目在 DNS 规则里没有可判定语义。
    const emission = emitSingboxDns(
      normalizeRuleLines(
        ["DOMAIN,a.test", "DOMAIN-SUFFIX,cn", "IP-CIDR,10.0.0.0/8,no-resolve", "GEOIP,cn,DIRECT"].join("\n"),
      ),
    );
    expect(JSON.parse(emission.text).rules).toEqual([
      { domain: ["a.test"] },
      { domain_suffix: ["cn"] },
    ]);
  });

  test("没有域名条目的列表生成 DNS 伴生时构建失败", () => {
    // 抄一份只有 IP 的规则进 DNS 规则，等于把废弃写法再写一遍，宁可构建失败。
    expect(() => emitSingboxDns(normalizeRuleLines("IP-CIDR,10.0.0.0/8"))).toThrow(
      /没有域名类条目/,
    );
  });
});

describe("convert --client clash", () => {
  test("mihomo 能表达的类型原样保留", () => {
    const { text } = emitClash(
      normalizeRuleLines(["DOMAIN,a.test", "IP-ASN,396982,no-resolve", "GEOIP,CN,DIRECT"].join("\n")),
    );
    expect(text).toContain("- 'DOMAIN,a.test'");
    expect(text).toContain("- 'IP-ASN,396982,no-resolve'");
    expect(text).toContain("- 'GEOIP,CN,DIRECT'");
  });

  test("Loon 的 DEST-PORT 改名成 mihomo 的 DST-PORT", () => {
    expect(clashRuleLine("DEST-PORT,22")).toBe("DST-PORT,22");
  });

  test("省略写法还原成显式规则", () => {
    expect(clashRuleLine(".example.com")).toBe("DOMAIN-SUFFIX,example.com");
    expect(clashRuleLine("example.com")).toBe("DOMAIN,example.com");
  });

  test("USER-AGENT 与 URL-REGEX 被跳过", () => {
    const { text, skipped } = emitClash(
      normalizeRuleLines(["DOMAIN,a.test", "USER-AGENT,SomeApp*", "URL-REGEX,^https?://ads"].join("\n")),
    );
    expect(text).not.toContain("USER-AGENT");
    expect(text).not.toContain("URL-REGEX");
    expect(skipped).toHaveLength(2);
  });

  test("空输入产出空 payload", () => {
    expect(emitClash([]).text).toBe("payload: []\n");
  });
});

describe("convert --client plain", () => {
  test("全部行原样输出，含无法表达的类型", () => {
    // plain 供 Loon / Surge 直接按 URL 引用，行格式与源格式一致。
    const input = ["DOMAIN,a.test", "IP-ASN,396982,no-resolve", "USER-AGENT,SomeApp*", "DEST-PORT,22"];
    expect(emitPlain(input).text).toBe(`${input.join("\n")}\n`);
  });
});

describe("括号与顶层切分", () => {
  test("只在真的包住整串时剥外层括号", () => {
    expect(stripOuterParens("(a),(b)")).toBe("(a),(b)");
    expect(stripOuterParens("(DOMAIN,a.test)")).toBe("DOMAIN,a.test");
  });

  test("顶层切分不切括号内的逗号", () => {
    expect(splitTopLevel("(DOMAIN,a.test),(DST-PORT,443)")).toEqual([
      "(DOMAIN,a.test)",
      "(DST-PORT,443)",
    ]);
    expect(splitTopLevel("a,b,c")).toEqual(["a", "b", "c"]);
  });
});

describe("产物字段顺序", () => {
  test("域名类字段排在 IP 类之前，逻辑规则恒排最后", () => {
    const { rules } = convertRuleLines(
      normalizeRuleLines(["IP-CIDR,10.0.0.0/8", "DOMAIN,a.test", "AND,(DOMAIN,x.test),(DST-PORT,1)"].join("\n")),
    );
    const ordered = toSourceJson(rules).rules;
    expect(Object.keys(ordered[0])).toEqual(["domain"]);
    expect(Object.keys(ordered[1])).toEqual(["ip_cidr"]);
    expect(ordered[2].type).toBe("logical");
  });
});

describe("清单解析", () => {
  test("输出名净化，去掉路径分隔符等非法字符", () => {
    expect(outputName("My/Weird Tag")).toBe("My_Weird_Tag");
    expect(outputName("***")).toBe("rule");
  });

  test("清单行缺列或有空字段都直接报错", () => {
    const write = (content: string): string => {
      const path = `/tmp/rules-manifest-${Math.random().toString(36).slice(2)}.txt`;
      Bun.write(path, content);
      return path;
    };
    expect(() => loadManifest(write("OnlyTwo|Fields\n"))).toThrow(/格式错误/);
    expect(() => loadManifest(write("tag||source\n"))).toThrow(/空字段/);
  });

  test("只在 custom/ 放文件、不写进清单时能被识别为孤儿", () => {
    // 真实踩过的坑：把新列表丢进 custom/ 就以为 CI 会发现它。
    // 清单是唯一入口，孤儿文件不产出任何规则，所以必须显式提醒。
    const orphans = orphanCustomLists([
      { tag: "Known", policy: "proxy", source: "config/rules/custom/MyReject.list" },
    ]);
    expect(orphans).toContain("config/rules/custom/OpenAI.list");
    expect(orphans).not.toContain("config/rules/custom/MyReject.list");
  });
});

describe("底模契约校验", () => {
  const items: ManifestItem[] = [
    { tag: "MyReject", policy: "reject", source: "config/rules/custom/MyReject.list" },
    { tag: "OpenAI", policy: "openai", source: "config/rules/custom/OpenAI.list" },
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

  test("policy 与底模路由不一致时报出该 tag", () => {
    // 真实踩过：template 把 Apple 从 direct 聚合拆出独立 apple 组，清单没同步改 policy。
    const drift = validateTemplate(
      template({
        route: {
          rule_set: [{ tag: "MyReject" }, { tag: "OpenAI" }],
          rules: [
            { rule_set: ["MyReject"], action: "reject" },
            { rule_set: ["OpenAI"], action: "route", outbound: "proxy" },
          ],
        },
      }),
      items,
    );
    expect(drift.some((e) => e.includes("OpenAI") && e.includes("openai") && e.includes("proxy"))).toBe(
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
