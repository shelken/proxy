import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SING_BOX } from "./lib/sandbox.ts";
import {
  asArray,
  assertMyDirectAndProxyBeforeServices,
  assertMyProxyDnsBeforeChinaMax,
  assertMyProxyQuicBeforeExempt,
  assertRejectBeforeClashMode,
} from "./lib/contracts.ts";

const templatePath = resolve(import.meta.dir, "../template-router.json");
const router = JSON.parse(await Bun.file(templatePath).text());
const rules = router.route.rules as Array<Record<string, any>>;

// --- 契约断言（供正向测试与变异验证复用）---

// 局域网设备的 DNS 指向旁路由时，查询经 dns-in 进来，目的地址是旁路由自己（私网）。
// 不在前面劫持就可能落到 ip_is_private → direct，被直连回本机 53 端口绕成环；
// 排在 sniff 之前，也不依赖嗅探是否认出 DNS。
export const assertDnsInHijackFirst = (rules: Array<Record<string, any>>) => {
  const dnsIn = rules.findIndex(
    (r) => asArray(r.inbound).join() === "dns-in" && r.action === "hijack-dns",
  );
  const sniff = rules.findIndex((r) => r.action === "sniff");
  expect(dnsIn).toBeGreaterThanOrEqual(0);
  expect(sniff).toBeGreaterThan(-1);
  expect(dnsIn).toBeLessThan(sniff);
};

// 网关模式：转发流量由 auto_redirect（nftables）接管；overlay 白名单的 bypass 动作也只在它开启时生效
export const assertGatewayTun = (inbounds: Array<Record<string, any>>) => {
  const tun = inbounds.find((i) => i.type === "tun");
  expect(tun?.tag).toBe("tun-in");
  expect(tun?.auto_route).toBe(true);
  expect(tun?.auto_redirect).toBe(true);
};

export const ROUTER_MODULES_WHITELIST = [
  "00-inbounds.json",
  "10-dns-deployment.json",
  "10-dns-lan-resolver.json",
  "29-dns-in.json",
];

// 层名承重：merge 的生效顺序由文件路径字典序决定，与 -c 的 argv 顺序无关（docs/sbtools.md §6）
const mergeLayers = (layers: Array<[string, unknown]>) => {
  const d = mkdtempSync(join(tmpdir(), "router-merge-"));
  try {
    const args = ["merge", join(d, "result.json")];
    for (const [name, content] of layers) {
      const path = join(d, name);
      writeFileSync(path, JSON.stringify(content));
      args.push("-c", path);
    }
    const merge = Bun.spawnSync([SING_BOX, ...args]);
    expect(merge.exitCode).toBe(0);
    const out = join(d, "result.json");
    // auto_redirect 等项只有 Linux 内核认得，macOS 上本地 check 必然失败；
    // 合并结果的内核校验由 CI（ubuntu）与 `just kernel-check-vm router` 覆盖，这里仍校验结构
    if (process.platform === "linux") {
      const check = Bun.spawnSync([SING_BOX, "check", "-D", d, "-c", out]);
      expect(check.exitCode).toBe(0);
    }
    return JSON.parse(readFileSync(out, "utf8"));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
};

// 路由变体的最小 overlay 夹具：本网解析器地址等由设备 overlay 提供（ADR-0013），
// 单份 template-router.json 引用不到那些 tag，装配出终态才能验到这道接缝。
// 与 justfile 的 `merge-variant-fixture.sh` 读同一份文件
const OVERLAY_FIXTURE = JSON.parse(
  readFileSync(resolve(import.meta.dir, "fixtures/router-overlay.json"), "utf8"),
);

describe("template-router.json 结构契约（ADR-0012）", () => {
  test("tun 开启 auto_route 与 auto_redirect", () => {
    assertGatewayTun(router.inbounds);
  });

  test("tun 仍排除私网段：局域网互访不进 sing-box", () => {
    const tun = router.inbounds.find((i: any) => i.type === "tun");
    expect(asArray<string>(tun.route_exclude_address)).toContain(
      "192.168.0.0/16",
    );
  });

  test("dns-in 在 53 端口对局域网监听，并在 sniff 之前劫持", () => {
    const dnsIn = router.inbounds.find((i: any) => i.tag === "dns-in");
    expect(dnsIn.type).toBe("direct");
    expect(dnsIn.listen_port).toBe(53);
    expect(["::", "0.0.0.0"]).toContain(dnsIn.listen);
    assertDnsInHijackFirst(rules);
  });

  test("mixed-in 保持回环，不对局域网开无认证代理", () => {
    const mixed = router.inbounds.find((i: any) => i.tag === "mixed-in");
    expect(mixed.listen).toBe("127.0.0.1");
  });

  test("底模不含设备数据：白名单与 secret 只能放 overlay", () => {
    const text = JSON.stringify(router);
    expect(text).not.toContain("source_mac_address");
    expect(text).not.toContain("source_ip_cidr");
    expect(router.experimental.clash_api.secret).toBeUndefined();
  });
});

// ADR-0013 的 DNS 归属：本网解析器定义、部署域名与内网入口的静态应答归共享底模的能力
// 文件，路由变体用同名空集弃用，地址与放行清单归设备 overlay。#147 是「以 local 结尾的
// 域名落进 type: local 的 mDNS 分支、10 秒无应答」，#148 是「auto_redirect 的 53 端口
// 内核劫持在预匹配之前无差别改写设备指定的公网解析器」
describe("DNS 归属契约：底模与 overlay 的分界", () => {
  test("底模不依赖宿主默认语义：没有 type: local", () => {
    expect(router.dns.servers.some((s: any) => s.type === "local")).toBe(false);
  });

  test("底模不含部署数据与本网地址", () => {
    const text = JSON.stringify(router);
    expect(text).not.toContain("ooooo.space");
    // 私网段只出现在 tun 的排除清单（局域网互访不进 sing-box 的守卫），不在 DNS 与路由定义里
    expect(JSON.stringify({ dns: router.dns, route: router.route })).not.toContain(
      "192.168.",
    );
    expect(router.dns.servers.some((s: any) => s.tag === "dns-lan")).toBe(false);
  });

  test("RFC 保留后缀与局域网清单指向 overlay 提供的 dns-lan", () => {
    const suffix = router.dns.rules.find((r: any) =>
      asArray(r.domain_suffix).includes("home.arpa"),
    );
    expect(asArray(suffix.domain_suffix)).toEqual(["local", "lan", "home.arpa"]);
    expect(suffix.server).toBe("dns-lan");
    const lan = router.dns.rules.find((r: any) =>
      asArray(r.rule_set).includes("Lan-dns"),
    );
    expect(lan.server).toBe("dns-lan");
  });

  test("默认解析器与 PTR 也交给 overlay 的 dns-lan", () => {
    // merge 会把只含 server 的 default_domain_resolver 序列化成字符串形式
    const ddr = router.route.default_domain_resolver;
    expect(typeof ddr === "string" ? ddr : ddr.server).toBe("dns-lan");
    const ptr = router.dns.rules.find((r: any) =>
      asArray(r.query_type).includes("PTR"),
    );
    expect(ptr.server).toBe("dns-lan");
  });

  test("tun 不再做内核侧 53 劫持，53 只由路由规则喊话", () => {
    const tun = router.inbounds.find((i: any) => i.type === "tun");
    expect(tun.dns_mode).toBe("native");
    const byPort = rules.find(
      (r) => asArray(r.port).map(Number).includes(53) && r.action === "hijack-dns",
    );
    expect(byPort).toBeDefined();
  });
});

describe("overlay 夹具：底模 + 最小 overlay 装成可运行终态", () => {
  // 底模引用不到只有 overlay 才有的 dns-lan（本网解析器地址归设备），单份不完整，
  // 装配出终态才是能跑起来的配置：这里在 Linux 上顺带跑内核 check（CI 同口径），
  // macOS 宿主的内核不支持 auto_redirect，交给 `just template-router-check` 转沙箱 VM
  const merged = mergeLayers([
    ["00-overlay.json", OVERLAY_FIXTURE],
    ["01-base.json", router],
  ]);

  test("夹具补上底模引用不到的 dns-lan", () => {
    expect(merged.dns.servers.map((s: any) => s.tag)).toContain("dns-lan");
  });

  // 底模的 clash API 与 Mac 一致只监听回环，对局域网监听由设备 overlay 覆盖。
  // homelab 的面板要能拉到旁路由的连接，地址必须真的落在终态里
  test("终态 clash API 不只监听回环：地址由 overlay 覆盖", () => {
    const controller: string = merged.experimental.clash_api.external_controller;
    expect(
      controller.startsWith("127.") || controller.startsWith("[::1]"),
    ).toBe(false);
  });

  // 终态引用的 DNS 服务器都有定义。内核只查 route.default_domain_resolver：
  // 缺了它 check 直接 FATAL（initialize outbound[0]: default domain resolver not found），
  // 但 dns.rules 的 server 与 dns.final 指向不存在的 tag 时 check 仍 exit 0（1.14.3 实测），
  // 要到运行期才炸，所以这两处在测试里断言
  test("终态引用的 DNS 服务器都有定义", () => {
    const tags = new Set(merged.dns.servers.map((s: any) => s.tag));
    const ddr = merged.route.default_domain_resolver;
    expect(tags.has(merged.dns.final)).toBe(true);
    expect(tags.has(typeof ddr === "string" ? ddr : ddr.server)).toBe(true);
    for (const rule of merged.dns.rules as Array<Record<string, any>>) {
      if (rule.server) expect(tags.has(rule.server)).toBe(true);
    }
  });

  test("夹具的放行规则排在底模的 53 劫持之前", () => {
    expect(merged.route.rules[0].action).toBe("bypass");
    expect(merged.route.rules[1].action).toBe("hijack-dns");
  });
});

// 共享模块的顺序约束在路由器侧同样成立，口径与 iOS 侧一致
describe("共享顺序契约（路由器侧）", () => {
  test("全部 reject 规则排在首个 clash_mode 之前（ADR-0008）", () => {
    assertRejectBeforeClashMode(rules);
  });

  test("MyDirect/MyProxy 排在所有服务规则之前（ADR-0007）", () => {
    assertMyDirectAndProxyBeforeServices(rules, router.outbounds);
  });

  test("MyProxy 的 QUIC 拒绝先于国内豁免（ADR-0011）", () => {
    assertMyProxyQuicBeforeExempt(rules);
  });

  test("MyProxy-dns 先于 ChinaMax-dns（ADR-0011）", () => {
    assertMyProxyDnsBeforeChinaMax(router.dns.rules);
  });
});

describe("modules-router 差异面白名单", () => {
  test("modules-router/ 文件集合与登记一致", () => {
    expect(
      readdirSync(resolve(import.meta.dir, "../modules-router")).sort(),
    ).toEqual([...ROUTER_MODULES_WHITELIST].sort());
  });
});

// --- 变异验证：证明上面的断言不是恒真的 ---
const clone = (obj: any) => JSON.parse(JSON.stringify(obj));

describe("变异验证：断言能拦住坏情况", () => {
  test("dns-in 劫持被移到 sniff 之后 → assertDnsInHijackFirst 必须失败", () => {
    const r = clone(rules);
    const idx = r.findIndex((x: any) => asArray(x.inbound).join() === "dns-in");
    const [moved] = r.splice(idx, 1);
    const sniff = r.findIndex((x: any) => x.action === "sniff");
    r.splice(sniff + 1, 0, moved);
    expect(() => assertDnsInHijackFirst(r)).toThrow();
  });

  test("tun 去掉 auto_redirect → assertGatewayTun 必须失败", () => {
    const inbounds = clone(router.inbounds);
    delete inbounds.find((i: any) => i.type === "tun").auto_redirect;
    expect(() => assertGatewayTun(inbounds)).toThrow();
  });
});
