import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { SING_BOX } from "./lib/sandbox.ts";
import {
  asArray,
  assertAllRuleSetsDeclared,
  assertMyDirectAndProxyBeforeServices,
  assertMyProxyDnsBeforeChinaMax,
  assertMyProxyQuicBeforeExempt,
  assertRejectBeforeClashMode,
} from "./lib/contracts.ts";

const load = async (name: string) =>
  JSON.parse(await Bun.file(resolve(import.meta.dir, "..", name)).text());
const ios = await load("template-ios.json");
const mac = await load("template.json");

const rules = ios.route.rules as Array<Record<string, any>>;

// --- 提取的契约断言函数（供正向契约测试与变异验证复用）---

export const assertPreferredByTsEp = (rules: Array<Record<string, any>>) => {
  const hijack = rules.findIndex((r) => r.protocol === "dns");
  const toTs = rules.findIndex(
    (r) => r.outbound === "ts-ep" && asArray(r.preferred_by).join() === "ts-ep",
  );
  const priv = rules.findIndex((r) => r.ip_is_private === true);
  expect(toTs).toBeGreaterThanOrEqual(0);
  expect(toTs).toBeGreaterThan(hijack);
  expect(toTs).toBeLessThan(priv);
};

export const assertMagicDns = (dns: Record<string, any>) => {
  const dnsRules = (dns.rules ?? []) as Array<Record<string, any>>;
  const ts = dnsRules.findIndex(
    (r) => r.server === "dns-ts" && asArray(r.preferred_by).join() === "dns-ts",
  );
  const china = dnsRules.findIndex((r) => asArray(r.rule_set).includes("ChinaMax-dns"));
  const fake = dnsRules.findIndex((r) => r.server === "dns-fakeip");
  expect(ts).toBeGreaterThanOrEqual(0);
  // ChinaMax 不在当前设置里时无此约束
  if (china >= 0) expect(ts).toBeLessThan(china);
  expect(ts).toBeLessThan(fake);
  const server = (dns.servers ?? []).find((s: any) => s.tag === "dns-ts");
  expect(server?.accept_default_resolvers ?? false).toBe(false);
  expect(server?.type).toBe("tailscale");
  expect(server?.endpoint).toBe("ts-ep");
};

// iOS 的差异面：inbounds 换成 iOS 版，另加 Tailscale（入站拒绝、endpoint、DNS、路由）。
// 顺序约束就是产物里的位置：入站拒绝早于 sniff 与 DNS 劫持，Tailscale 路由晚于 sniff、早于私网直连。

// 内核 merge 会省略取默认值的布尔字段（false），断言按默认值对待。
describe("template-ios.json 结构契约（ADR-0010）", () => {
  test("通过 sing-box check", () => {
    const proc = Bun.spawnSync([SING_BOX, "check", "-c", resolve(import.meta.dir, "../template-ios.json")]);
    expect(proc.exitCode).toBe(0);
  });

  test("log 级别为 info", () => {
    expect(ios.log).toEqual({ level: "info" });
  });

  test("ts-ep 入站拒绝是第一条路由规则：Tailnet 连入手机会被改写成 127.0.0.1，晚于私网直连就读到本机服务", () => {
    expect(asArray(rules[0].inbound)).toEqual(["ts-ep"]);
    expect(rules[0].action).toBe("reject");
  });

  test("preferred_by ts-ep 在 DNS 劫持之后、私网直连之前", () => {
    assertPreferredByTsEp(rules);
  });

  test("tun 不再排除私网段，子网路由才能进入 sing-box；链路本地、组播与有限广播仍排除", () => {
    const tun = ios.inbounds.find((i) => i.type === "tun");
    const excluded = asArray<string>(tun.route_exclude_address);
    for (const cidr of ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]) {
      expect(excluded).not.toContain(cidr);
    }
    // Tailscale 不转发组播与广播（tailscale#11134），收进 TUN 只会让 Bonjour 等局域网发现失效
    for (const cidr of ["fe80::/10", "224.0.0.0/4", "255.255.255.255/32"]) {
      expect(excluded).toContain(cidr);
    }
  });

  // SideStore 的 minimuxer 只在 utun 路由表里找设备地址；没有独立的 10.7.0.1/32 路由就找不到。
  // 写了 route_address 即失去默认路由，所以 0.0.0.0/0 必须保留；不写 IPv6，v6 沿用默认。
  test("tun 为 SideStore 回环地址留独立路由，且不丢全量 IPv4 路由", () => {
    const tun = ios.inbounds.find((i) => i.type === "tun");
    expect(asArray(tun.loopback_address)).toContain("10.7.0.1");
    const routes = asArray<string>(tun.route_address);
    expect(routes).toContain("10.7.0.1/32");
    expect(routes).toContain("0.0.0.0/0");
    expect(routes.filter((cidr) => cidr.includes(":"))).toEqual([]);
  });

  // minimuxer 的 resolveCandidateTunnels 只接受「有 IPv4 且没有 IPv6」的 utun，带 IPv6 的接口在探测前就被丢弃（#167）。
  // Mac 与路由器模板仍保持双栈，只有 iOS 要给 SideStore 留回环。
  test("tun 只配 IPv4，SideStore 才会把它当作回环接口", () => {
    const tun = ios.inbounds.find((i) => i.type === "tun");
    const addresses = asArray<string>(tun.address);
    expect(addresses.length).toBeGreaterThan(0);
    expect(addresses.filter((addr) => addr.includes(":"))).toEqual([]);
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
    assertMagicDns(ios.dns);
  });

  // Peer 的 DNS 查询由 tailscale 依赖直接交给 dnsRouter（endpoint.go HandlePeerDNSQuery），
  // 不经过 route.rules，路由层的入站拒绝覆盖不到，DNS 层必须有自己的入站拒绝。
  test("dns.rules 首条拒绝 ts-ep 入站，且早于 MagicDNS 规则与静态应答", () => {
    const dnsRules = ios.dns.rules as Array<Record<string, any>>;
    expect(asArray(dnsRules[0].inbound)).toEqual(["ts-ep"]);
    expect(dnsRules[0].action).toBe("reject");
  });

  test("Mac 底模不含 Tailscale endpoint 且保留私网排除", () => {
    expect(mac.endpoints).toBeUndefined();
    const tun = mac.inbounds.find((i) => i.type === "tun");
    expect(tun.route_exclude_address).toContain("192.168.0.0/16");
  });
});

// 共享片段的顺序约束在 iOS 侧同样成立（CODING_STANDARDS：拦截 > 模式开关 > 服务分流，
// MyDirect/MyProxy 排在所有服务规则之前）。设置更新只跑 Mac 测试时，
// 违反顺序的改动对 iOS 不可见，这里补上同口径断言。
describe("共享顺序契约（iOS 侧）", () => {
  test("全部 reject 规则排在首个 clash_mode 之前（ADR-0008）", () => {
    assertRejectBeforeClashMode(rules);
  });

  test("MyDirect/MyProxy 排在所有服务规则之前（ADR-0007）", () => {
    assertMyDirectAndProxyBeforeServices(rules, ios.outbounds);
  });

  test("MyProxy 的 QUIC 拒绝先于国内豁免（ADR-0011）", () => {
    assertMyProxyQuicBeforeExempt(rules);
  });

  test("MyProxy-dns 先于 ChinaMax-dns（ADR-0011）", () => {
    assertMyProxyDnsBeforeChinaMax(ios.dns.rules);
  });
});

// 产物不变量：规则引用的 tag 必须在同一份产物里声明（内核对此静默，见 lib/contracts.ts）
describe("生成产物不变量", () => {
  test("route.rules 引用的 rule_set 全部已在 route.rule_set 里声明", () => {
    assertAllRuleSetsDeclared(ios.route);
  });
});

// --- 变异验证：证明上面的断言不是恒真的 ---
// 用内存深拷贝故意破坏模板字段与次序，确认提取的契约断言真的会抛错。
// 防止以后有人改坏断言逻辑（如 indexOfRule 返回 -1 漏判）导致静默通过。

const clone = (obj: any) => JSON.parse(JSON.stringify(obj));

describe("变异验证：断言能拦住坏情况", () => {
  test("reject 被移到 clash_mode 之后 → assertRejectBeforeClashMode 必须失败", () => {
    const bad = clone(ios);
    const r = bad.route.rules;
    const clashIdx = r.findIndex((x: any) => x.clash_mode !== undefined);
    const rejectIdx = r.findIndex((x: any) => x.action === "reject");
    const [moved] = r.splice(rejectIdx, 1);
    r.splice(clashIdx, 0, moved);
    expect(() => assertRejectBeforeClashMode(r)).toThrow();
  });

  test("MyDirect 被移到服务规则之后 → assertMyDirectAndProxyBeforeServices 必须失败", () => {
    const bad = clone(ios);
    const r = bad.route.rules;
    const directIdx = r.findIndex(
      (x: any) => x.outbound === "direct" && asArray(x.rule_set).includes("MyDirect"),
    );
    if (directIdx < 0) return; // 当前设置无此规则，无可移动的坏例
    const [moved] = r.splice(directIdx, 1);
    r.push(moved);
    expect(() => assertMyDirectAndProxyBeforeServices(r, ios.outbounds)).toThrow();
  });

  test("MyProxy 被移到服务规则之后 → assertMyDirectAndProxyBeforeServices 必须失败", () => {
    const bad = clone(ios);
    const r = bad.route.rules;
    const proxyIdx = r.findIndex(
      (x: any) => x.outbound === "proxy" && asArray(x.rule_set).includes("MyProxy"),
    );
    if (proxyIdx < 0) return; // 当前设置无此规则
    const [moved] = r.splice(proxyIdx, 1);
    r.push(moved);
    expect(() => assertMyDirectAndProxyBeforeServices(r, ios.outbounds)).toThrow();
  });

  test("MyProxy 的 QUIC 拒绝移到国内豁免之后 → assertMyProxyQuicBeforeExempt 必须失败", () => {
    const bad = clone(ios);
    const r = bad.route.rules;
    const idx = r.findIndex(
      (x: any) => x.action === "reject" && asArray(x.rule_set).includes("MyProxy"),
    );
    if (idx < 0) return; // 当前设置无此规则
    const [moved] = r.splice(idx, 1);
    const exemptIdx = r.findIndex((x: any) => x.network === "udp" && x.outbound === "direct");
    r.splice(exemptIdx + 1, 0, moved);
    expect(() => assertMyProxyQuicBeforeExempt(r)).toThrow();
  });

  test("MyProxy-dns 移到 ChinaMax-dns 之后 → assertMyProxyDnsBeforeChinaMax 必须失败", () => {
    const bad = clone(ios);
    const d = bad.dns.rules;
    const idx = d.findIndex((x: any) => asArray(x.rule_set).includes("MyProxy-dns"));
    const chinaIdx = d.findIndex((x: any) => asArray(x.rule_set).includes("ChinaMax-dns"));
    if (idx < 0 || chinaIdx < 0) return; // 伴生不在当前设置里，无可移动的坏例
    const [moved] = d.splice(idx, 1);
    d.splice(chinaIdx + 1, 0, moved);
    expect(() => assertMyProxyDnsBeforeChinaMax(d)).toThrow();
  });

  test("路由 preferred_by 改成不存在的 tag → assertPreferredByTsEp 必须失败（防 postmortem-014 恒真坑）", () => {
    const bad = clone(ios);
    const r = bad.route.rules;
    const idx = r.findIndex(
      (x: any) =>
        x.outbound === "ts-ep" && asArray(x.preferred_by).join() === "ts-ep",
    );
    r[idx].preferred_by = ["nonexistent-tag"];
    expect(() => assertPreferredByTsEp(r)).toThrow();
  });

  test("MagicDNS 删掉 preferred_by → assertMagicDns 必须失败（防 postmortem-014 恒真坑）", () => {
    const bad = clone(ios);
    const dnsRules = bad.dns.rules;
    const idx = dnsRules.findIndex(
      (x: any) => x.server === "dns-ts" && asArray(x.preferred_by).join() === "dns-ts",
    );
    delete dnsRules[idx].preferred_by;
    expect(() => assertMagicDns(bad.dns)).toThrow();
  });
});
