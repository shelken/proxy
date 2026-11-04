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
  "10-dns.json",
  "20-route-base.json",
  "29-dns-in.json",
  "90-experimental.json",
];

// sing-box 的 invert 反转的是整条规则的所有条件（v1.14.3 route/rule/rule_abstract.go 的 Match()），
// 所以「排除白名单」只能是外层 AND 限定 tun-in、内层只反转 MAC 的两层写法。把 inbound 和 invert
// 放在同一层时，dns-in 进来的查询（不满足 tun-in，整条为假）会被翻成命中，被 direct 送回本机 53 端口。
export const assertBypassScopedToTunInWithInvertedMac = (rule: Record<string, unknown>) => {
  expect(rule.action).toBe("bypass");
  expect(rule.outbound).toBe("direct");
  expect(rule.type).toBe("logical");
  expect(rule.mode).toBe("and");
  expect(rule.invert).toBeUndefined();
  const [scope, mac] = asArray<Record<string, unknown>>(rule.rules);
  expect(asArray(scope.inbound)).toEqual(["tun-in"]);
  expect(scope.invert).toBeUndefined();
  expect(mac.type).toBe("logical");
  expect(mac.invert).toBe(true);
  const macRules = asArray<Record<string, unknown>>(mac.rules);
  expect(macRules.length).toBe(1);
  expect(asArray(macRules[0].source_mac_address).length).toBe(2);
};

// 结构取自用户指南 05-router.md 的 `bypass` 示例（那里用 `<IPn>/32`，这里换占位 MAC，
// 断言的是两层逻辑与 invert 位置，与条件字段无关）
const WHITELIST_MACS = ["02:00:00:00:00:01", "02:00:00:00:00:02"];

const WHITELIST_OVERLAY = {
  experimental: { clash_api: { secret: "test-secret" } },
  dns: {
    // 本网解析器地址由设备 overlay 提供，底模只留 tag（ADR-0012）
    servers: [{ type: "udp", tag: "dns-lan", server: "192.0.2.1" }],
    rules: [
      {
        source_mac_address: WHITELIST_MACS,
        invert: true,
        server: "dns-lan",
      },
    ],
  },
  route: {
    rules: [
      {
        type: "logical",
        mode: "and",
        rules: [
          { inbound: ["tun-in"] },
          {
            type: "logical",
            mode: "and",
            invert: true,
            rules: [{ source_mac_address: WHITELIST_MACS }],
          },
        ],
        action: "bypass",
        outbound: "direct",
      },
    ],
  },
};

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

// 路由变体的最小 overlay 夹具：本网解析器地址等由设备 overlay 提供（ADR-0012），
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

  test("clash API 不只监听回环：homelab 的面板要能拉到连接", () => {
    const controller: string =
      router.experimental.clash_api.external_controller;
    expect(
      controller.startsWith("127.") || controller.startsWith("[::1]"),
    ).toBe(false);
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
  // 服务端合并口径：01-overlay 在前、02-base 在后（docs/sbtools.md §6）
  const merged = mergeLayers([
    ["01-overlay.json", WHITELIST_OVERLAY],
    ["02-base.json", router],
  ]);
  const mergedRules = merged.route.rules as Array<Record<string, any>>;

  test("合并后通过 check，overlay 的 secret 覆盖底模标量", () => {
    expect(merged.experimental.clash_api.secret).toBe("test-secret");
  });

  test("bypass 规则排第一：外层限定 tun-in，只有 MAC 条件被反转", () => {
    assertBypassScopedToTunInWithInvertedMac(mergedRules[0]);
  });

  test("名单外设备的 DNS 规则排在 dns.rules 第一", () => {
    const first = merged.dns.rules[0];
    expect(first.server).toBe("dns-lan");
    expect(first.invert).toBe(true);
  });
});

// ADR-0012 的补充：本网解析器地址、部署域名与内网入口、放行（不被改写）的解析器清单
// 三项归设备 overlay，底模只留与部署无关的部分。#147 是「以 local 结尾的域名落进
// type: local 的 mDNS 分支、10 秒无应答」，#148 是「auto_redirect 的 53 端口内核劫持
// 在预匹配之前无差别改写设备指定的公网解析器」
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

  // 内核 check 不查这一步（实测 1.14.3：指向不存在的 tag 也 exit 0），
  // 引用错 tag 要到运行期建 DNS 传输时才炸，所以在这里断言
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

  test("invert 拍回与 inbound 同层（单层写法）→ assertBypassScopedToTunInWithInvertedMac 必须失败", () => {
    const flat = {
      inbound: ["tun-in"],
      source_mac_address: ["02:00:00:00:00:01", "02:00:00:00:00:02"],
      invert: true,
      action: "bypass",
      outbound: "direct",
    };
    expect(() => assertBypassScopedToTunInWithInvertedMac(flat)).toThrow();
  });

  test("invert 提到外层（连 tun-in 一起反转）→ 断言必须失败", () => {
    const outer = {
      type: "logical",
      mode: "and",
      invert: true,
      rules: [
        { inbound: ["tun-in"] },
        { source_mac_address: ["02:00:00:00:00:01"] },
      ],
      action: "bypass",
      outbound: "direct",
    };
    expect(() => assertBypassScopedToTunInWithInvertedMac(outer)).toThrow();
  });
});
