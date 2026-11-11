import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SING_BOX } from "./lib/sandbox.ts";
import {
  asArray,
  assertAllRuleSetsDeclared,
  assertMyDirectAndProxyBeforeServices,
  assertMyProxyDnsBeforeChinaMax,
  assertMyProxyQuicBeforeExempt,
  assertRejectBeforeClashMode,
} from "./lib/contracts.ts";

const TEMPLATE_PATH = resolve(import.meta.dir, "../template.json");
const template = JSON.parse(await Bun.file(TEMPLATE_PATH).text());
const CONFIG_DIR = resolve(import.meta.dir, "..");
/** 本仓库发布规则产物的前缀（与 scripts/build-config.ts 的 RULES_URL 一致）。 */
const PUBLISH_PREFIX = "https://raw.githubusercontent.com/shelken/proxy/sing-box-rules/singbox";
const settings = Bun.YAML.parse(readFileSync(join(CONFIG_DIR, "settings.yaml"), "utf8")) as {
  groups: Record<string, { options: string[]; default?: string }>;
  rules: Array<{ name: string; source: string; to: string }>;
};

// 内核 merge 的输出会省略默认值 `action: "route"`、
// 把 default_domain_resolver 收成字符串，断言要对两种形态都成立。
const actionOf = (rule: { action?: string }): string => rule.action ?? "route";
const resolverServer = (v: unknown): string | undefined =>
  typeof v === "string" ? v : (v as { server?: string } | undefined)?.server;

describe("template.json structural verification", () => {
  test("passes sing-box check", () => {
    const proc = Bun.spawnSync([SING_BOX, "check", "-c", TEMPLATE_PATH]);
    expect(proc.exitCode).toBe(0);
  });

  test("contains dual inbounds (tun-in and mixed-in 2080)", () => {
    const inbounds = template.inbounds ?? [];
    const tun = inbounds.find((i) => i.type === "tun");
    const mixed = inbounds.find((i) => i.type === "mixed");

    expect(tun).toBeDefined();
    expect(tun.tag).toBe("tun-in");
    expect(tun.auto_route).toBe(true);
    expect(tun.dns_mode).toBe("hijack");

    expect(mixed).toBeDefined();
    expect(mixed.tag).toBe("mixed-in");
    expect(mixed.listen_port).toBe(2080);
  });

  test("excludes private physical LAN from tun to avoid route hijacking on macOS", () => {
    const tun = template.inbounds.find((i) => i.type === "tun");
    const excluded = tun.route_exclude_address ?? [];
    expect(excluded).toContain("10.0.0.0/8");
    expect(excluded).toContain("172.16.0.0/12");
    expect(excluded).toContain("192.168.0.0/16");
    expect(excluded).not.toContain("100.64.0.0/10");
  });

  test("routes private IP addresses to direct outbound", () => {
    const rules = template.route?.rules ?? [];
    const privateRule = rules.find(
      (r) => r.ip_is_private === true && actionOf(r) === "route" && r.outbound === "direct",
    );
    expect(privateRule).toBeDefined();
  });


  test("QUIC 守卫排在拦截之后，国内直连的 HTTP/3 才放行", () => {
    const rules = template.route?.rules ?? [];
    const quicRules = rules.filter(
      (r) => r.network === "udp" && asArray(r.port).includes(443),
    );
    // 两条成套：先给国内直连放行，再兜底 reject。单留 reject 会让国内 CDN 的
    // HTTP/3 无差别降级；只放行不 reject 则代理侧 QUIC 打进承载差的机场 UDP。
    const exempt = quicRules.find((r) => r.outbound === "direct");
    const reject = quicRules.find(
      (r) => r.action === "reject" && r.rule_set === undefined,
    );
    expect(exempt).toBeDefined();
    expect(reject).toBeDefined();
    expect(rules.indexOf(exempt)).toBeLessThan(rules.indexOf(reject));

    assertMyProxyQuicBeforeExempt(rules);

    // 豁免必须排在广告/黑名单拦截之后：国内 CDN 承载大量统计域名（hm.baidu.com
    // 同属 ChinaMax 与 Advertising，loggw-ex.alipay.com 同属 ChinaMax 与 MyReject），
    // 豁免若抢先，这些域名走 HTTP/3 时会被放行为 direct，与拦截被截胡是同一类病。
    const adReject = rules.find(
      (r) => r.action === "reject" && asArray(r.rule_set).includes("Advertising"),
    );
    expect(adReject).toBeDefined();
    expect(rules.indexOf(adReject)).toBeLessThan(rules.indexOf(exempt));

    // no_drop：默认 method 在 30s 内触发超过 50 次会退化为静默丢包（不回 ICMP），
    // 客户端只能等 QUIC 超时，正是"国内网站首屏卡顿"的来源。置 true 恒回 ICMP。
    expect(reject?.no_drop).toBe(true);
  });


  test("MyProxy-dns 先于 ChinaMax-dns，重叠域名不被国内解析抢先（ADR-0011）", () => {
    assertMyProxyDnsBeforeChinaMax(template.dns?.rules ?? []);
  });

  test("configures prefer_ipv4 DNS strategy", () => {
    expect(template.dns?.strategy).toBe("prefer_ipv4");
  });

  test("DNS uses FakeIP for A/AAAA with real-server final", () => {
    const servers = template.dns?.servers ?? [];
    const fakeip = servers.find((s) => s.type === "fakeip");
    expect(fakeip).toBeDefined();
    expect(fakeip.inet4_range).toBe("198.18.0.0/15");
    // final 不能是 fakeip（内核限制），且必须是真实服务器
    expect(template.dns?.final).not.toBe(fakeip?.tag);
    // A/AAAA 查询导流到 fakeip
    const fakeipRule = (template.dns?.rules ?? []).find(
      (r) => r.server === fakeip?.tag && r.query_type,
    );
    expect(fakeipRule?.query_type).toContain("A");
    expect(fakeipRule?.query_type).toContain("AAAA");
    // TUN 网段必须同时避开排除段（尸检 001: DNS 黑洞）与 FakeIP 池
    const tun = template.inbounds.find((i) => i.type === "tun");
    expect(tun.address[0]).not.toBe("198.18.0.1/30");
  });

  test("routes Lan and PTR queries to local system DNS", () => {
    const rules = template.dns?.rules ?? [];
    const lanRule = rules.find((r) => r.rule_set?.includes("Lan-dns"));
    // shared.yaml 固定引用 Lan-dns，settings 里没有 Lan 时构建本身就会失败
    expect(lanRule?.server).toBe("dns-lan");

    const ptrRule = rules.find((r) => r.query_type?.includes("PTR"));
    expect(ptrRule).toBeDefined();
    expect(ptrRule.server).toBe("dns-lan");
  });

  test("个人域规则集走系统 DNS 且排在 FakeIP 之前", () => {
    const rules = template.dns?.rules ?? [];
    const zoneRule = rules.find((r) => r.rule_set?.includes("MyDirect-dns"));
    expect(zoneRule).toBeDefined();
    const zoneIndex = rules.indexOf(zoneRule);
    // 必须是 dns-lan：局域网内由路由器应答真实内网 IP，
    // 拿到真实 IP 后出站直连无需再解析，绕开 fakeip → 拨号解析 NXDOMAIN
    expect(zoneRule.server).toBe("dns-lan");
    expect(zoneRule.disable_optimistic_cache).toBe(true);

    // 个人域规则必须排在 clash_mode: direct 之前，确保在 direct 模式下也能禁用乐观缓存
    const directIndex = rules.findIndex((r) => r.clash_mode === "direct");
    expect(directIndex).toBeGreaterThan(-1);
    expect(zoneIndex).toBeLessThan(directIndex);

    // first match wins：命中 fakeip 之前必须已被本条拦下，否则仍会拿到假 IP
    const fakeipIndex = rules.findIndex((r) => r.server === "dns-fakeip");
    expect(fakeipIndex).toBeGreaterThan(-1);
    expect(zoneIndex).toBeLessThan(fakeipIndex);
  });

  test("内部域静态应答排在 FakeIP 之前，且零出站", () => {
    const rules = template.dns?.rules ?? [];
    // 通配只给 A 记录应答；AAAA/HTTPS 等其余类型答成空结果，不落 FakeIP
    const wildcard = rules.find(
      (r) => r.domain_suffix?.includes(".int.ooooo.space"),
    );
    expect(wildcard).toBeDefined();
    expect(asArray(wildcard.query_type)).toContain("A");
    expect(wildcard.action).toBe("predefined");
    expect(asArray(wildcard.answer).join(" ")).toContain("192.168.69.46");

    // 不带点：同时兜住根名与子域的非 A 查询
    const emptyRule = rules.find(
      (r) =>
        r.domain_suffix?.includes("int.ooooo.space") && !r.query_type,
    );
    expect(emptyRule).toBeDefined();
    expect(emptyRule.action).toBe("predefined");
    expect(emptyRule).not.toBe(wildcard);

    // first match wins：两条都必须排在 FakeIP 之前，否则内部名拿到假 IP
    const fakeipIndex = rules.findIndex((r) => r.server === "dns-fakeip");
    expect(fakeipIndex).toBeGreaterThan(-1);
    for (const r of [wildcard, emptyRule]) {
      expect(rules.indexOf(r)).toBeLessThan(fakeipIndex);
    }
  });

  test("出站拨号解析跟随系统 DNS，而非固定公网解析器", () => {
    // 拨号解析（direct 出站的 lookup）不走 dns.rules，只认 default_domain_resolver。
    // 实测：dns.rules 里给 test.internal 配了 dns-lan 也拦不住拨号，
    // 内核直接 lookup → NXDOMAIN。必须在这里指到 dns-lan（type:local，
    // 跟随 DHCP）：局域网内打路由器拿内网 IP，在外面打运营商 DNS。
    expect(resolverServer(template.route?.default_domain_resolver)).toBe("dns-lan");
    // 指向的 server 必须在 dns.servers 里真实存在，否则内核启动 FATAL
    const tags = (template.dns?.servers ?? []).map((s) => s.tag);
    expect(tags).toContain(resolverServer(template.route.default_domain_resolver));
  });

  test("TUN 网段与排除段、FakeIP 池三方互斥", () => {
    const tunAddr = template.inbounds.find((i) => i.type === "tun").address[0];
    const [tunIp, tunBits] = tunAddr.split("/");
    const toInt = (ip) =>
      ip.split(".").reduce((acc, o) => acc * 256 + Number(o), 0);
    const tunStart = toInt(tunIp);
    const tunEnd = tunStart + (2 ** (32 - Number(tunBits || 32)) - 1);
    const rangeOf = (cidr) => {
      const [ip, bits] = cidr.split("/");
      const start = toInt(ip);
      return [start, start + (2 ** (32 - Number(bits)) - 1)];
    };
    // 与排除段互斥（尸检 001: TUN 落入排除段 → 劫持 DNS 包绕过 TUN → 系统解析器黑洞）
    for (const cidr of template.inbounds.find((i) => i.type === "tun")
      .route_exclude_address) {
      if (cidr.includes(":")) continue;
      const [s, e] = rangeOf(cidr);
      expect(tunEnd < s || tunStart > e).toBe(true);
    }
    // 与 FakeIP 池互斥（fakeip 从池首地址顺序分配，会争用 TUN 自身地址）
    const fakeip = (template.dns?.servers ?? []).find(
      (s) => s.type === "fakeip",
    );
    const [ps, pe] = rangeOf(fakeip.inet4_range);
    expect(tunEnd < ps || tunStart > pe).toBe(true);
  });



  test("每个路由目标的出站都在 outbounds / endpoints 里声明", () => {
    // 契约：route.rules 里 route 到的出站必须是已声明的出站（selector/urltest/endpoint）。
    // 不手抄组名清单：加一个出站就要改测试，且漏改时子集断言照旧通过（anthropic 踩过）。
    const declared = new Set<string>([
      ...(template.outbounds ?? []).map((o: { tag: string }) => o.tag),
      ...(template.endpoints ?? []).map((e: { tag: string }) => e.tag),
    ]);
    const targets = new Set(
      (template.route?.rules ?? [])
        .map((r: { outbound?: unknown }) => r.outbound)
        .filter((o): o is string => typeof o === "string"),
    );
    expect(targets.size).toBeGreaterThan(0);
    expect([...targets].filter((tag) => !declared.has(tag))).toEqual([]);
  });

  test("enables interrupt_exist_connections on all selector and urltest groups", () => {
    const groups = (template.outbounds ?? []).filter(
      (o: Record<string, unknown>) => o.type === "selector" || o.type === "urltest",
    );
    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) {
      expect(group.interrupt_exist_connections).toBe(true);
    }
  });

  test("tun 保持双栈，fakeip 只发 v4（无 inet6_range）", () => {
    const tun = template.inbounds.find((i) => i.type === "tun");
    expect(tun.address.some((addr: string) => addr.includes(":"))).toBe(true);
    expect(tun.route_exclude_address).toContain("fe80::/10");

    const fakeip = (template.dns?.servers ?? []).find((s) => s.type === "fakeip");
    expect(fakeip?.inet4_range).toBe("198.18.0.0/15");
    // 去掉 v6 池后 AAAA 拿不到假地址，应用只会用 v4 连接
    expect(fakeip?.inet6_range).toBeUndefined();
  });

  test("代理流量在路由阶段按 v4 解析后再交给节点", () => {
    const rules = template.route?.rules ?? [];
    const resolveRule = rules.find((r) => r.action === "resolve");
    expect(resolveRule).toBeDefined();
    // 必须显式指定 dns-proxy：否则内部查询被 dns.rules 的 fakeip 接住，返回假 IP
    expect(resolveRule.server).toBe("dns-proxy");
    expect(resolveRule.strategy).toBe("ipv4_only");
  });

  test("v4 解析规则排除了所有默认直连的规则集", () => {
    const rules = template.route?.rules ?? [];
    const resolveRule = rules.find((r) => r.action === "resolve");
    expect(resolveRule.invert).toBe(true);
    const excluded: Record<string, true> = {};
    for (const tag of asArray(resolveRule.rule_set)) excluded[tag] = true;

    // 「默认直连」= 规则的出站就是 direct，或出站是默认 direct 的策略组。漏掉一个，该组流量会
    // 先被 dns-proxy 解析成海外 IP 再直连（国内/就近站点拿到海外 CDN 地址）。清单从底模推导：
    // 新增直连规则集、或把某个组改成默认 direct，都会在这里被拦住。
    const directDefaults = new Set<string>(
      (template.outbounds ?? [])
        .filter((o: { default?: string }) => o.default === "direct")
        .map((o: { tag: string }) => o.tag),
    );
    const directRuleSets = rules
      .filter((r) => r.outbound === "direct" || directDefaults.has(r.outbound as string))
      .flatMap((r) => asArray(r.rule_set));
    expect(directRuleSets.length).toBeGreaterThan(0);
    expect(directRuleSets.filter((tag) => !excluded[tag])).toEqual([]);
  });

  test("所有 action: reject 规则必须排在首个 action: resolve 规则之前", () => {
    const rules = template.route?.rules ?? [];
    const firstResolveIndex = rules.findIndex(
      (r: { action?: string }) => r.action === "resolve",
    );
    expect(firstResolveIndex).toBeGreaterThan(-1);

    for (let i = 0; i < rules.length; i++) {
      if (rules[i].action === "reject") {
        expect(i).toBeLessThan(firstResolveIndex);
      }
    }
  });

  test("拦截规则先于 clash_mode（ADR-0008）", () => {
    // 含 QUIC 兜底：守卫必须在 clash_mode 之前，direct 模式下境外 QUIC 才仍被拒（ADR-0008 决策 6）。
    assertRejectBeforeClashMode(template.route?.rules ?? []);
  });

  test("MyDirect/MyProxy 排在所有服务规则之前（ADR-0007）", () => {
    assertMyDirectAndProxyBeforeServices(template.route?.rules ?? [], template.outbounds ?? []);
  });

  test("DNS 层拦截引用的都是 settings 里的规则，且排在 FakeIP 之前", () => {
    const dnsRules = template.dns?.rules ?? [];
    const rejects = dnsRules.filter((r: { action?: string }) => r.action === "reject");
    // 拦截的 -dns 伴生必须对应 settings 里的规则；DNS 拦截由 shared.yaml 固定，不随 to 变化
    for (const rule of rejects) {
      for (const tag of asArray((rule as { rule_set?: string | string[] }).rule_set)) {
        const source = settings.rules.find((r) => r.name === tag.replace(/-dns$/, ""));
        expect(source).toBeDefined();
      }
    }
    const fakeipIndex = dnsRules.findIndex((r: { server?: string }) => r.server === "dns-fakeip");
    expect(fakeipIndex).toBeGreaterThan(-1);
    for (const rule of rejects) expect(dnsRules.indexOf(rule)).toBeLessThan(fakeipIndex);
    // 历史行为守卫：MyReject 是本地拒绝清单（有伴生），DNS 层必须拦住它
    expect(rejects.some((r: { rule_set?: string | string[] }) => asArray(r.rule_set).includes("MyReject-dns"))).toBe(true);
  });

  test("BT 仅按协议嗅探分流，默认直连而非固定出站", () => {
    const sniffer = template.route?.rules?.[0]?.sniffer ?? [];
    expect(sniffer).toContain("bittorrent");

    const rules = template.route?.rules ?? [];
    const btRule = rules.find((r) => r.protocol === "bittorrent");
    expect(btRule?.outbound).toBe("torrent");

    // torrent rule_set 已退役（process_name/端口是死代码或误伤，见 PR 评估）：
    // BT 分流只认 protocol: bittorrent，tracker 域名落 final proxy。
    expect((template.route?.rule_set ?? []).map((rs) => rs.tag)).not.toContain("torrent");
    expect(rules.some((r) => asArray(r.rule_set).includes("torrent"))).toBe(false);
    expect((template.route?.rules ?? []).some((r) => asArray(r.rule_set).includes("torrent"))).toBe(false);

    // 组必须存在且默认可直连：候选含 direct，默认值就是 direct。
    // 改成 direct 之外的默认值会让 BT 大流量打进代理节点，这条断言守住它。
    const group = (template.outbounds ?? []).find((o) => o.tag === "torrent");
    expect(group).toBeDefined();
    expect(group?.type).toBe("selector");
    expect(asArray(group?.outbounds)).toContain("direct");
    expect(asArray(group?.outbounds)).toContain("proxy");
    expect(group?.default).toBe("direct");

    // 无 torrent 清单 → 无 torrent-dns 伴生，DNS 侧不得再引用它。
    const dnsRuleSets = (template.dns?.rules ?? []).flatMap((r) => asArray(r.rule_set));
    expect(dnsRuleSets).not.toContain("torrent-dns");
    expect((template.route?.rule_set ?? []).map((rs) => rs.tag)).not.toContain("torrent-dns");
  });
});

// settings.yaml 是底模的唯一登记处：规则声明、匹配引用、分组与 DNS 伴生都从它生成。
// 这里守生成的产物与 settings/shared 一致，以及固定机制（拦截/解析/QUIC）没有被改坏。
describe("settings.yaml → template.json 生成契约", () => {
  test("log 级别为 info", () => {
    expect(template.log).toEqual({ level: "info" });
  });

  test("声明唯一，且每个设置规则都有声明；非规则声明都是 -dns 伴生", () => {
    const declared = template.route.rule_set.map((rs: { tag: string }) => rs.tag);
    expect(new Set(declared).size).toBe(declared.length);
    const names = new Set(settings.rules.map((r) => r.name));
    for (const rule of settings.rules) expect(declared).toContain(rule.name);
    for (const tag of declared) {
      if (names.has(tag)) continue;
      expect(tag.endsWith("-dns")).toBe(true);
      expect(names.has(tag.slice(0, -"-dns".length))).toBe(true);
    }
  });

  test("声明的 URL：外部 .srs 原样，其余指向发布前缀且文件名已归一化", () => {
    const external = new Map(
      settings.rules.filter((r) => /^https?:\/\//.test(r.source)).map((r) => [r.name, r.source]),
    );
    for (const rs of template.route.rule_set as Array<{ tag: string; url: string }>) {
      const url = new URL(rs.url);
      expect(["http:", "https:"]).toContain(url.protocol);
      expect(url.pathname.endsWith(".srs")).toBe(true);
      if (external.has(rs.tag)) {
        expect(rs.url).toBe(external.get(rs.tag));
        continue;
      }
      expect(rs.url.startsWith(`${PUBLISH_PREFIX}/`)).toBe(true);
      // 产物名必须已归一化（无空白/路径分隔），不能是原始 tag 直接拼文件名
      const file = decodeURIComponent(new URL(rs.url).pathname).split("/").pop() ?? "";
      expect(file).toMatch(/^[\p{L}\p{N}._-]+\.srs$/u);
    }
  });

  test("每个分组都生成出站，候选与默认值与 settings 一致", () => {
    for (const [name, def] of Object.entries(settings.groups)) {
      const group = template.outbounds.find((o: { tag: string }) => o.tag === name);
      expect(group?.outbounds).toEqual(def.options);
      expect(group?.default).toBe(def.default);
    }
  });

  test("route.rules 引用的 rule_set 全部已在 route.rule_set 里声明", () => {
    assertAllRuleSetsDeclared(template.route);
  });

  test("删掉一个规则声明 → assertAllRuleSetsDeclared 必须失败", () => {
    const route = JSON.parse(JSON.stringify(template.route));
    route.rule_set = route.rule_set.filter((rs: { tag: string }) => rs.tag !== "Advertising");
    expect(() => assertAllRuleSetsDeclared(route)).toThrow();
  });
});
