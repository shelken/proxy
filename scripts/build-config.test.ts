#!/usr/bin/env bun
// 底模生成器的集成测试：走真实规范化输入（settings.ts）、assemble 与官方 merge。
// 默认基线的逐项归一化对比由 template.test.ts 与 just template-check 守。

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assemble, mergeTo, type Doc, type Role } from "./build-config.ts";
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
    Bun.YAML.parse(readFileSync(join(CONFIG, "platforms", `${role}.yaml`), "utf8")) as Doc,
  ]),
) as Record<Role, Doc>;
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
  await mergeTo(target, base, platforms[role], settings);
  return JSON.parse(readFileSync(target, "utf8"));
}
/** assemble 展开后的完整配置，取测试关心的三段。 */
const policy = (settings: Settings, role: Role = "mac") => {
  const d = assemble(settings, base, platforms[role]);
  return {
    dns: { rules: d.dns.rules as Array<Record<string, any>> },
    route: { rules: d.route.rules as Array<Record<string, any>>, rule_set: d.route.rule_set as Array<Record<string, any>> },
  };
};

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

describe("骨架与 settings 的关系", () => {
  const mutate = (fn: (doc: any) => void) => loadSettings(base, tempSettings(fn));
  const byName = (doc: any, name: string) => doc.rules.find((r: any) => r.name === name);
  const rejectSets = (p: ReturnType<typeof policy>) => p.route.rules.find((r) => r.action === "reject" && r.rule_set && !r.network)?.rule_set;
  const tail = (p: ReturnType<typeof policy>) => p.route.rules.filter((r) => r.action === "route" && r.rule_set).map((r) => r.rule_set[0]);

  test("新增 to: reject 的规则自动进入拦截，不再进入服务段", () => {
    const p = policy(mutate((d) => { d.rules.push({ name: "Tracking", source: localSource, to: "reject" }); }));
    expect(rejectSets(p)).toContain("Tracking");
    expect(tail(p)).not.toContain("Tracking");
  });

  test("拦截规则改去向：离开拦截，进入服务段", () => {
    const p = policy(mutate((d) => { byName(d, "MyReject").to = "proxy"; }));
    expect(rejectSets(p)).not.toContain("MyReject");
    expect(tail(p)).toContain("MyReject");
  });

  test("新增普通规则按书写顺序追加在服务段末尾", () => {
    const p = policy(mutate((d) => { d.rules.push({ name: "Last", source: localSource, to: "proxy" }); }));
    expect(tail(p).at(-1)).toBe("Last");
  });

  test("平台文件引用的规则被删除或改名：构建失败并点名", () => {
    for (const name of ["Lan", "MyProxy", "ChinaMax", "MyReject", "MyDirect", "cftunnel", "geoip-cn"]) {
      expect(() => policy(mutate((d) => { d.rules = d.rules.filter((r: any) => r.name !== name); }))).toThrow(
        new RegExp(`rule_set 里的 ${name}(-dns)? 既不是`),
      );
    }
  });

  test("DNS 骨架引用没有域名版的来源：构建失败", () => {
    expect(() => policy(mutate((d) => { byName(d, "Lan").source = "geoip:cn"; }))).toThrow(/Lan-dns/);
  });

  test("三个平台的骨架共享同一组顺序契约", async () => {
    for (const role of ["mac", "ios", "router"] as const) {
      const cfg = await merged(defaults, role);
      assertRejectBeforeClashMode(cfg.route.rules);
      assertMyDirectAndProxyBeforeServices(cfg.route.rules, cfg.outbounds);
      assertMyProxyQuicBeforeExempt(cfg.route.rules);
      assertMyProxyDnsBeforeChinaMax(cfg.dns.rules);
    }
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
    const settings = loadSettings(base, tempSettings((d) => { d.rules.push({ name: "小米追踪", source: localSource, to: "proxy" }); }));
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
      { name: "X", source: "https://e.com/x.srs", to: "direct" },
      { name: "X", source: "https://e.com/y.srs", to: "direct" },
    ] }, /规则名重复: X/);
    expectError({ rules: [{ name: "X", source: "./missing.yaml", to: "direct" }] }, /规则 X 的来源不存在/);
    expectError({ groups: { g: { options: ["proxy"], default: "direct" } }, rules: [] }, /分组 g 的 default direct 不在 options 里/);
    expectError({ groups: { direct: { options: ["proxy"], default: "proxy" } }, rules: [] }, /分组 direct 与 shared.yaml 已有出站同名/);
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
  test("追加本地 A B 后，三端仍通过语义门禁", async () => {
    const path = tempSettings((d) => {
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
      ...["Facebook", "Gemini", "Adult"].map((tag): [string, (doc: any) => void] => [
        `删除 ${tag}`, (doc) => { doc.rules = doc.rules.filter((rule: any) => rule.name !== tag); },
      ]),
      ["Facebook 改 hk", (doc) => { doc.rules.find((rule: any) => rule.name === "Facebook").to = "hk"; }],
      ["新增远程 .srs 进拦截", (doc) => { doc.rules.push({ name: "tracking", source: "https://example.com/tracking.srs", to: "reject" }); }],
      ["远程来源带查询参数", (doc) => { doc.rules.push({ name: "tracking", source: "http://example.com/tracking.srs?revision=1", to: "reject" }); }],
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
