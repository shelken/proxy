import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { SING_BOX } from "./lib/sandbox.ts";

const TEMPLATE_PATH = resolve(import.meta.dir, "../template.json");
const template = JSON.parse(await Bun.file(TEMPLATE_PATH).text());

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

  test("excludes private LAN and Tailscale CGNAT from tun", () => {
    const tun = template.inbounds.find((i) => i.type === "tun");
    const excluded = tun.route_exclude_address ?? [];
    expect(excluded).toContain("10.0.0.0/8");
    expect(excluded).toContain("172.16.0.0/12");
    expect(excluded).toContain("192.168.0.0/16");
    expect(excluded).toContain("100.64.0.0/10");
  });

  test("blocks QUIC / HTTP3 on UDP 443 and 80", () => {
    const rules = template.route?.rules ?? [];
    const quicRule = rules.find(
      (r) => r.network === "udp" && r.action === "reject",
    );
    expect(quicRule).toBeDefined();
    expect(quicRule.port).toContain(443);
    expect(quicRule.port).toContain(80);
  });

  test("limits sniffers to web/dns protocols to avoid SSH handshake stalls", () => {
    const rules = template.route?.rules ?? [];
    const sniffRule = rules.find((r) => r.action === "sniff");
    expect(sniffRule).toBeDefined();
    expect(sniffRule.sniffer).toEqual(["http", "tls", "quic", "dns"]);
    expect(sniffRule.sniffer).not.toContain("ssh");
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
      (r) => r.server === fakeip?.tag,
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
    // 必须是 dns-local-system：局域网内由路由器应答真实内网 IP，
    // 拿到真实 IP 后出站直连无需再解析，绕开 fakeip → 拨号解析 NXDOMAIN
    expect(zoneRule.server).toBe("dns-local-system");

    // first match wins：命中 fakeip 之前必须已被本条拦下，否则仍会拿到假 IP
    const fakeipIndex = rules.findIndex((r) => r.server === "dns-fakeip");
    const zoneIndex = rules.indexOf(zoneRule);
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
    expect(wildcard.query_type).toContain("A");
    expect(wildcard.action).toBe("predefined");
    expect(wildcard.answer[0]).toContain("192.168.69.46");

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
    expect(template.route?.default_domain_resolver?.server).toBe("dns-local-system");
    // 指向的 server 必须在 dns.servers 里真实存在，否则内核启动 FATAL
    const tags = (template.dns?.servers ?? []).map((s) => s.tag);
    expect(tags).toContain(template.route.default_domain_resolver.server);
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

  test("persists SFM selector choices", () => {
    expect(template.experimental?.cache_file).toMatchObject({
      enabled: true,
      path: "cache.db",
    });
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
});
