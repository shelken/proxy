#!/usr/bin/env bun
// 底模生成器的集成测试：走真实规范化输入（settings.ts）、makePolicy 与官方 merge。
// 默认基线的逐项归一化对比由 template.test.ts 与 just template-check 守。

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { makePolicy, mergeTo, type Platform, type Role } from "./build-config.ts";
import { artifactName, loadBase, loadSettings, singBoxCommand, type Settings } from "./settings.ts";
import { buildOne } from "./rules-compile.ts";
import {
  assertAllRuleSetsDeclared,
  assertMyDirectAndProxyBeforeServices,
  assertMyProxyDnsBeforeChinaMax,
  assertMyProxyQuicBeforeExempt,
  assertRejectBeforeClashMode,
} from "../config/sing-box/tests/lib/contracts.ts";

const CONFIG = resolve(import.meta.dir, "../config/sing-box");
const FIXTURES = resolve(import.meta.dir, "fixtures");
const fixtureSettings = join(FIXTURES, "settings.yaml");
const base = loadBase();
const settingsFile = readFileSync(fixtureSettings, "utf8");
const platforms = Object.fromEntries(
  (["mac", "ios", "router"] as const).map((role) => [
    role,
    Bun.YAML.parse(readFileSync(join(CONFIG, "platforms", `${role}.yaml`), "utf8")) as Platform,
  ]),
) as Record<Role, Platform>;
const defaults = loadSettings(base, fixtureSettings);

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** 固定场景来自独立夹具，避免用户删规则后回归输入也消失。 */
function tempSettings(mutate: (doc: any) => void = () => {}): string {
  const doc = Bun.YAML.parse(settingsFile) as any;
  for (const rule of doc.rules) {
    if (rule.source.startsWith(".")) rule.source = resolve(FIXTURES, rule.source);
  }
  mutate(doc);
  const path = join(tempDir("settings-"), "settings.yaml");
  writeFileSync(path, JSON.stringify(doc, null, 2));
  return path;
}
const localSource = join(FIXTURES, "domains.yaml");
const ruleSet = (cfg: any, tag: string) => cfg.route.rule_set.find((rs: any) => rs.tag === tag);
const withRule = (cfg: any, tag: string) => cfg.route.rules.filter((r: any) => [r.rule_set].flat().includes(tag));

/** 走真实 merge 产出终态配置（mac/ios/router 任一）。 */
async function merged(settings: Settings, role: Role = "mac") {
  const target = join(tempDir("merged-"), "template.json");
  await mergeTo(target, base, platforms[role], settings, role);
  return JSON.parse(readFileSync(target, "utf8"));
}
const policy = (settings: Settings, role: Role = "mac") => makePolicy(settings, base, role);

/** 解析宿主 sing-box 可执行文件，供真实门禁子进程使用。 */
function hostSingBox(): string {
  if (process.env.SING_BOX && existsSync(process.env.SING_BOX)) return process.env.SING_BOX;
  const p = Bun.spawnSync(["mise", "which", "sing-box"], { cwd: resolve(import.meta.dir, "..") });
  return p.stdout.toString().trim();
}

describe("默认设置：生成结构", () => {
  test("outbounds = base 固定出站 + settings 分组 selector", async () => {
    const cfg = await merged(defaults);
    expect(cfg.outbounds.map((o: any) => o.tag)).toEqual([
      ...base.outbounds.map((o) => o.tag),
      ...Object.keys(defaults.groups),
    ]);
    for (const [name, group] of Object.entries(defaults.groups)) {
      expect(cfg.outbounds.find((o: any) => o.tag === name)?.default).toBe(group.default);
    }
  });

  test("声明唯一，每个设置规则都声明，非规则声明都是 -dns 伴生", () => {
    const tags = policy(defaults).route.rule_set.map((rs) => rs.tag);
    expect(new Set(tags).size).toBe(tags.length);
    const names = new Set(defaults.rules.map((r) => r.name));
    for (const rule of defaults.rules) expect(tags).toContain(rule.name);
    for (const tag of tags) if (!names.has(tag)) expect(names.has(tag.replace(/-dns$/, ""))).toBe(true);
  });

  test("语义守卫：拦截先于模式、自有清单先于服务、QUIC/DNS 顺序", async () => {
    const cfg = await merged(defaults);
    assertRejectBeforeClashMode(cfg.route.rules);
    assertMyDirectAndProxyBeforeServices(cfg.route.rules, cfg.outbounds);
    assertMyProxyQuicBeforeExempt(cfg.route.rules);
    assertMyProxyDnsBeforeChinaMax(cfg.dns.rules);
    assertAllRuleSetsDeclared(cfg.route);
  });
});

describe("默认直连链：resolve 排除", () => {
  const resolveSet = (settings: Settings) => {
    const rule = policy(settings).route.rules.find((r) => r.action === "resolve");
    return new Set(rule.rule_set ?? []);
  };

  test("默认包含直接直连、默认直连分组与 base 默认直连出站", () => {
    const set = resolveSet(defaults);
    for (const name of ["MyDirect", "ChinaMax", "Lan", "cftunnel", "geoip-cn"]) expect(set.has(name)).toBe(true);
    const microsoft = defaults.rules.find((r) => r.to === "microsoft")!.name;
    expect(set.has(microsoft)).toBe(true);
    expect(set.has("MyProxy")).toBe(false);
    expect(set.has("Gemini")).toBe(false);
  });

  test("分组默认链 app→lan→direct 解析为直连", () => {
    const path = tempSettings((d) => {
      d.groups = { ...d.groups, app: { options: ["lan"], default: "lan" }, lan: { options: ["direct"], default: "direct" } };
      d.rules.find((r: any) => r.name === "MyProxy").to = "app";
    });
    expect(resolveSet(loadSettings(base, path)).has("MyProxy")).toBe(true);
  });

  test("base 内默认 direct 的 selector（torrent）解析为直连", () => {
    const path = tempSettings((d) => {
      d.rules.push({ name: "Internal", source: localSource, to: "torrent" });
    });
    expect(resolveSet(loadSettings(base, path)).has("Internal")).toBe(true);
  });

  test("默认链成环在配置期报错", () => {
    const path = tempSettings((d) => {
      d.groups = { ...d.groups, a: { options: ["b"], default: "b" }, b: { options: ["a"], default: "a" } };
      d.rules.push({ name: "Loop", source: localSource, to: "a" });
    });
    expect(() => policy(loadSettings(base, path))).toThrow(/成环/);
  });
});

describe("规则自带 dns / quic 策略", () => {
  const mutate = (fn: (doc: any) => void) => loadSettings(base, tempSettings(fn));
  const byName = (doc: any, name: string) => doc.rules.find((r: any) => r.name === name);
  const udp = (p: ReturnType<typeof policy>) => p.route.rules.filter((r) => r.network === "udp");

  test("改名与改去向不影响策略：策略跟着规则走", () => {
    const p = policy(mutate((d) => {
      byName(d, "Lan").name = "LAN";
      byName(d, "MyProxy").to = "direct";
    }));
    expect(JSON.stringify(p.dns.rules)).toContain("LAN-dns");
    expect(JSON.stringify(p.dns.rules)).toContain("MyProxy-dns");
    expect(JSON.stringify(udp(p))).toContain("MyProxy");
    expect(JSON.stringify(udp(p))).toContain("LAN");
  });

  test("去掉 dns / quic 字段：对应规则与伴生声明消失", () => {
    const p = policy(mutate((d) => {
      delete byName(d, "MyReject").dns;
      delete byName(d, "ChinaMax").dns;
      delete byName(d, "ChinaMax").quic;
    }));
    expect(JSON.stringify(p.dns.rules)).not.toContain("MyReject-dns");
    expect(JSON.stringify(p.dns.rules)).not.toContain("ChinaMax-dns");
    expect(p.route.rule_set.map((r) => r.tag)).not.toContain("MyReject-dns");
    expect(JSON.stringify(udp(p))).not.toContain("ChinaMax");
  });

  test("同策略的规则合并为一条，不产生空 rule_set", () => {
    const p = policy(mutate((d) => {
      for (const name of ["ChinaMax", "Lan", "cftunnel", "geoip-cn"]) delete byName(d, name).quic;
      delete byName(d, "MyProxy").quic;
    }));
    expect(udp(p)).toHaveLength(1);
    for (const rule of [...p.route.rules, ...p.dns.rules]) {
      if (Array.isArray((rule as any).rule_set)) expect((rule as any).rule_set.length).toBeGreaterThan(0);
    }
    const lan = p.dns.rules.filter((r: any) => r.server === "dns-lan" && r.rule_set);
    expect(lan).toHaveLength(1);
    expect((lan[0] as any).rule_set).toEqual(["MyDirect-dns", "Lan-dns"]);
  });

  test("删除规则后无残留引用", async () => {
    const path = tempSettings((d) => {
      d.rules = d.rules.filter((r: any) => !["MyReject", "MyProxy", "ChinaMax"].includes(r.name));
    });
    const cfg = await merged(loadSettings(base, path));
    const text = JSON.stringify(cfg);
    for (const tag of ["MyReject-dns", "MyProxy-dns", "ChinaMax-dns", "MyReject", "MyProxy", "ChinaMax"]) {
      expect(text).not.toContain(`"${tag}`);
    }
    assertAllRuleSetsDeclared(cfg.route);
  });

  test("非法取值与无域名版来源报错", () => {
    expect(() => mutate((d) => { byName(d, "Lan").dns = "nope"; })).toThrow(/dns 无效/);
    expect(() => mutate((d) => { byName(d, "Lan").quic = "nope"; })).toThrow(/quic 无效/);
    expect(() => mutate((d) => { byName(d, "geoip-cn").dns = "lan"; })).toThrow(/dns 需要本地 YAML 或 geosite/);
    expect(() => mutate((d) => { byName(d, "Lan").to = "proxy"; })).toThrow(/quic: allow .*to: direct/);
  });
});

describe("名称与来源校验", () => {
  test("外部规则名以 -dns 结尾仍用用户 URL", () => {
    const path = tempSettings((d) => {
      d.rules.push({ name: "tracking-dns", source: "https://example.com/tracking.srs", to: "reject" });
    });
    const p = policy(loadSettings(base, path));
    expect(p.route.rule_set.find((r) => r.tag === "tracking-dns")?.url).toBe("https://example.com/tracking.srs");
    expect(p.route.rule_set.filter((r) => r.tag === "tracking-dns")).toHaveLength(1);
  });

  test("远程名撞已有伴生 tag 被拒绝；本地撞车也被拒绝", () => {
    const remote = tempSettings((d) => {
      d.rules.push({ name: "MyDirect-dns", source: "https://example.com/x.srs", to: "proxy" });
    });
    expect(() => loadSettings(base, remote)).toThrow(/tag 冲突: MyDirect-dns/);
    const local = tempSettings((d) => {
      d.rules.push({ name: "MyDirect-dns", source: localSource, to: "proxy" });
    });
    expect(() => loadSettings(base, local)).toThrow(/tag 冲突: MyDirect-dns/);
    const file = tempSettings((d) => {
      d.rules = [
        { name: "A B", source: localSource, to: "proxy" },
        { name: "A/B", source: localSource, to: "proxy" },
      ];
    });
    expect(() => loadSettings(base, file)).toThrow(/产物名冲突/);
  });

  test("中文名：模板 URL 与编译产物文件名同源", async () => {
    const dir = tempDir("settings-");
    writeFileSync(join(dir, "local.yaml"), "rules:\n  - domain_suffix: [example.com]\n");
    const path = join(dir, "settings.yaml");
    writeFileSync(path, JSON.stringify({ rules: [{ name: "小米追踪", source: "./local.yaml", to: "proxy" }] }));
    const settings = loadSettings(base, path);
    const p = policy(settings);
    expect(p.route.rule_set.find((r) => r.tag === "小米追踪")?.url.endsWith(`/${artifactName("小米追踪")}.srs`)).toBe(true);

    const outDir = tempDir("generated-");
    const built = buildOne(settings.byName.get("小米追踪")!, singBoxCommand(), outDir);
    const srs = built.find((b) => b.client === "singbox")!;
    expect(srs.path).toBe(join(outDir, "singbox", `${artifactName("小米追踪")}.json`));
    expect(existsSync(srs.path.replace(/\.json$/, ".srs"))).toBe(true);
  });

  test("来源格式在唯一入口校验，错误带条目名", () => {
    const bad = (source: string) => {
      const path = tempSettings((d) => { d.rules = [{ name: "X", source, to: "proxy" }]; });
      return () => loadSettings(base, path);
    };
    expect(bad("geosite:bad/name")).toThrow(/规则 X/);
    expect(bad("geoip:bad/name")).toThrow(/规则 X/);
    expect(bad("https://example.com/rules.txt")).toThrow(/规则 X/);
    expect(bad("https://example.com/rules.json")).toThrow(/规则 X/);
    const ok = tempSettings((d) => { d.rules = [{ name: "X", source: "https://example.com/x.srs?foo=1", to: "proxy" }]; });
    expect(loadSettings(base, ok).byName.get("X")!.kind).toBe("url");
  });

  test("无效去向/重复名/错误来源/无效 group default/分组与出站同名", () => {
    const expectError = (yaml: object, pattern: RegExp) => {
      const path = join(tempDir("settings-"), "settings.yaml");
      writeFileSync(path, JSON.stringify(yaml));
      expect(() => loadSettings(base, path)).toThrow(pattern);
    };
    expectError({ rules: [{ name: "X", source: "https://e.com/x.srs", to: "nowhere" }] }, /规则 X 的去向 nowhere 无效/);
    expectError({ rules: [
      { name: "X", source: "https://e.com/x.srs", to: "proxy" },
      { name: "X", source: "https://e.com/y.srs", to: "proxy" },
    ] }, /规则名重复: X/);
    expectError({ rules: [{ name: "X", source: "./missing.yaml", to: "proxy" }] }, /规则 X 的来源不存在/);
    expectError({ groups: { g: { options: ["proxy"], default: "direct" } }, rules: [] }, /分组 g 的 default direct 不在 options 里/);
    expectError({ groups: { proxy: { options: ["direct"], default: "direct" } }, rules: [] }, /分组 proxy 与 base.yaml 已有出站同名/);
  });
});

describe("新增远程 .srs（小米）：三端一致", () => {
  const url = "https://cdn.jsdelivr.net/gh/razaxq/dns-blocklists-sing-box@rule-set/hagezi-tracker-xiaomi.srs";
  for (const role of ["mac", "ios", "router"] as const) {
    test(`${role}：有且仅有一次正确 URL，进入拦截段`, async () => {
      const path = tempSettings((d) => { d.rules.push({ name: "小米追踪", source: url, to: "reject" }); });
      const cfg = await merged(loadSettings(base, path), role);
      expect(JSON.stringify(cfg).split(url).length - 1).toBe(1);
      expect(ruleSet(cfg, "小米追踪").url).toBe(url);
      expect(withRule(cfg, "小米追踪").some((r) => r.action === "reject")).toBe(true);
    });
  }
});

describe("官方 merge 契约", () => {
  test("标量取路径更早的文件", () => {
    const dir = tempDir("merge-");
    writeFileSync(join(dir, "00-a.json"), JSON.stringify({ log: { level: "warn" }, route: { final: "direct" } }));
    writeFileSync(join(dir, "01-b.json"), JSON.stringify({ log: { level: "error" }, route: { final: "proxy" } }));
    const out = join(dir, "out.json");
    const proc = Bun.spawnSync([...singBoxCommand(), "merge", out, "-C", dir], { stdio: ["ignore", "ignore", "inherit"] });
    expect(proc.exitCode).toBe(0);
    const mergedDoc = JSON.parse(readFileSync(out, "utf8"));
    expect(mergedDoc.log.level).toBe("warn");
    expect(mergedDoc.route.final).toBe("direct");
  });
});

describe("改真实 settings → 重建三端 → 完整门禁", () => {
  test("删除 MyReject 并追加本地 A B 后，三端仍通过语义门禁", async () => {
    const path = tempSettings((d) => {
      d.rules = d.rules.filter((r: any) => r.name !== "MyReject");
      d.rules.push({ name: "A B", source: localSource, to: "proxy" });
    });
    const settings = loadSettings(base, path);
    for (const role of ["mac", "ios", "router"] as const) {
      const cfg = await merged(settings, role);
      assertAllRuleSetsDeclared(cfg.route);
      assertRejectBeforeClashMode(cfg.route.rules);
      assertMyDirectAndProxyBeforeServices(cfg.route.rules, cfg.outbounds);
      assertMyProxyQuicBeforeExempt(cfg.route.rules);
      assertMyProxyDnsBeforeChinaMax(cfg.dns.rules);
      expect(cfg.route.rule_set.map((r: any) => r.tag)).toContain("A B");
      expect(cfg.route.rule_set.find((r: any) => r.tag === "A B").url.endsWith("/A_B.srs")).toBe(true);
    }
  });

  test("真实 CLI 重建 + 完整三平台门禁（增删改不依赖 YAML 排版）", () => {
    const sb = hostSingBox();
    if (!sb) {
      console.warn("SKIP: 宿主找不到 sing-box，无法跑真实门禁");
      return;
    }
    const repo = resolve(import.meta.dir, "..");
    const root = tempDir("gate-");
    mkdirSync(join(root, "config"), { recursive: true });
    mkdirSync(join(root, "scripts"), { recursive: true });
    for (const rel of ["config/sing-box", "config/rules"]) {
      const r = Bun.spawnSync(["cp", "-R", join(repo, rel), join(root, rel)]);
      if (r.exitCode !== 0) throw new Error(`复制 ${rel} 失败`);
    }
    for (const file of ["settings.ts", "build-config.ts"]) {
      const r = Bun.spawnSync(["cp", join(repo, "scripts", file), join(root, "scripts", file)]);
      if (r.exitCode !== 0) throw new Error(`复制 ${file} 失败`);
    }
    const env = { ...process.env, SING_BOX: sb };
    const settingsPath = join(root, "config/sing-box/settings.yaml");
    const original = Bun.YAML.parse(settingsFile) as any;
    for (const rule of original.rules) {
      if (rule.source.startsWith(".")) rule.source = resolve(FIXTURES, rule.source);
    }
    const cases: Array<[string, (doc: any) => void]> = [
      ...["MyReject", "MyDirect", "MyProxy", "Lan", "ChinaMax"].map((tag): [string, (doc: any) => void] => [
        `删除 ${tag}`, (doc) => { doc.rules = doc.rules.filter((rule: any) => rule.name !== tag); },
      ]),
      ["MyReject 改 proxy", (doc) => { doc.rules.find((rule: any) => rule.name === "MyReject").to = "proxy"; }],
      ["Lan 改 proxy", (doc) => { const r = doc.rules.find((rule: any) => rule.name === "Lan"); r.to = "proxy"; delete r.quic; }],
      ["Facebook 改 hk", (doc) => { doc.rules.find((rule: any) => rule.name === "Facebook").to = "hk"; }],
      // 无域名版的来源不能带 dns 策略，换来源时一并去掉
      ["MyReject 改远程", (doc) => { const r = doc.rules.find((rule: any) => rule.name === "MyReject"); r.source = "https://example.com/tracking.srs"; delete r.dns; }],
      ["Lan 改远程", (doc) => { const r = doc.rules.find((rule: any) => rule.name === "Lan"); r.source = "https://example.com/tracking.srs"; delete r.dns; }],
      ...["Lan", "MyDirect", "MyReject"].map((tag): [string, (doc: any) => void] => [
        `${tag} 改 IP 清单`, (doc) => { const r = doc.rules.find((rule: any) => rule.name === tag); r.source = "geoip:cn"; delete r.dns; },
      ]),
      ["远程来源带查询参数", (doc) => { const r = doc.rules.find((rule: any) => rule.name === "MyReject"); r.source = "http://example.com/tracking.srs?revision=1"; delete r.dns; }],
      ["追加本地 A B", (doc) => { doc.rules.push({ name: "A B", source: localSource, to: "reject" }); }],
      ["追加中文名", (doc) => { doc.rules.push({ name: "小米追踪", source: localSource, to: "proxy" }); }],
    ];
    for (const [name, mutate] of cases) {
      const doc = structuredClone(original);
      mutate(doc);
      expect(doc, `${name} 必须实际改变设置`).not.toEqual(original);
      writeFileSync(settingsPath, Bun.YAML.stringify(doc));
      const build = Bun.spawnSync([process.execPath, "run", "scripts/build-config.ts"], { cwd: root, env });
      expect(build.exitCode, `${name} build:\n${build.stdout}${build.stderr}`).toBe(0);
      const gate = Bun.spawnSync([
        process.execPath, "test",
        "config/sing-box/tests/template.test.ts",
        "config/sing-box/tests/ios-template.test.ts",
        "config/sing-box/tests/router-template.test.ts",
      ], { cwd: root, env });
      expect(gate.exitCode, `${name} gate:\n${gate.stdout}${gate.stderr}`).toBe(0);
    }
  }, 60000);
});

describe("变异验证：真实语义契约必须拒绝坏产物", () => {
  test("把拦截规则移到 clash_mode 之后 → assertRejectBeforeClashMode 必须失败", async () => {
    const p = policy(defaults);
    const rules = [...p.route.rules];
    const at = rules.findIndex((r) => r.action === "reject");
    const [reject] = rules.splice(at, 1);
    rules.splice(rules.findIndex((r) => r.clash_mode === "global") + 1, 0, reject);
    expect(() => assertRejectBeforeClashMode(rules)).toThrow();
  });
});
