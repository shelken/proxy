#!/usr/bin/env bun
// 底模生成器的集成测试：直接驱动 settings → config 装配（不跑 sing-box merge）。
// 产物与 dc8c8f5 的逐字节对比由 just template-check / CI 重算守；这里守生成逻辑本身。

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildConfig, loadSettings, validateBaseRefs, type Base, type Platform } from "./build-config.ts";

const CONFIG = resolve(import.meta.dir, "../config/sing-box");
const base = Bun.YAML.parse(readFileSync(join(CONFIG, "base.yaml"), "utf8")) as Base;
const mac = Bun.YAML.parse(readFileSync(join(CONFIG, "platforms/mac.yaml"), "utf8")) as Platform;
const defaults = loadSettings(base);

const xiaomiUrl =
  "https://cdn.jsdelivr.net/gh/razaxq/dns-blocklists-sing-box@rule-set/hagezi-tracker-xiaomi.srs";

/** 把一段 settings.yaml 写到临时目录，返回路径。路径解析必须相对它，而不是调用者 cwd。 */
function withSettings(yaml: string) {
  const dir = mkdtempSync(join(tmpdir(), "build-config-"));
  const path = join(dir, "settings.yaml");
  writeFileSync(path, yaml);
  return { dir, path };
}

const ruleSet = (cfg: Record<string, any>, tag: string) =>
  cfg.route.rule_set.find((rs: { tag: string }) => rs.tag === tag);

describe("默认 settings：生成结构", () => {
  const cfg = buildConfig(base, mac, defaults);
  const rules = cfg.route.rules as Array<Record<string, any>>;

  test("log 与 DNS 伴生声明来自 base", () => {
    expect(cfg.log).toEqual({ level: "info" });
    expect(cfg.route.rule_set.slice(0, base.dns_rule_sets.length).map((r: any) => r.tag)).toEqual(
      base.dns_rule_sets,
    );
  });

  test("拦截合并成一条，且排在 QUIC 守卫与 clash_mode 之前", () => {
    const reject = rules.find((r) => r.action === "reject" && r.rule_set?.includes("Advertising"));
    expect(reject?.rule_set).toEqual(["Advertising", "Hijacking", "MyReject", "Privacy"]);
    const quic = rules.findIndex((r) => r.network === "udp" && r.action === "reject" && r.rule_set === undefined);
    const clash = rules.findIndex((r) => r.clash_mode !== undefined);
    expect(rules.indexOf(reject!)).toBeLessThan(quic);
    expect(rules.indexOf(reject!)).toBeLessThan(clash);
  });

  test("rest 段按 settings 顺序，相邻同去向合并；tail 直连/代理各自一条", () => {
    const direct = rules.find((r) => r.outbound === "direct" && r.rule_set?.includes("ChinaMax"));
    expect(direct?.rule_set).toEqual(["ChinaMax", "Lan", "cftunnel", "geoip-cn"]);
    const proxy = rules.find((r) => r.outbound === "proxy" && r.rule_set?.includes("YouTube"));
    expect(proxy?.rule_set).toEqual([
      "Facebook",
      "Instagram",
      "Spotify",
      "Telegram",
      "TikTok",
      "Twitter",
      "YouTube",
    ]);
    // download 走固定段：在 torrent 之后、resolve 之前
    const download = rules.findIndex((r) => r.outbound === "download");
    const torrent = rules.findIndex((r) => r.protocol === "bittorrent");
    const resolveIdx = rules.findIndex((r) => r.action === "resolve");
    expect(torrent).toBeGreaterThan(-1);
    expect(torrent).toBeLessThan(download);
    expect(download).toBeLessThan(resolveIdx);
  });

  test("resolve 排除清单 = base 固定部分 + 默认直连分组", () => {
    const resolveRule = rules.find((r) => r.action === "resolve");
    const microsoft = defaults.rules.find((r) => r.to === "microsoft")!.name;
    expect(resolveRule?.invert).toBe(true);
    expect(resolveRule?.rule_set).toEqual([
      "ChinaMax",
      "Lan",
      "MyDirect",
      "cftunnel",
      "geoip-cn",
      microsoft,
      "PayPal",
      "Apple",
    ]);
  });

  test("分组生成 selector，追加在 base 出站之后", () => {
    const names = Object.keys(defaults.groups);
    for (const name of names) {
      const sel = cfg.outbounds.find((o: any) => o.tag === name);
      expect(sel?.type).toBe("selector");
      expect(sel?.interrupt_exist_connections).toBe(true);
    }
    expect(cfg.outbounds.map((o: any) => o.tag)).toEqual([
      ...base.outbounds.map((o) => o.tag),
      ...names,
    ]);
  });
});

describe("变异验证：断言不是恒真", () => {
  test("把 reject 固定段移到 QUIC 守卫之后 → 顺序断言必须失败", () => {
    const routeRules = [...base.route.rules];
    const [slot] = routeRules.splice(
      routeRules.findIndex((r) => r.slot === "reject"),
      1,
    );
    routeRules.push(slot);
    const mutated = { ...base, route: { ...base.route, rules: routeRules } } as Base;
    const cfg = buildConfig(mutated, mac, defaults);
    const rules = cfg.route.rules as Array<Record<string, any>>;
    const reject = rules.findIndex((r) => r.action === "reject" && r.rule_set?.includes("Advertising"));
    const quic = rules.findIndex((r) => r.network === "udp" && r.action === "reject");
    expect(reject).toBeGreaterThan(quic);
  });
});

describe("新增远程 .srs（小米）", () => {
  test("三端声明有且仅一次，进入拦截段，不改默认设置", () => {
    const { path } = withSettings(
      [
        "rules:",
        "  - { name: 小米追踪, source: '" + xiaomiUrl + "', to: reject }",
      ].join("\n"),
    );
    const settings = loadSettings(base, path);
    const cfg = buildConfig(base, mac, settings);
    expect(JSON.stringify(cfg).split(xiaomiUrl).length - 1).toBe(1);
    const reject = cfg.route.rules.find((r: any) => r.action === "reject");
    expect(reject?.rule_set).toEqual(["小米追踪"]);
    expect(ruleSet(cfg, "小米追踪")?.url).toBe(xiaomiUrl);
    // 默认设置未被临时文件影响
    expect(loadSettings(base).rules.some((r) => r.name === "小米追踪")).toBe(false);
  });
});

describe("增删改的产物一致性", () => {
  test("多个规则共享一个 group：组只生成一次，两条规则各自声明", () => {
    const { path } = withSettings(
      [
        "groups:",
        "  shared: { options: [proxy, direct], default: proxy }",
        "rules:",
        "  - { name: A, source: 'https://example.com/a.srs', to: shared }",
        "  - { name: B, source: 'https://example.com/b.srs', to: shared }",
      ].join("\n"),
    );
    const cfg = buildConfig(base, mac, loadSettings(base, path));
    expect(cfg.outbounds.filter((o: any) => o.tag === "shared")).toHaveLength(1);
    const matched = cfg.route.rules.filter((r: any) => r.outbound === "shared");
    expect(matched.flatMap((r: any) => r.rule_set)).toEqual(["A", "B"]);
  });

  test("改去向：MyDirect 由 direct 改 proxy 后从 resolve 排除清单消失", () => {
    const settings = {
      groups: defaults.groups,
      rules: defaults.rules.map((r) => (r.name === "MyDirect" ? { ...r, to: "proxy" } : r)),
    };
    const cfg = buildConfig(base, mac, settings);
    const resolveRule = cfg.route.rules.find((r: any) => r.action === "resolve");
    expect(resolveRule.rule_set).not.toContain("MyDirect");
  });

  test("没有拦截规则时不产出空 rule_set（避免变成全匹配）", () => {
    const settings = {
      groups: {},
      rules: [{ name: "A", source: xiaomiUrl, to: "proxy" }],
    };
    const cfg = buildConfig(base, mac, settings);
    expect(
      cfg.route.rules.some((r: any) => Array.isArray(r.rule_set) && r.rule_set.length === 0),
    ).toBe(false);
    expect(cfg.route.rules.find((r: any) => r.action === "resolve").rule_set).toBeUndefined();
  });

  test("删除 base 引用的清单 → validateBaseRefs 报未声明，不静默断链", () => {
    const settings = {
      groups: defaults.groups,
      rules: defaults.rules.filter((r) => r.name !== "MyReject"),
    };
    const errors = validateBaseRefs(base, settings);
    expect(errors.some((e) => e.includes("MyReject"))).toBe(true);
  });
});

describe("settings 校验报错定位到条目", () => {
  const expectError = (yaml: string, pattern: RegExp) => {
    const { path } = withSettings(yaml);
    expect(() => loadSettings(base, path)).toThrow(pattern);
  };

  test("无效去向", () => {
    expectError(
      "rules:\n  - { name: X, source: 'https://example.com/x.srs', to: nowhere }\n",
      /规则 X 的去向 nowhere 无效/,
    );
  });

  test("重复规则名", () => {
    expectError(
      [
        "rules:",
        "  - { name: X, source: 'https://example.com/x.srs', to: proxy }",
        "  - { name: X, source: 'https://example.com/y.srs', to: proxy }",
      ].join("\n"),
      /规则名重复: X/,
    );
  });

  test("错误来源", () => {
    expectError("rules:\n  - { name: X, source: ./missing.yaml, to: proxy }\n", /规则 X 的来源不存在/);
  });

  test("无效 group default", () => {
    expectError(
      "groups:\n  g: { options: [proxy], default: direct }\nrules: []\n",
      /分组 g 的 default direct 不在 options 里/,
    );
  });

  test("分组名与 base 出站冲突", () => {
    expectError(
      "groups:\n  proxy: { options: [direct], default: direct }\nrules: []\n",
      /分组 proxy 与 base.yaml 已有出站同名/,
    );
  });
});

describe("路径解析相对 settings.yaml", () => {
  test("同名文件放在 settings 同目录即可解析，不依赖 cwd", () => {
    const { dir, path } = withSettings(
      "rules:\n  - { name: Local, source: ./local.yaml, to: proxy }\n",
    );
    writeFileSync(join(dir, "local.yaml"), "rules:\n  - domain_suffix: [example.com]\n");
    expect(() => loadSettings(base, path)).not.toThrow();
    rmSync(dir, { recursive: true, force: true });
  });
});
