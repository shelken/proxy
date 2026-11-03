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

export const ROUTER_MODULES_WHITELIST = ["00-inbounds.json", "29-dns-in.json", "90-experimental.json"];

// 与用户指南 05-router.md 的示例一致，MAC 为文档占位地址
const WHITELIST_OVERLAY = {
  experimental: { clash_api: { secret: "test-secret" } },
  dns: {
    rules: [
      {
        source_mac_address: ["02:00:00:00:00:01", "02:00:00:00:00:02"],
        invert: true,
        server: "dns-local-system",
      },
    ],
  },
  route: {
    rules: [
      {
        inbound: ["tun-in"],
        source_mac_address: ["02:00:00:00:00:01", "02:00:00:00:00:02"],
        invert: true,
        action: "bypass",
        outbound: "direct",
      },
    ],
  },
};

// 服务端合并口径：01-overlay 在前、02-base 在后（docs/sbtools.md §6）
const mergeWithOverlay = (overlay: object) => {
  const d = mkdtempSync(join(tmpdir(), "router-overlay-"));
  try {
    writeFileSync(join(d, "01-overlay.json"), JSON.stringify(overlay));
    writeFileSync(join(d, "02-base.json"), JSON.stringify(router));
    const out = join(d, "result.json");
    const merge = Bun.spawnSync([SING_BOX, "merge", out, "-c", join(d, "01-overlay.json"), "-c", join(d, "02-base.json")]);
    expect(merge.exitCode).toBe(0);
    const check = Bun.spawnSync([SING_BOX, "check", "-D", d, "-c", out]);
    expect(check.exitCode).toBe(0);
    return JSON.parse(readFileSync(out, "utf8"));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
};

describe("template-router.json 结构契约（ADR-0012）", () => {
  test("通过 sing-box check", () => {
    const d = mkdtempSync(join(tmpdir(), "router-check-"));
    try {
      expect(Bun.spawnSync([SING_BOX, "check", "-D", d, "-c", templatePath]).exitCode).toBe(0);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("tun 开启 auto_route 与 auto_redirect", () => {
    assertGatewayTun(router.inbounds);
  });

  test("tun 仍排除私网段：局域网互访不进 sing-box", () => {
    const tun = router.inbounds.find((i: any) => i.type === "tun");
    expect(asArray<string>(tun.route_exclude_address)).toContain("192.168.0.0/16");
  });

  test("dns-in 在 53 端口对局域网监听，并在 sniff 之前劫持", () => {
    const dnsIn = router.inbounds.find((i: any) => i.tag === "dns-in");
    expect(dnsIn.type).toBe("direct");
    expect(dnsIn.listen_port).toBe(53);
    expect(["::", "0.0.0.0"]).toContain(dnsIn.listen);
    assertDnsInHijackFirst(rules);
  });

  test("clash API 不只监听回环：homelab 的面板要能拉到连接", () => {
    const controller: string = router.experimental.clash_api.external_controller;
    expect(controller.startsWith("127.") || controller.startsWith("[::1]")).toBe(false);
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

describe("白名单 overlay 示例（05-router.md）", () => {
  const merged = mergeWithOverlay(WHITELIST_OVERLAY);
  const mergedRules = merged.route.rules as Array<Record<string, any>>;

  test("合并后通过 check，overlay 的 secret 覆盖底模标量", () => {
    expect(merged.experimental.clash_api.secret).toBe("test-secret");
  });

  test("bypass 规则排第一，且限定 tun-in：dns-in 的查询不会被 direct 送回本机", () => {
    expect(mergedRules[0].action).toBe("bypass");
    expect(asArray(mergedRules[0].inbound)).toEqual(["tun-in"]);
    expect(mergedRules[0].invert).toBe(true);
  });

  test("名单外设备的 DNS 规则排在 dns.rules 第一", () => {
    const first = merged.dns.rules[0];
    expect(first.server).toBe("dns-local-system");
    expect(first.invert).toBe(true);
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
    expect(readdirSync(resolve(import.meta.dir, "../modules-router")).sort()).toEqual(
      [...ROUTER_MODULES_WHITELIST].sort(),
    );
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
