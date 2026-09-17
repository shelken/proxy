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

// --- 合成器 ---
//
// 只断言外部可观察的行为：给定这组输入产出的配置长什么样、缺参数时是否当场失败。
// 结构校验（sing-box check）在沙箱里跑，那里才有内核可执行文件。

const REMOTE_BASE = "https://raw.githubusercontent.com/shelken/proxy/sing-box-rules";

const COMPOSE_BASE = {
  target: "darwin",
  nodes: [
    "vless://11111111-2222-3333-4444-555555555555@example.com:443?security=tls&sni=a.test&type=ws&host=a.test&path=%2Fx#node-1",
    "trojan://pass@example.net:443?security=tls&sni=b.test&type=grpc&serviceName=gs#node-2",
  ],
  dns: "100.100.100.100",
  zone: "corp.internal",
};

/** 跑一次 compose，返回 { stdout, stderr, exitCode }。 */
function compose(input, env = {}) {
  const proc = Bun.spawnSync(
    ["uv", "run", "python", "-B", SCRIPT, "compose", "--input", "-"],
    {
      stdin: Buffer.from(typeof input === "string" ? input : JSON.stringify(input)),
      env: { ...process.env, ...env },
    },
  );
  return {
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    exitCode: proc.exitCode,
  };
}

/** 合成一份配置，顺带断言它没在 stderr 上抱怨。 */
function composed(extra = {}) {
  const { stdout, stderr, exitCode } = compose({ ...COMPOSE_BASE, ...extra });
  expect(stderr).toContain("target=darwin");
  expect(exitCode).toBe(0);
  return JSON.parse(stdout);
}

/** 公开层模板：合成结果的基准，断言时用来对照。 */
async function template() {
  return JSON.parse(
    await Bun.file("config/sing-box/conf.d/10-public.json").text(),
  );
}

describe("compose", () => {
  test("produces a config whose every referenced outbound exists", async () => {
    const config = composed();
    const base = await template();

    expect(config.inbounds.map((item) => item.tag)).toEqual(
      base.inbounds.map((item) => item.tag),
    );
    expect(config.route.final).toBe(base.route.final);
    expect(config.dns.final).toBe(base.dns.final);

    const tags = new Set(config.outbounds.map((item) => item.tag));
    for (const tag of ["node-1", "node-2", "direct", "proxy", "opencode"]) {
      expect(tags.has(tag)).toBe(true);
    }
    // 规则引用的出站必须真的存在：分组少生成一个，这里就红。
    for (const rule of config.route.rules) {
      if (rule.outbound) expect(tags.has(rule.outbound)).toBe(true);
    }
    const serverTags = new Set(config.dns.servers.map((item) => item.tag));
    for (const rule of config.dns.rules) {
      expect(serverTags.has(rule.server)).toBe(true);
    }
    expect(serverTags.has(config.dns.final)).toBe(true);
  });

  test("builds the internal resolver and zone rule set from the parameters", () => {
    const config = composed();
    const internal = config.dns.servers.find((item) => item.tag === "dns-internal");
    expect(internal.server).toBe(COMPOSE_BASE.dns);
    // 不写 detour：内核里空的 detour 就是本地直连，而点名一个没有任何拨号字段的
    // direct 出站会被它当成「绕经空直连出站」直接拒绝，配置起不来。
    expect(internal.detour).toBeUndefined();

    const zone = config.route.rule_set.find((item) => item.tag === "zone-internal");
    expect(zone.rules).toEqual([{ domain_suffix: [COMPOSE_BASE.zone] }]);

    // 换一组参数就该跟着变：写死的话这里会照旧。
    const other = composed({ dns: "192.168.9.9", zone: "lan" });
    expect(
      other.dns.servers.find((item) => item.tag === "dns-internal").server,
    ).toBe("192.168.9.9");
    expect(
      other.route.rule_set.find((item) => item.tag === "zone-internal").rules,
    ).toEqual([{ domain_suffix: ["lan"] }]);
  });

  test("references every rule set remotely on the published branch", async () => {
    const config = composed();
    const manifest = await Bun.file("config/rules/index.txt").text();
    const listed = manifest
      .split("\n")
      .filter((line) => line.trim() && !line.startsWith("#"));

    const remote = config.route.rule_set.filter((item) => item.type === "remote");
    expect(remote).toHaveLength(listed.length);
    for (const item of remote) {
      expect(item.url.startsWith(`${REMOTE_BASE}/singbox/`)).toBe(true);
      expect(item.url.endsWith(`${item.tag}.srs`)).toBe(true);
      // 下载周期显式写出来，不依赖「没说就是 1d」这条隐式默认。
      expect(item.update_interval).toBe("1d");
    }
    expect(config.route.rule_set.some((item) => item.type === "local")).toBe(false);
  });

  test("keeps the public layer's rules ahead of the registry's", async () => {
    const config = composed();
    const base = await template();

    // 内网直连规则若排在列表规则之后，就永远不会命中。
    expect(config.route.rules.slice(0, 2)).toEqual(base.route.rules);
    expect(config.route.rules[1]).toEqual({
      rule_set: ["zone-internal"],
      action: "route",
      outbound: "direct",
    });
    expect(config.dns.rules).toEqual(base.dns.rules);
    for (const rule of config.route.rules.slice(2)) {
      expect(Array.isArray(rule.rule_set)).toBe(true);
    }
  });

  test("declares an explicit http client for rule-set downloads", () => {
    // 不显式声明就落到 1.14 已弃用、1.16 将移除的隐式默认客户端上。
    const config = composed();
    expect(config.http_clients).toEqual([
      { tag: "rule-set-dl", detour: "proxy" },
    ]);
    expect(config.route.default_http_client).toBe("rule-set-dl");
    // 下载走的出站必须是配置里真实存在的那条。
    const tags = new Set(config.outbounds.map((item) => item.tag));
    expect(tags.has(config.http_clients[0].detour)).toBe(true);
  });

  test("takes nodes from a subscription as well as from single links", () => {
    const link = "trojan://pass@example.org:8443?security=tls&sni=c.test#from-sub";
    const config = composed({
      subscription: Buffer.from(link).toString("base64"),
      nodes: ["vless://11111111-2222-3333-4444-555555555555@example.com:443?security=tls&sni=a.test#single"],
    });
    const tags = config.outbounds.map((item) => item.tag);
    expect(tags).toContain("from-sub");
    expect(tags).toContain("single");
  });

  test("fails without producing a half config", async () => {
    const cases = [
      [{ ...COMPOSE_BASE, target: "linux-router" }, "不支持的 target：linux-router"],
      [{ ...COMPOSE_BASE, target: "" }, "缺少 target"],
      [{ ...COMPOSE_BASE, dns: "" }, "缺少 dns"],
      [{ ...COMPOSE_BASE, dns: "10.0.0.256" }, "dns 不是合法的 IP 地址"],
      [{ ...COMPOSE_BASE, zone: "" }, "缺少 zone"],
      [{ ...COMPOSE_BASE, zone: "not a zone" }, "zone 不是合法的域名后缀"],
      [{ ...COMPOSE_BASE, nodes: [], subscription: "" }, "没有可用节点"],
      [{ ...COMPOSE_BASE, sub: "x" }, "不认识的键：sub"],
    ];
    for (const [input, hint] of cases) {
      const { stdout, stderr, exitCode } = compose(input);
      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain(hint);
    }
    expect(compose("{ not json").exitCode).toBe(1);
  });

  test("is a pure transform: no network, no repository writes", () => {
    const gitStatus = () =>
      Bun.spawnSync(["git", "status", "--porcelain"]).stdout.toString();
    const before = gitStatus();

    // 三个代理变量都指向死端口：真去抓订阅的话这里就失败了。
    const { exitCode } = compose(COMPOSE_BASE, {
      http_proxy: "http://127.0.0.1:1",
      https_proxy: "http://127.0.0.1:1",
      all_proxy: "socks5://127.0.0.1:1",
    });

    expect(exitCode).toBe(0);
    expect(gitStatus()).toBe(before);
  });
});
