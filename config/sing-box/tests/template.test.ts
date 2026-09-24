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

  test("declares all 32 public rule sets", () => {
    const ruleSets = template.route?.rule_set ?? [];
    expect(ruleSets.length).toBe(32);
    const tags = ruleSets.map((r) => r.tag);
    expect(tags).not.toContain("zone-internal");
    expect(tags).toContain("OpenAI");
    expect(tags).toContain("Gemini");
    expect(tags).toContain("ChinaMax");
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
    const lanRule = rules.find((r) => r.rule_set?.includes("Lan"));
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


  test("declares all 9 native strategy groups", () => {
    const selectors = (template.outbounds ?? []).filter((o) => o.type === "selector");
    const tags = selectors.map((s) => s.tag);
    const expected = [
      "proxy", "openai", "gemini", "dev", "adultnsfw",
      "appleai", "ptcg", "japansite", "opencode"
    ];
    for (const tag of expected) {
      expect(tags).toContain(tag);
    }
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
