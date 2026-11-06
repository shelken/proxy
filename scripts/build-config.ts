#!/usr/bin/env bun
// 三份底模的装配：settings.yaml（用户规则与分组）+ base.yaml（稳定机制）+ platforms/（平台差异）。
// 输出交给官方 sing-box merge 归一化，字段顺序由内核决定，避免手写序列化漂移。
//
// base.yaml 里引用设置清单的关联（DNS 解析归属、QUIC 豁免）按当前去向解析：
// 条目被删或去向改变时自动撤销，不留未声明引用，也不产生空匹配。

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  artifactName,
  loadBase,
  loadSettings,
  repoUrl,
  singBoxCommand,
  type Base,
  type Rule,
  type Settings,
} from "./settings.ts";

const CONFIG = join(import.meta.dir, "../config/sing-box");
const OUTPUTS: Record<string, string> = {
  mac: "template.json",
  ios: "template-ios.json",
  router: "template-router.json",
};

export interface Platform {
  inbounds: unknown[];
  endpoints?: unknown[];
  experimental?: Record<string, unknown>;
  dns?: { servers_prepend?: unknown[]; rules_prepend?: unknown[] };
  route?: { rules_head?: unknown[]; rules_hijack?: unknown[] };
}

type Entry = Record<string, any> & { link?: Array<{ name: string; to?: string }> };

const ruleSetBlock = (tag: string, url: string) => ({
  type: "remote",
  tag,
  format: "binary",
  url,
  update_interval: "1d",
});

const combine = (names: string[], to: string) =>
  names.length === 0
    ? null
    : to === "reject"
      ? { rule_set: names, action: "reject" }
      : { rule_set: names, action: "route", outbound: to };

/** 规则的有效去向：分组取其默认节点。 */
const effectiveTo = (rule: Rule, settings: Settings) =>
  settings.groups[rule.to]?.default ?? rule.to;

/** base 链接解析：只保留当前仍声明且去向匹配的清单；空结果表示整条规则作废。 */
function resolveLink(entry: Entry, settings: Settings, dns: boolean) {
  const names = entry.link!
    .filter((l) => {
      const rule = settings.byName.get(l.name);
      if (!rule || (l.to && rule.to !== l.to)) return false;
      return !dns || rule.companion;
    })
    .map((l) => l.name);
  if (names.length === 0) return null;
  const { link, ...rest } = entry;
  return { ...rest, rule_set: names.map((n) => (dns ? `${n}-dns` : n)) };
}

/** 固定解析排除清单：base 名单按当前去向过滤，再补上其余默认直连的清单。 */
function resolveExclude(base: Base, settings: Settings): string[] {
  const direct = new Set(settings.rules.filter((r) => effectiveTo(r, settings) === "direct").map((r) => r.name));
  const names = base.resolve_exclude.filter((n) => direct.has(n));
  for (const rule of settings.rules) {
    if (direct.has(rule.name) && !names.includes(rule.name)) names.push(rule.name);
  }
  return names;
}

/** rest 段：尊重 settings 顺序，相邻同去向合并成一条。 */
function restRules(rules: Rule[]) {
  const groups: Array<{ to: string; names: string[] }> = [];
  for (const rule of rules) {
    if (rule.to === "reject" || rule.to === "download") continue;
    const last = groups[groups.length - 1];
    if (last?.to === rule.to) last.names.push(rule.name);
    else groups.push({ to: rule.to, names: [rule.name] });
  }
  return groups.map((g) => combine(g.names, g.to)!);
}

function routeRules(base: Base, platform: Platform, settings: Settings) {
  const rules: Array<Record<string, any>> = [];
  const reject = combine(settings.rules.filter((r) => r.to === "reject").map((r) => r.name), "reject");
  const download = combine(settings.rules.filter((r) => r.to === "download").map((r) => r.name), "download");
  const exclude = resolveExclude(base, settings);

  for (const entry of base.route.rules as Entry[]) {
    if (entry.platform === "head") rules.push(...(platform.route?.rules_head ?? []));
    else if (entry.platform === "hijack") rules.push(...(platform.route?.rules_hijack ?? []));
    else if (entry.slot === "reject") { if (reject) rules.push(reject); }
    else if (entry.slot === "download") { if (download) rules.push(download); }
    else if (entry.slot === "resolve") {
      rules.push(
        exclude.length > 0
          ? { rule_set: exclude, invert: true, action: "resolve", server: "dns-proxy", strategy: "ipv4_only" }
          : { action: "resolve", server: "dns-proxy", strategy: "ipv4_only" },
      );
    } else if (entry.slot === "rest") rules.push(...restRules(settings.rules));
    else if (entry.link) {
      const resolved = resolveLink(entry, settings, false);
      if (resolved) rules.push(resolved);
    } else rules.push(entry);
  }
  return rules;
}

/** DNS 段：平台前置规则 + base 规则；链接解析出引用的 `<name>-dns` 伴生。 */
function dnsBlock(base: Base, platform: Platform, settings: Settings) {
  const rules: Array<Record<string, any>> = [...(platform.dns?.rules_prepend ?? [])];
  const companions = new Set<string>();
  for (const entry of base.dns.rules as Entry[]) {
    if (!entry.link) {
      rules.push(entry);
      continue;
    }
    const resolved = resolveLink(entry, settings, true);
    if (!resolved) continue;
    for (const tag of resolved.rule_set as string[]) companions.add(tag.replace(/-dns$/, ""));
    rules.push(resolved);
  }
  return {
    block: {
      servers: [...(platform.dns?.servers_prepend ?? []), ...base.dns.servers],
      rules,
      final: base.dns.final,
      strategy: base.dns.strategy,
      optimistic: base.dns.optimistic,
    },
    companions,
  };
}

export function buildConfig(base: Base, platform: Platform, settings: Settings) {
  const dns = dnsBlock(base, platform, settings);
  const groups = Object.entries(settings.groups).map(([tag, g]) => ({
    type: "selector",
    tag,
    outbounds: g.options,
    default: g.default,
    interrupt_exist_connections: true,
  }));

  const dnsNames = [
    ...base.dns_companions.filter((n) => dns.companions.has(n)),
    ...[...dns.companions].filter((n) => !base.dns_companions.includes(n)),
  ];
  const dnsDecls = dnsNames.map((n) => {
    const artifact = settings.byName.get(n)?.artifact ?? artifactName(n);
    return ruleSetBlock(`${n}-dns`, repoUrl(base, `${artifact}-dns`));
  });
  const ruleDecls = settings.rules.map((r) =>
    ruleSetBlock(r.name, r.kind === "url" ? r.source : repoUrl(base, r.artifact)),
  );

  const config: Record<string, any> = {
    log: base.log,
    dns: dns.block,
    http_clients: base.http_clients,
    inbounds: platform.inbounds,
    outbounds: [...base.outbounds, ...groups],
    route: {
      rules: routeRules(base, platform, settings),
      rule_set: [...dnsDecls, ...ruleDecls],
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

const readPlatform = async (role: string) =>
  Bun.YAML.parse(await Bun.file(join(CONFIG, "platforms", `${role}.yaml`)).text()) as Platform;

if (import.meta.main) {
  const base = loadBase();
  const settings = loadSettings(base);
  const check = Bun.argv.includes("--check");
  let failed = false;

  for (const [role, output] of Object.entries(OUTPUTS)) {
    const platform = await readPlatform(role);
    const work = await mkdtemp(join(tmpdir(), "sing-box-build-"));
    const target = check ? join(work, "template.json") : join(CONFIG, output);
    try {
      const input = join(work, "config.json");
      await writeFile(input, JSON.stringify(buildConfig(base, platform, settings), null, 2) + "\n");
      const proc = Bun.spawnSync([...singBoxCommand(), "merge", target, "-c", input], {
        stdio: ["ignore", "inherit", "inherit"],
      });
      if (proc.exitCode !== 0) throw new Error(`sing-box merge 失败 (${role}): exit ${proc.exitCode}`);
      if (!check) {
        console.log(`${output}: 已生成`);
        continue;
      }
      const diff = firstDiff(await Bun.file(target).bytes(), await Bun.file(join(CONFIG, output)).bytes());
      if (diff) {
        failed = true;
        console.error(`${output}: 与重算结果不一致 — ${diff}`);
      } else console.log(`${output}: OK`);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
  if (failed) process.exit(1);
}

function firstDiff(a: Uint8Array, b: Uint8Array): string | null {
  if (a.length === b.length && a.every((v, i) => v === b[i])) return null;
  let i = 0;
  while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
  const ctx = (buf: Uint8Array) =>
    JSON.stringify(new TextDecoder().decode(buf.subarray(Math.max(0, i - 30), i + 30)));
  return `字节 ${i}: 磁盘 ${ctx(b)} != 重算 ${ctx(a)}`;
}
