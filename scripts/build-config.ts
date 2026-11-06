#!/usr/bin/env bun
// sing-box 底模装配：settings.yaml + base.yaml + platforms/ → 三份平台模板。
//
// 日常维护只改 settings.yaml（规则与分组）；base.yaml 是稳定机制与固定优先级，
// platforms/<角色>.yaml 是平台差异。本脚本把三者拼成一份原生配置，交给官方
// `sing-box merge` 归一化输出（字段顺序由内核决定，避免手写序列化漂移）。
//
// 用法:
//   bun scripts/build-config.ts            # 生成三份产物
//   bun scripts/build-config.ts --check    # 只与磁盘产物逐字节比对，不同则退出码 1

import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ROOT = join(import.meta.dir, "..");
const CONFIG = join(ROOT, "config/sing-box");

// 角色 → 产物文件，与 justfile/CI 现有路径一致。
const OUTPUTS: Record<string, string> = {
  mac: "template.json",
  ios: "template-ios.json",
  router: "template-router.json",
};

// SING_BOX 可能是多词命令（默认 mise exec -- sing-box），按词展开
const SING_BOX = (process.env.SING_BOX ?? "mise exec -- sing-box").split(/\s+/);

// 固定提取段：这些去向的规则不按 settings 顺序排，而由 base.yaml 的 slot 决定位置。
const SLOT_DESTINATIONS = ["reject", "download"];

type Group = { options: string[]; default: string };
type Rule = { name: string; source: string; to: string };
export type Settings = { groups: Record<string, Group>; rules: Rule[] };
export type Base = {
  rule_set_url: string;
  dns_rule_sets: string[];
  resolve_exclude: string[];
  log?: Record<string, any>;
  dns: Record<string, any>;
  http_clients: unknown[];
  experimental: Record<string, any>;
  outbounds: Array<{ tag: string } & Record<string, any>>;
  route: { rules: Array<Record<string, any>>; [k: string]: any };
};
export type Platform = {
  inbounds: unknown[];
  endpoints?: unknown[];
  experimental?: Record<string, any>;
  dns?: { servers_prepend?: unknown[]; rules_prepend?: unknown[] };
  route?: { rules_head?: unknown[]; rules_hijack?: unknown[] };
};

const readYaml = async (path: string) => Bun.YAML.parse(await Bun.file(path).text());

export function loadSettings(base: Base, path = join(CONFIG, "settings.yaml")): Settings {
  const raw = readFileSync(path, "utf8");
  const parsed = Bun.YAML.parse(raw) as any;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("settings.yaml: 顶层必须是 groups 与 rules 映射");
  }

  const groups: Record<string, Group> = {};
  for (const [name, value] of Object.entries(parsed.groups ?? {})) {
    const g = value as any;
    if (!g || typeof g !== "object" || !Array.isArray(g.options) || typeof g.default !== "string") {
      throw new Error(`settings.yaml: 分组 ${name} 需要 options 数组与 default 字符串`);
    }
    if (!g.options.every((o: unknown) => typeof o === "string" && o.length > 0)) {
      throw new Error(`settings.yaml: 分组 ${name} 的 options 只能是非空字符串`);
    }
    if (!g.options.includes(g.default)) {
      throw new Error(`settings.yaml: 分组 ${name} 的 default ${g.default} 不在 options 里`);
    }
    groups[name] = { options: g.options, default: g.default };
  }

  for (const name of Object.keys(groups)) {
    if (base.outbounds.some((o) => o.tag === name)) {
      throw new Error(`settings.yaml: 分组 ${name} 与 base.yaml 已有出站同名`);
    }
  }

  const destinations = new Set(["reject", ...base.outbounds.map((o) => o.tag), ...Object.keys(groups)]);
  const seen = new Set<string>();
  const rules: Rule[] = [];
  for (const [i, value] of (parsed.rules ?? []).entries()) {
    const r = value as any;
    const at = r?.name ? `规则 ${r.name}` : `第 ${i + 1} 条规则`;
    if (!r || typeof r !== "object" || typeof r.name !== "string" || !r.name) {
      throw new Error(`settings.yaml: ${at} 缺少 name`);
    }
    if (seen.has(r.name)) throw new Error(`settings.yaml: 规则名重复: ${r.name}`);
    seen.add(r.name);
    if (typeof r.source !== "string" || !r.source) throw new Error(`settings.yaml: ${at} 缺少 source`);
    if (typeof r.to !== "string" || !r.to) throw new Error(`settings.yaml: ${at} 缺少 to`);
    if (!destinations.has(r.to)) {
      throw new Error(`settings.yaml: ${at} 的去向 ${r.to} 无效（可用: ${[...destinations].join(", ")}）`);
    }
    if (!isExternal(r.source) && !isGeo(r.source) && !existsSync(resolve(dirname(path), r.source))) {
      throw new Error(`settings.yaml: ${at} 的来源不存在: ${r.source}`);
    }
    rules.push({ name: r.name, source: r.source, to: r.to });
  }
  return { groups, rules };
}

const isExternal = (source: string) => /^https?:\/\//.test(source);
const isGeo = (source: string) => /^(geosite|geoip):[a-z0-9_-]+$/.test(source);

/** 规则集声明：外部 .srs 直接用上游 URL，其余从本仓库发布分支取同名 .srs。 */
function ruleSetBlock(tag: string, url: string) {
  return { type: "remote", tag, format: "binary", url, update_interval: "1d" };
}

function urlFor(tag: string, source: string, template: string): string {
  return isExternal(source) && !tag.endsWith("-dns") ? source : template.replace("{tag}", tag);
}

/** 拦截与下载固定段：把同去向的规则合成一条 rule_set 列表；没有规则时返回 null（不产出空匹配）。 */
function combine(names: string[], to: string) {
  if (names.length === 0) return null;
  return to === "reject"
    ? { rule_set: names, action: "reject" }
    : { rule_set: names, action: "route", outbound: to };
}

/** rest 段：尊重 settings 顺序，相邻同去向合并成一条。 */
function restRules(rules: Rule[]) {
  const groups: Array<{ to: string; names: string[] }> = [];
  for (const r of rules) {
    if (SLOT_DESTINATIONS.includes(r.to)) continue;
    const last = groups[groups.length - 1];
    if (last && last.to === r.to) last.names.push(r.name);
    else groups.push({ to: r.to, names: [r.name] });
  }
  return groups.map((g) => combine(g.names, g.to)!);
}

/**
 * resolve 排除清单：base.yaml 的固定部分 + settings 里默认直连的规则与分组。
 * 只保留仍指向 direct 的清单，改去向/删条目不会留下残留解析排除。
 */
function resolveExclude(base: Base, settings: Settings) {
  const declared = new Set(settings.rules.map((r) => r.name));
  const direct = settings.rules
    .filter((r) => r.to === "direct" || settings.groups[r.to]?.default === "direct")
    .map((r) => r.name);
  const directSet = new Set(direct);
  const out: string[] = [];
  for (const tag of [...base.resolve_exclude.filter((t) => directSet.has(t)), ...direct]) {
    if (declared.has(tag) && !out.includes(tag)) out.push(tag);
  }
  return out;
}

function buildRouteRules(base: Base, platform: Platform, settings: Settings) {
  const rules: Array<Record<string, any>> = [];
  const reject = combine(settings.rules.filter((r) => r.to === "reject").map((r) => r.name), "reject");
  const download = combine(settings.rules.filter((r) => r.to === "download").map((r) => r.name), "download");
  const resolve = resolveExclude(base, settings);

  for (const entry of base.route.rules) {
    if (entry.platform === "head") rules.push(...(platform.route?.rules_head ?? []));
    else if (entry.platform === "hijack") rules.push(...(platform.route?.rules_hijack ?? []));
    else if (entry.slot === "reject") { if (reject) rules.push(reject); }
    else if (entry.slot === "download") { if (download) rules.push(download); }
    else if (entry.slot === "resolve") {
      // 无默认直连清单时留空表示全部按代理解析：带空 rule_set 的 invert 规则不是这个意思
      const rule: Record<string, any> = { action: "resolve", server: "dns-proxy", strategy: "ipv4_only" };
      if (resolve.length > 0) {
        rule.rule_set = resolve;
        rule.invert = true;
      }
      rules.push(rule);
    } else if (entry.slot === "rest") rules.push(...restRules(settings.rules));
    else rules.push(entry);
  }
  return rules;
}

/** base.yaml 里引用的清单名必须是 settings 声明过的规则或它的 -dns 伴生。 */
export function validateBaseRefs(base: Base, settings: Settings) {
  const declared = new Set(settings.rules.map((r) => r.name));
  const dnsCompanions = new Set(base.dns_rule_sets);
  const errors: string[] = [];
  const check = (tag: string, where: string) => {
    const isDns = tag.endsWith("-dns");
    const base_ = isDns ? tag.slice(0, -"-dns".length) : tag;
    if (!declared.has(base_)) errors.push(`${where} 引用了 settings 未声明的清单 ${tag}`);
    if (isDns && !dnsCompanions.has(tag)) errors.push(`${where} 引用了未登记的 DNS 伴生 ${tag}`);
  };
  for (const entry of base.route.rules) {
    if (entry.slot || entry.platform) continue;
    for (const tag of entry.rule_set ?? []) check(String(tag), `base.yaml route.rules`);
  }
  for (const tag of base.resolve_exclude) check(tag, "base.yaml resolve_exclude");
  for (const tag of base.dns_rule_sets) check(tag, "base.yaml dns_rule_sets");
  for (const rule of base.dns.rules ?? []) {
    for (const tag of rule.rule_set ?? []) check(String(tag), "base.yaml dns.rules");
  }
  return errors;
}

export function buildConfig(base: Base, platform: Platform, settings: Settings) {
  const groups = Object.entries(settings.groups).map(([tag, g]) => ({
    type: "selector",
    tag,
    outbounds: g.options,
    default: g.default,
    interrupt_exist_connections: true,
  }));
  const config: Record<string, any> = {
    log: base.log,
    dns: {
      servers: [...(platform.dns?.servers_prepend ?? []), ...base.dns.servers],
      rules: [...(platform.dns?.rules_prepend ?? []), ...base.dns.rules],
      final: base.dns.final,
      strategy: base.dns.strategy,
      optimistic: base.dns.optimistic,
    },
    http_clients: base.http_clients,
    inbounds: platform.inbounds,
    outbounds: [...base.outbounds, ...groups],
    route: {
      rules: buildRouteRules(base, platform, settings),
      rule_set: [
        ...base.dns_rule_sets.map((tag) => ruleSetBlock(tag, urlFor(tag, "", base.rule_set_url))),
        ...settings.rules.map((r) => ruleSetBlock(r.name, urlFor(r.name, r.source, base.rule_set_url))),
      ],
      final: base.route.final,
      auto_detect_interface: base.route.auto_detect_interface,
      default_domain_resolver: base.route.default_domain_resolver,
      default_http_client: base.route.default_http_client,
    },
    experimental: platform.experimental ?? base.experimental,
  };
  if (platform.endpoints) config.endpoints = platform.endpoints;
  return config;
}

function firstDiff(a: Uint8Array, b: Uint8Array): string | null {
  if (a.length === b.length && a.every((v, i) => v === b[i])) return null;
  let i = 0;
  while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
  const ctx = (buf: Uint8Array) =>
    JSON.stringify(new TextDecoder().decode(buf.subarray(Math.max(0, i - 30), i + 30)));
  return `字节 ${i}: 磁盘 ${ctx(b)} != 重算 ${ctx(a)}`;
}

if (import.meta.main) {
  const base = (await readYaml(join(CONFIG, "base.yaml"))) as Base;
  const settings = loadSettings(base);
  const refErrors = validateBaseRefs(base, settings);
  if (refErrors.length > 0) {
    for (const err of refErrors) console.error(`ERROR: ${err}`);
    process.exit(1);
  }

  const check = Bun.argv.includes("--check");
  let failed = false;

  for (const [role, output] of Object.entries(OUTPUTS)) {
    const platform = (await readYaml(join(CONFIG, "platforms", `${role}.yaml`))) as Platform;
    const dir = await mkdtemp(join(tmpdir(), `sing-box-${role}-`));
    let scratch: string | null = null;
    try {
      const input = join(dir, "config.json");
      await writeFile(input, JSON.stringify(buildConfig(base, platform, settings), null, 2) + "\n");
      scratch = check ? await mkdtemp(join(tmpdir(), "sing-box-out-")) : null;
      const out = scratch ? join(scratch, "template.json") : join(CONFIG, output);
      const proc = Bun.spawnSync([...SING_BOX, "merge", out, "-c", input], { stdio: ["ignore", "inherit", "inherit"] });
      if (proc.exitCode !== 0) throw new Error(`sing-box merge 失败 (role ${role}): exit ${proc.exitCode}`);
      if (!scratch) {
        console.log(`${output}: 已生成`);
        continue;
      }
      const diff = firstDiff(await Bun.file(out).bytes(), await Bun.file(join(CONFIG, output)).bytes());
      if (diff) {
        failed = true;
        console.error(`${output}: 与重算结果不一致 — ${diff}`);
      } else {
        console.log(`${output}: OK`);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
      if (scratch) await rm(scratch, { recursive: true, force: true });
    }
  }

  if (failed) process.exit(1);
}
