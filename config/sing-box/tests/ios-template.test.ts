import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { SING_BOX } from "./lib/sandbox.ts";

const load = async (name: string) =>
  JSON.parse(await Bun.file(resolve(import.meta.dir, "..", name)).text());
const ios = await load("template-ios.json");
const mac = await load("template.json");

const asArray = <T>(v: T | T[] | undefined): T[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];
const rules = ios.route.rules as Array<Record<string, any>>;
const indexOfRule = (pred: (r: Record<string, any>) => boolean) => rules.findIndex(pred);

// 内核 merge 会省略取默认值的布尔字段（false），断言按默认值对待。
describe("template-ios.json 结构契约（ADR-0010）", () => {
  test("通过 sing-box check", () => {
    const proc = Bun.spawnSync([SING_BOX, "check", "-c", resolve(import.meta.dir, "../template-ios.json")]);
    expect(proc.exitCode).toBe(0);
  });

  test("ts-ep 入站拒绝是第一条路由规则：Tailnet 连入手机会被改写成 127.0.0.1，晚于私网直连就读到本机服务", () => {
    expect(asArray(rules[0].inbound)).toEqual(["ts-ep"]);
    expect(rules[0].action).toBe("reject");
  });

  test("preferred_by ts-ep 在 DNS 劫持之后、私网直连之前", () => {
    const hijack = indexOfRule((r) => r.protocol === "dns");
    const toTs = indexOfRule((r) => r.preferred_by !== undefined && r.outbound === "ts-ep");
    const priv = indexOfRule((r) => r.ip_is_private === true);
    expect(toTs).toBeGreaterThan(hijack);
    expect(toTs).toBeLessThan(priv);
  });

  test("tun 不再排除私网段，子网路由才能进入 sing-box；链路本地仍排除", () => {
    const tun = ios.inbounds.find((i) => i.type === "tun");
    const excluded = asArray<string>(tun.route_exclude_address);
    for (const cidr of ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]) {
      expect(excluded).not.toContain(cidr);
    }
    expect(excluded).toContain("fe80::/10");
  });

  test("tailscale endpoint 只接收子网路由，不做 exit node，不开系统接口", () => {
    const [ep] = ios.endpoints;
    expect(ep.type).toBe("tailscale");
    expect(ep.tag).toBe("ts-ep");
    expect(ep.accept_routes).toBe(true);
    expect(ep.system_interface ?? false).toBe(false);
    expect(ep.exit_node).toBeUndefined();
  });

  test("MagicDNS 规则排在 ChinaMax-dns 与 FakeIP 之前，且不接管默认解析", () => {
    const dnsRules = ios.dns.rules as Array<Record<string, any>>;
    const ts = dnsRules.findIndex((r) => r.server === "dns-ts");
    const china = dnsRules.findIndex((r) => asArray(r.rule_set).includes("ChinaMax-dns"));
    const fake = dnsRules.findIndex((r) => r.server === "dns-fakeip");
    expect(ts).toBeGreaterThanOrEqual(0);
    expect(ts).toBeLessThan(china);
    expect(ts).toBeLessThan(fake);
    const server = ios.dns.servers.find((s) => s.tag === "dns-ts");
    expect(server.accept_default_resolvers ?? false).toBe(false);
  });

  test("Mac 底模不含 Tailscale endpoint 且保留私网排除", () => {
    expect(mac.endpoints).toBeUndefined();
    const tun = mac.inbounds.find((i) => i.type === "tun");
    expect(tun.route_exclude_address).toContain("192.168.0.0/16");
  });
});
