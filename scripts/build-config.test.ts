#!/usr/bin/env bun
// 底模生成器的集成测试：走真实规范化输入（settings.ts）与装配（build-config.ts），
// 不复制实现；产物与 dc8c8f5 的逐字节对比由 just template-check / CI 守。

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildConfig } from "./build-config.ts";
import { artifactName, loadBase, loadSettings, singBoxCommand, type Base, type Rule } from "./settings.ts";
import { buildOne } from "./rules-compile.ts";
import { assertAllRuleSetsDeclared, assertRejectBeforeClashMode } from "../config/sing-box/tests/lib/contracts.ts";

const CONFIG = resolve(import.meta.dir, "../config/sing-box");
const base = loadBase();
const settingsFile = readFileSync(join(CONFIG, "settings.yaml"), "utf8");
const platforms = Object.fromEntries(
  (["mac", "ios", "router"] as const).map((role) => [
    role,
    Bun.YAML.parse(readFileSync(join(CONFIG, "platforms", `${role}.yaml`), "utf8")) as any,
  ]),
);
const defaults = loadSettings(base);

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** 以真实默认设置为基础改一份临时 settings.yaml；本地来源改写为绝对路径。 */
function tempSettings(mutate: (doc: any) => void = () => {}): string {
  const doc = Bun.YAML.parse(settingsFile) as any;
  for (const rule of doc.rules) {
    if (rule.source.startsWith("..")) rule.source = resolve(CONFIG, rule.source);
  }
  mutate(doc);
  const path = join(tempDir("settings-"), "settings.yaml");
  writeFileSync(path, JSON.stringify(doc, null, 2));
  return path;
}
const ruleSet = (cfg: any, tag: string) => cfg.route.rule_set.find((rs: any) => rs.tag === tag);
const ruleSetNames = (cfg: any) => cfg.route.rule_set.map((rs: any) => rs.tag);
const withRule = (cfg: any, tag: string) => cfg.route.rules.filter((r: any) => [r.rule_set].flat().includes(tag));

describe("默认设置：生成结构", () => {
  const cfg = buildConfig(base, platforms.mac, defaults);

  test("log 与 DNS 伴生声明顺序来自 base，其余声明按 settings", () => {
    expect(cfg.log).toEqual({ level: "info" });
    expect(ruleSetNames(cfg)).toEqual([
      ...base.dns_companions.map((n) => `${n}-dns`),
      ...defaults.rules.map((r) => r.name),
    ]);
  });

  test("拦截合并成一条，排在 QUIC 守卫与 clash_mode 之前", () => {
    const reject = withRule(cfg, "Advertising").find((r: any) => r.action === "reject");
    expect(reject.rule_set).toEqual(["Advertising", "Hijacking", "MyReject", "Privacy"]);
    expect(cfg.route.rules.indexOf(reject)).toBeLessThan(
      cfg.route.rules.findIndex((r: any) => r.clash_mode !== undefined),
    );
  });

  test("rest 段按 settings 顺序，相邻同去向合并；download 在 torrent 与 resolve 之间", () => {
    const direct = withRule(cfg, "ChinaMax").find((r: any) => r.outbound === "direct");
    expect(direct.rule_set).toEqual(["ChinaMax", "Lan", "cftunnel", "geoip-cn"]);
    const proxy = withRule(cfg, "YouTube").find((r: any) => r.outbound === "proxy");
    expect(proxy.rule_set).toEqual(["Facebook", "Instagram", "Spotify", "Telegram", "TikTok", "Twitter", "YouTube"]);
    const index = (pred: (r: any) => boolean) => cfg.route.rules.findIndex(pred);
    expect(index((r) => r.protocol === "bittorrent")).toBeLessThan(index((r) => r.outbound === "download"));
    expect(index((r) => r.outbound === "download")).toBeLessThan(index((r) => r.action === "resolve"));
  });

  test("resolve 排除清单 = base 固定部分 + 默认直连分组，顺序不变", () => {
    const resolveRule = cfg.route.rules.find((r: any) => r.action === "resolve");
    const microsoft = defaults.rules.find((r) => r.to === "microsoft")!.name;
    expect(resolveRule.rule_set).toEqual([
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
    expect(cfg.outbounds.map((o: any) => o.tag)).toEqual([
      ...base.outbounds.map((o) => o.tag),
      ...Object.keys(defaults.groups),
    ]);
    for (const [name, group] of Object.entries(defaults.groups)) {
      const selector = cfg.outbounds.find((o: any) => o.tag === name);
      expect(selector?.outbounds).toEqual(group.options);
      expect(selector?.default).toBe(group.default);
      expect(selector?.interrupt_exist_connections).toBe(true);
    }
  });
});

describe("改去向：关联随设置撤销", () => {
  const build = (mutate: (doc: any) => void) => buildConfig(base, platforms.mac, loadSettings(base, tempSettings(mutate)));
  const byName = (doc: any, name: string) => doc.rules.find((r: any) => r.name === name);

  test("MyReject 由 reject 改 proxy：DNS reject 与伴生声明消失", () => {
    const cfg = build((d) => { byName(d, "MyReject").to = "proxy"; });
    expect(JSON.stringify(cfg.dns.rules)).not.toContain("MyReject-dns");
    expect(ruleSetNames(cfg)).not.toContain("MyReject-dns");
  });

  test("ChinaMax 由 direct 改 proxy：QUIC 直连豁免与 DNS 直连解析消失", () => {
    const cfg = build((d) => { byName(d, "ChinaMax").to = "proxy"; });
    const quic = cfg.route.rules.filter((r: any) => r.network === "udp" && r.rule_set);
    expect(JSON.stringify(quic)).not.toContain("ChinaMax");
    expect(JSON.stringify(cfg.dns.rules)).not.toContain("ChinaMax-dns");
  });

  test("MyProxy 由 proxy 改 direct：QUIC 拒绝与 fakeip 解析消失", () => {
    const cfg = build((d) => { byName(d, "MyProxy").to = "direct"; });
    expect(JSON.stringify(cfg.route.rules.filter((r: any) => r.network === "udp"))).not.toContain("MyProxy");
    expect(JSON.stringify(cfg.dns.rules)).not.toContain("MyProxy-dns");
  });

  test("改去向不留空的 rule_set 全匹配", () => {
    const cfg = build((d) => {
      for (const name of ["ChinaMax", "Lan", "cftunnel", "geoip-cn"]) byName(d, name).to = "proxy";
    });
    for (const rule of cfg.route.rules) {
      if (Array.isArray(rule.rule_set)) expect(rule.rule_set.length).toBeGreaterThan(0);
    }
    for (const rule of cfg.dns.rules) {
      if (Array.isArray(rule.rule_set)) expect(rule.rule_set.length).toBeGreaterThan(0);
    }
  });
});

describe("删除：只改 settings 即可生效", () => {
  test("删除 MyReject/MyProxy/ChinaMax 后无残留引用且声明完整", () => {
    const path = tempSettings((d) => {
      d.rules = d.rules.filter((r: any) => !["MyReject", "MyProxy", "ChinaMax"].includes(r.name));
    });
    const cfg = buildConfig(base, platforms.mac, loadSettings(base, path));
    const text = JSON.stringify(cfg);
    for (const tag of ["MyReject-dns", "MyProxy-dns", "ChinaMax-dns", "MyReject", "MyProxy", "ChinaMax"]) {
      expect(text).not.toContain(`"${tag}`);
    }
    expect(() => assertAllRuleSetsDeclared(cfg.route)).not.toThrow();
  });
});

describe("名称与 URL", () => {
  test("外部规则名以 -dns 结尾仍使用用户 URL", () => {
    const path = tempSettings((d) => {
      d.rules.push({ name: "tracking-dns", source: "https://example.com/tracking.srs", to: "reject" });
    });
    const cfg = buildConfig(base, platforms.mac, loadSettings(base, path));
    expect(ruleSet(cfg, "tracking-dns").url).toBe("https://example.com/tracking.srs");
  });

  test("中文名：模板 URL 与编译产物文件名一致（同一命名映射）", () => {
    const dir = tempDir("settings-");
    writeFileSync(join(dir, "local.yaml"), "rules:\n  - domain_suffix: [example.com]\n");
    const path = join(dir, "settings.yaml");
    writeFileSync(path, JSON.stringify({ rules: [{ name: "小米追踪", source: "./local.yaml", to: "proxy" }] }));
    const settings = loadSettings(base, path);
    const rule = settings.byName.get("小米追踪")!;
    const cfg = buildConfig(base, platforms.mac, settings);
    expect(ruleSet(cfg, "小米追踪").url).toBe(
      base.rule_set_url.replace("{artifact}", artifactName("小米追踪")),
    );

    expect(ruleSet(cfg, "小米追踪").url.endsWith(`/${artifactName("小米追踪")}.srs`)).toBe(true);

    const outDir = tempDir("generated-");
    const built = buildOne(rule, singBoxCommand(), outDir);
    const srs = built.find((b) => b.client === "singbox")!;
    expect(srs.path).toBe(join(outDir, "singbox", `${artifactName("小米追踪")}.json`));
    expect(existsSync(srs.path.replace(/\.json$/, ".srs"))).toBe(true);
  });

  test("产物名碰撞被拒绝（含 -dns 命名空间）", () => {
    const local = resolve(CONFIG, "../rules/custom/Lan.yaml");
    const path = tempSettings((d) => {
      d.rules = ["A B", "A/B"].map((name) => ({ name, source: local, to: "proxy" }));
    });
    expect(() => loadSettings(base, path)).toThrow(/产物名冲突/);
  });

  test("规则名与既有 -dns 伴生撞车被拒绝", () => {
    const path = tempSettings((d) => {
      d.rules.push({ name: "MyDirect-dns", source: resolve(CONFIG, "../rules/custom/Lan.yaml"), to: "proxy" });
    });
    expect(() => loadSettings(base, path)).toThrow(/tag 冲突: MyDirect-dns/);
  });

  test("远程规则名撞已有伴生 tag 被拒绝（tag 命名空间含所有来源）", () => {
    const path = tempSettings((d) => {
      d.rules.push({ name: "MyDirect-dns", source: "https://example.com/x.srs", to: "proxy" });
    });
    expect(() => loadSettings(base, path)).toThrow(/MyDirect-dns/);
  });

  test("独立的 tracking-dns 远程名允许，且模板只声明一次", () => {
    const path = tempSettings((d) => {
      d.rules.push({ name: "tracking-dns", source: "https://example.com/tracking.srs", to: "reject" });
    });
    const cfg = buildConfig(base, platforms.mac, loadSettings(base, path));
    expect(ruleSetNames(cfg).filter((n) => n === "tracking-dns")).toHaveLength(1);
    expect(ruleSet(cfg, "tracking-dns").url).toBe("https://example.com/tracking.srs");
  });

  test("来源格式在唯一入口校验，错误定位到条目", () => {
    const bad = (source: string) => {
      const path = tempSettings((d) => { d.rules = [{ name: "X", source, to: "proxy" }]; });
      return () => loadSettings(base, path);
    };
    expect(bad("geosite:bad/name")).toThrow(/规则 X/);
    expect(bad("geoip:bad/name")).toThrow(/规则 X/);
    expect(bad("https://example.com/rules.txt")).toThrow(/规则 X/);
    expect(bad("https://example.com/rules.json")).toThrow(/规则 X/);
    const ok = tempSettings((d) => {
      d.rules = [{ name: "X", source: "https://example.com/x.srs?foo=1", to: "proxy" }];
    });
    expect(loadSettings(base, ok).byName.get("X")!.kind).toBe("url");
  });
});

describe("新增远程 .srs（小米）：三端一致", () => {
  for (const role of ["mac", "ios", "router"] as const) {
    test(`${role}：有且仅有一次正确 URL，进入拦截段`, () => {
      const url = "https://cdn.jsdelivr.net/gh/razaxq/dns-blocklists-sing-box@rule-set/hagezi-tracker-xiaomi.srs";
      const path = tempSettings((d) => {
        d.rules.push({ name: "小米追踪", source: url, to: "reject" });
      });
      const cfg = buildConfig(base, platforms[role], loadSettings(base, path));
      expect(JSON.stringify(cfg).split(url).length - 1).toBe(1);
      expect(ruleSet(cfg, "小米追踪").url).toBe(url);
      expect(withRule(cfg, "小米追踪").some((r: any) => r.action === "reject")).toBe(true);
    });
  }

  test("不改动默认设置", () => {
    expect(loadSettings(base).rules.some((r) => r.name === "小米追踪")).toBe(false);
  });
});

describe("settings 校验报错定位到条目", () => {
  const expectError = (yaml: object, pattern: RegExp) => {
    const path = join(tempDir("settings-"), "settings.yaml");
    writeFileSync(path, JSON.stringify(yaml));
    expect(() => loadSettings(base, path)).toThrow(pattern);
  };

  test("无效去向 / 重复名 / 错误来源 / 无效 group default / 分组与出站同名", () => {
    expectError({ rules: [{ name: "X", source: "https://e.com/x.srs", to: "nowhere" }] }, /规则 X 的去向 nowhere 无效/);
    expectError(
      { rules: [
        { name: "X", source: "https://e.com/x.srs", to: "proxy" },
        { name: "X", source: "https://e.com/y.srs", to: "proxy" },
      ] },
      /规则名重复: X/,
    );
    expectError({ rules: [{ name: "X", source: "./missing.yaml", to: "proxy" }] }, /规则 X 的来源不存在/);
    expectError({ groups: { g: { options: ["proxy"], default: "direct" } }, rules: [] }, /分组 g 的 default direct 不在 options 里/);
    expectError({ groups: { proxy: { options: ["direct"], default: "direct" } }, rules: [] }, /分组 proxy 与 base.yaml 已有出站同名/);
  });
});

describe("变异验证：真实语义契约必须拒绝坏产物", () => {
  test("把 reject 段移到 clash_mode 之后 → assertRejectBeforeClashMode 必须失败", () => {
    const rules = structuredClone(base.route.rules);
    const slot = rules.splice(rules.findIndex((r: any) => r.slot === "reject"), 1)[0];
    rules.splice(rules.findIndex((r: any) => r.clash_mode === "global") + 1, 0, slot);
    const cfg = buildConfig({ ...base, route: { ...base.route, rules } } as Base, platforms.mac, defaults);
    expect(() => assertRejectBeforeClashMode(cfg.route.rules)).toThrow();
  });
});
