import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { SING_BOX } from "./lib/sandbox.ts";

const TEMPLATE_PATH = resolve(import.meta.dir, "../template.json");
const template = JSON.parse(await Bun.file(TEMPLATE_PATH).text());

// 内核 merge 的输出会把单元素数组写成标量、省略默认值 `action: "route"`、
// 把 default_domain_resolver 收成字符串，断言要对两种形态都成立。
const asArray = <T>(v: T | T[] | undefined): T[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];
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

    // MyProxy 是用户显式要求走代理的清单，与 ChinaMax 重叠的域名（如 minimax.io）
    // 不能被国内豁免直连：先 reject 降级 TCP，再由服务规则走代理（ADR-0011）。
    const myProxyReject = quicRules.find(
      (r) => r.action === "reject" && asArray(r.rule_set).includes("MyProxy"),
    );
    expect(myProxyReject?.no_drop).toBe(true);
    expect(rules.indexOf(myProxyReject)).toBeLessThan(rules.indexOf(exempt));

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
    const dnsRules = template.dns?.rules ?? [];
    const mine = dnsRules.findIndex((r) => asArray(r.rule_set).includes("MyProxy-dns"));
    const china = dnsRules.findIndex((r) => asArray(r.rule_set).includes("ChinaMax-dns"));
    expect(mine).toBeGreaterThanOrEqual(0);
    expect(mine).toBeLessThan(china);
    expect(dnsRules[mine].server).toBe("dns-fakeip");
    expect(asArray(dnsRules[mine].query_type)).toEqual(["A", "AAAA"]);
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

  test("routes Lan, local domain suffixes, and PTR queries to local system DNS", () => {
    const rules = template.dns?.rules ?? [];
    const lanRule = rules.find((r) => r.rule_set?.includes("Lan-dns"));
    expect(lanRule).toBeDefined();
    expect(lanRule.server).toBe("dns-local-system");

    const suffixRule = rules.find((r) => r.domain_suffix?.includes("local"));
    expect(suffixRule).toBeDefined();
    expect(suffixRule.domain_suffix).toContain("lan");
    expect(suffixRule.domain_suffix).toContain("home.arpa");
    expect(suffixRule.server).toBe("dns-local-system");

    const ptrRule = rules.find((r) => r.query_type?.includes("PTR"));
    expect(ptrRule).toBeDefined();
    expect(ptrRule.server).toBe("dns-local-system");
  });

  test("个人域规则集走系统 DNS 且排在 FakeIP 之前", () => {
    const rules = template.dns?.rules ?? [];
    const zoneRule = rules.find((r) => r.rule_set?.includes("MyDirect-dns"));
    expect(zoneRule).toBeDefined();
    const zoneIndex = rules.indexOf(zoneRule);
    // 必须是 dns-local-system：局域网内由路由器应答真实内网 IP，
    // 拿到真实 IP 后出站直连无需再解析，绕开 fakeip → 拨号解析 NXDOMAIN
    expect(zoneRule.server).toBe("dns-local-system");
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
    // 实测：dns.rules 里给 test.internal 配了 dns-local-system 也拦不住拨号，
    // 内核直接 lookup → NXDOMAIN。必须在这里指到 dns-local-system（type:local，
    // 跟随 DHCP）：局域网内打路由器拿内网 IP，在外面打运营商 DNS。
    expect(resolverServer(template.route?.default_domain_resolver)).toBe("dns-local-system");
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



  test("每个非 direct 的路由目标都有对应 selector 策略组", () => {
    // 契约：route.rules 里 route 到的出站，必须是在 outbounds 里声明的 selector。
    // 故意不手抄组名清单：加一个策略组就要改测试，且漏改时断言的子集照旧通过，
    // 新组实际没有任何覆盖（anthropic 加进来时就踩过）。
    const selectors = new Set(
      (template.outbounds ?? [])
        .filter((o) => o.type === "selector")
        .map((s) => s.tag),
    );
    const targets = new Set(
      (template.route?.rules ?? [])
        .map((r) => r.outbound)
        .filter((o) => typeof o === "string" && o !== "direct"),
    );
    expect(targets.size).toBeGreaterThan(0);
    const missing = [...targets].filter((tag) => !selectors.has(tag));
    expect(missing).toEqual([]);
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

  test("拦截规则先于 clash_mode 与分流服务", () => {
    // ADR-0008：clash_mode 只能决定"业务走哪条线路"，不能顺手放行广告与黑名单。
    // 排在 clash_mode 之前，global 模式下黑名单才仍然被拦截。
    const rules = template.route?.rules ?? [];
    const firstClashModeIndex = rules.findIndex((r) => r.clash_mode !== undefined);
    expect(firstClashModeIndex).toBeGreaterThan(-1);

    const rejectIndices = rules
      .map((r, i) => (r.action === "reject" ? i : -1))
      .filter((i) => i >= 0);
    expect(rejectIndices.length).toBeGreaterThan(0);
    // 含 QUIC 兜底：守卫必须在 clash_mode 之前，direct 模式下境外 QUIC 才仍被拒
    // （旧序 clash_mode: direct 在前会让该模式下 QUIC 全放行，见 ADR-0008 决策 6）。
    for (const i of rejectIndices) {
      expect(i).toBeLessThan(firstClashModeIndex);
    }
  });

  test("DNS 规则拦截 MyReject-dns 且排在 FakeIP 与 final 之前", () => {
    const dnsRules = template.dns?.rules ?? [];
    const rejectDnsRule = dnsRules.find((r: { rule_set?: string | string[] }) =>
      asArray(r.rule_set).includes("MyReject-dns"),
    );
    expect(rejectDnsRule).toBeDefined();
    expect(rejectDnsRule?.action).toBe("reject");

    const fakeipIndex = dnsRules.findIndex((r: { server?: string }) => r.server === "dns-fakeip");
    expect(fakeipIndex).toBeGreaterThan(-1);
    const rejectIndex = dnsRules.indexOf(rejectDnsRule);
    expect(rejectIndex).toBeLessThan(fakeipIndex);
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
