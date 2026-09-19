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

  test("declares all 27 public rule sets", () => {
    const ruleSets = template.route?.rule_set ?? [];
    expect(ruleSets.length).toBe(27);
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

  test("configures ipv4_only DNS strategy", () => {
    expect(template.dns?.strategy).toBe("ipv4_only");
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
});
