#!/usr/bin/env bun
// 规则生成器的单元测试。
//
// 通过 scripts/singbox_rules.py 的 convert 子命令驱动纯转换逻辑：只做归一化与
// 转换，不联网、不写仓库目录。因此这些用例不依赖任何外部列表的当前内容。
//
// 用法：bun test scripts/singbox_rules.test.js

import { describe, expect, test } from "bun:test";

const SCRIPT = "scripts/singbox_rules.py";

/** 跑一次 convert，返回 { stdout, stderr, exitCode }。 */
function convert(input, client) {
  const proc = Bun.spawnSync(
    ["uv", "run", "python", "-B", SCRIPT, "convert", "--input", "-", "--client", client],
    { stdin: Buffer.from(input) },
  );
  return {
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    exitCode: proc.exitCode,
  };
}

/** 解析 singbox 客户端的 JSON 产物，把每个 rule 摊平成 "字段=值" 的集合。 */
function singboxRules(input) {
  const { stdout } = convert(input, "singbox");
  return JSON.parse(stdout).rules;
}

/** 取出某个字段的所有值，跨 rule 合并。 */
function fieldValues(rules, field) {
  return rules.flatMap((rule) => rule[field] ?? []);
}

describe("convert --client singbox", () => {
  test("maps every supported rule type to its sing-box field", () => {
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
    expect(fieldValues(rules, "ip_cidr").sort()).toEqual([
      "10.0.0.0/8",
      "2001:db8::/32",
    ]);
    expect(fieldValues(rules, "source_ip_cidr")).toEqual(["10.1.0.0/16"]);
    expect(fieldValues(rules, "source_port")).toEqual([1234]);
    expect(fieldValues(rules, "port")).toEqual([443]);
    expect(fieldValues(rules, "process_name")).toEqual(["curl"]);
  });

  test("drops comments, blank lines and the no-resolve suffix", () => {
    const rules = singboxRules(
      ["# 注释", "", "IP-CIDR,1.1.1.1/32,no-resolve", "  ", "DOMAIN,a.test"].join("\n"),
    );
    expect(rules).toEqual([{ domain: ["a.test"] }, { ip_cidr: ["1.1.1.1/32"] }]);
  });

  test("merges repeated values of one field into a single rule", () => {
    const rules = singboxRules(
      ["DOMAIN-SUFFIX,a.test", "DOMAIN-SUFFIX,b.test", "DOMAIN-SUFFIX,c.test"].join("\n"),
    );
    const suffixRules = rules.filter((rule) => rule.domain_suffix);
    expect(suffixRules).toHaveLength(1);
    expect(suffixRules[0].domain_suffix).toEqual(["a.test", "b.test", "c.test"]);
  });

  test("skips rule types sing-box cannot express", () => {
    const rules = singboxRules(
      [
        "DOMAIN,a.test",
        "IP-ASN,396982,no-resolve",
        "USER-AGENT,SomeApp*",
        "URL-REGEX,^https?://ads",
      ].join("\n"),
    );
    expect(fieldValues(rules, "domain")).toEqual(["a.test"]);
    // 跳过项不得以任何形式出现在产物里。
    expect(JSON.stringify(rules)).not.toContain("396982");
    expect(JSON.stringify(rules)).not.toContain("SomeApp");
  });

  test("turns a bare GEOIP list into an external rule-set reference", () => {
    // cn.list 全文只有 GEOIP,cn。geoip 行内匹配已在 1.12.0 移除，
    // 但整个列表只有这一条时可以退化为对 sing-geoip 预编译规则集的引用。
    const rules = JSON.parse(convert("GEOIP,cn,DIRECT", "singbox").stdout);
    expect(rules.kind).toBe("external_rule_set");
    expect(rules.references[0].tag).toBe("geoip-cn");
  });

  test("emits an empty rule list for empty input", () => {
    expect(JSON.parse(convert("", "singbox").stdout)).toEqual({
      version: 3,
      rules: [],
    });
  });
});

describe("convert --client clash", () => {
  test("keeps rule types mihomo can express", () => {
    const { stdout } = convert(
      ["DOMAIN,a.test", "IP-ASN,396982,no-resolve", "GEOIP,CN,DIRECT"].join("\n"),
      "clash",
    );
    expect(stdout).toContain("- 'DOMAIN,a.test'");
    expect(stdout).toContain("- 'IP-ASN,396982,no-resolve'");
    expect(stdout).toContain("- 'GEOIP,CN,DIRECT'");
  });

  test("renames Loon's DEST-PORT to mihomo's DST-PORT", () => {
    const { stdout } = convert("DEST-PORT,22", "clash");
    expect(stdout).toContain("- 'DST-PORT,22'");
  });

  test("expands shorthand lines into explicit rules", () => {
    // .domain 是 DOMAIN-SUFFIX 的省略写法，裸域名是 DOMAIN 的省略写法。
    // provider 的 payload 没有省略语法，必须还原。
    const { stdout } = convert([".example.com", "example.com"].join("\n"), "clash");
    expect(stdout).toContain("- 'DOMAIN-SUFFIX,example.com'");
    expect(stdout).toContain("- 'DOMAIN,example.com'");
  });

  test("skips USER-AGENT and URL-REGEX", () => {
    const { stdout } = convert(
      ["DOMAIN,a.test", "USER-AGENT,SomeApp*", "URL-REGEX,^https?://ads"].join("\n"),
      "clash",
    );
    expect(stdout).not.toContain("USER-AGENT");
    expect(stdout).not.toContain("URL-REGEX");
  });

  test("emits an empty payload for empty input", () => {
    expect(convert("", "clash").stdout).toBe("payload: []\n");
  });
});

describe("convert --client plain", () => {
  test("passes every line through unchanged, including unsupported ones", () => {
    // plain 供 Loon 与 Surge 直接按 URL 引用，行格式与源格式一致。
    const input = [
      "DOMAIN,a.test",
      "IP-ASN,396982,no-resolve",
      "USER-AGENT,SomeApp*",
      "DEST-PORT,22",
    ].join("\n");
    expect(convert(input, "plain").stdout).toBe(input + "\n");
  });
});

describe("unsupported report", () => {
  test("writes skipped lines to the report file", async () => {
    const report = "/tmp/singbox-rules-skipped.txt";
    const proc = Bun.spawnSync(
      [
        "uv", "run", "python", "-B", SCRIPT, "convert",
        "--input", "-", "--client", "singbox",
        "--report", report,
      ],
      { stdin: Buffer.from(["DOMAIN,a.test", "IP-ASN,396982,no-resolve"].join("\n")) },
    );
    expect(proc.exitCode).toBe(0);
    expect(await Bun.file(report).text()).toBe("IP-ASN,396982,no-resolve\n");
  });
});
