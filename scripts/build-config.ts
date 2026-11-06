#!/usr/bin/env bun
// 三份底模装配：settings.yaml（用户规则与分组）+ base.yaml（原生共享字段）+ platforms/（平台原生层）。
//
// 输入按 00-platform / 01-base / 02-policy 三个原生文档交给官方 sing-box merge：
// 数组按文件序拼接，标量取更早文件（已由 build-config.test.ts 的 merge 契约测试验证）。
// 与设置相关的路由/DNS 规则在 makePolicy 的一个固定顺序里生成，不做字段白名单转抄。

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactName, loadBase, loadSettings, RULES_URL, singBoxCommand, type Base, type Rule, type Settings } from "./settings.ts";

const CONFIG = join(import.meta.dir, "../config/sing-box");
const OUTPUTS: Record<string, string> = {
  mac: "template.json",
  ios: "template-ios.json",
  router: "template-router.json",
};

export type Role = keyof typeof OUTPUTS;
export type Platform = {
  inbounds: unknown[];
  endpoints?: unknown[];
  dns?: Record<string, unknown>;
  experimental?: Record<string, unknown>;
};

const rulesUrl = (artifact: string) => `${RULES_URL}/${artifact}.srs`;
const ruleSetBlock = (tag: string, url: string) => ({
  type: "remote",
  tag,
  format: "binary",
  url,
  update_interval: "1d",
});

/** 沿 settings 分组与 base selector.default 解析最终默认去向；成环在配置期报错。 */
function effectiveTo(rule: Rule, settings: Settings, base: Base): string {
  const seen = new Set<string>();
  let to = rule.to;
  for (;;) {
    const next = settings.groups[to]?.default ?? base.outbounds.find((o) => o.tag === to)?.default;
    if (next === undefined) return to;
    if (seen.has(to)) throw new Error(`settings.yaml: 去向默认值成环: ${[...seen, to].join(" -> ")}`);
    seen.add(to);
    to = next;
  }
}

/**
 * 策略锚点：DNS 与 QUIC 规则按名字引用这些规则，并要求固定去向。
 * 改名或改去向后相关规则会被省略，由 inactiveAnchors 提示。
 */
const ANCHORS: Record<string, string> = {
  MyReject: "reject",
  Lan: "direct",
  MyDirect: "direct",
  MyProxy: "proxy",
  ChinaMax: "direct",
  cftunnel: "direct",
  "geoip-cn": "direct",
};

/** 锚点当前是否生效；dns 还要求该清单能产出 -dns 伴生。 */
function active(name: string, settings: Settings, dns = false): boolean {
  const rule = settings.byName.get(name);
  return rule !== undefined && rule.to === ANCHORS[name] && (!dns || rule.companion);
}

/** 未生效的锚点说明：规则不在设置里，或去向不是约定值。 */
export function inactiveAnchors(settings: Settings): string[] {
  return Object.entries(ANCHORS).flatMap(([name, to]) => {
    const rule = settings.byName.get(name);
    if (!rule) return [`规则 ${name} 不在设置里，依赖它的 DNS/QUIC 规则已省略`];
    if (rule.to !== to) return [`规则 ${name} 的去向是 ${rule.to}，约定为 ${to}，依赖它的 DNS/QUIC 规则已省略`];
    return [];
  });
}

// 与设置相关的 DNS 规则：固定顺序，link 段按当前设置解析，其余原样保留。
const DNS_POLICY: Array<Record<string, any> & { link?: string }> = [
  { link: "MyReject", action: "reject" },
  { link: "Lan", server: "dns-lan", disable_optimistic_cache: true },
  { domain_suffix: ["local", "lan", "home.arpa"], server: "dns-lan", disable_optimistic_cache: true },
  { link: "MyDirect", server: "dns-lan", disable_optimistic_cache: true },
  { clash_mode: "direct", server: "dns-lan" },
  { query_type: ["PTR"], server: "dns-lan" },
  { link: "MyProxy", query_type: ["A", "AAAA"], server: "dns-fakeip" },
  { link: "ChinaMax", server: "dns-direct-cn" },
  { query_type: ["A", "AAAA"], server: "dns-fakeip" },
];

function policyDns(settings: Settings) {
  const rules: Array<Record<string, any>> = [];
  const companions: string[] = [];
  for (const { link, ...rule } of DNS_POLICY) {
    if (link === undefined) rules.push(rule);
    else if (active(link, settings, true)) {
      companions.push(link);
      rules.push({ ...rule, rule_set: [`${link}-dns`] });
    }
  }
  return { rules, companions };
}

/**
 * QUIC 守卫：代理清单先拒 UDP 443/80，国内直连清单放行，其余兜底拒绝。
 * 直连放行只认这四个锚点；其他 to: direct 的规则不在其中，其 UDP 443/80 会被兜底拒绝。
 */
function quicRules(settings: Settings): Array<Record<string, any>> {
  const rules: Array<Record<string, any>> = [];
  if (active("MyProxy", settings)) {
    rules.push({ network: "udp", port: [443, 80], rule_set: ["MyProxy"], action: "reject", no_drop: true });
  }
  const direct = ["ChinaMax", "Lan", "cftunnel", "geoip-cn"].filter((name) => active(name, settings));
  if (direct.length) {
    rules.push({ network: "udp", port: [443, 80], rule_set: direct, action: "route", outbound: "direct" });
  }
  rules.push({ network: "udp", port: [443, 80], action: "reject", no_drop: true });
  return rules;
}

function routeRules(settings: Settings, base: Base, role: Role): Array<Record<string, any>> {
  const rules: Array<Record<string, any>> = [];
  // 平台入口守卫：router 的 dns-in 与 iOS 的 ts-ep 都必须在 sniff 之前
  if (role === "router") rules.push({ inbound: ["dns-in"], action: "hijack-dns" });
  if (role === "ios") rules.push({ inbound: ["ts-ep"], action: "reject" });
  rules.push({ action: "sniff", sniffer: ["http", "tls", "quic", "dns", "bittorrent"] });
  rules.push({ protocol: "dns", action: "hijack-dns" });
  rules.push({ port: 53, action: "hijack-dns" });
  // iOS Tailscale 路由排在 DNS 劫持之后、私网直连之前
  if (role === "ios") rules.push({ preferred_by: "ts-ep", action: "route", outbound: "ts-ep" });
  rules.push({ ip_is_private: true, action: "route", outbound: "direct" });
  for (const rule of settings.rules.filter((r) => r.to === "reject")) {
    rules.push({ rule_set: [rule.name], action: "reject" });
  }
  rules.push(...quicRules(settings));
  rules.push({ clash_mode: "direct", action: "route", outbound: "direct" });
  rules.push({ clash_mode: "global", action: "route", outbound: "proxy" });
  rules.push({ protocol: "bittorrent", action: "route", outbound: "torrent" });
  for (const rule of settings.rules.filter((r) => r.to === "download")) {
    rules.push({ rule_set: [rule.name], action: "route", outbound: "download" });
  }
  const direct = settings.rules.filter((r) => effectiveTo(r, settings, base) === "direct").map((r) => r.name);
  rules.push(
    direct.length > 0
      ? { rule_set: direct, invert: true, action: "resolve", server: "dns-proxy", strategy: "ipv4_only" }
      : { action: "resolve", server: "dns-proxy", strategy: "ipv4_only" },
  );
  for (const rule of settings.rules) {
    if (rule.to !== "reject" && rule.to !== "download") {
      rules.push({ rule_set: [rule.name], action: "route", outbound: rule.to });
    }
  }
  return rules;
}

/** 设置驱动的策略层：route.rules / dns.rules / 设置分组 selector / rule_set 声明。 */
export function makePolicy(settings: Settings, base: Base, role: Role) {
  const dns = policyDns(settings);
  const groups = Object.entries(settings.groups).map(([tag, g]) => ({
    type: "selector",
    tag,
    outbounds: g.options,
    default: g.default,
    interrupt_exist_connections: true,
  }));
  const companions = dns.companions.map((name) => {
    const artifact = settings.byName.get(name)!.artifact;
    return ruleSetBlock(`${name}-dns`, rulesUrl(`${artifact}-dns`));
  });
  const mains = settings.rules.map((rule) =>
    ruleSetBlock(rule.name, rule.kind === "url" ? rule.source : rulesUrl(rule.artifact)),
  );
  return {
    dns: { rules: dns.rules },
    outbounds: groups,
    route: { rules: routeRules(settings, base, role), rule_set: [...companions, ...mains] },
  };
}

/** 把平台层、base 层、策略层交给官方 merge；target 为输出文件。 */
export async function mergeTo(target: string, base: Base, platform: Platform, settings: Settings, role: Role): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "sing-box-input-"));
  try {
    await writeFile(join(dir, "00-platform.json"), JSON.stringify(platform, null, 2) + "\n");
    await writeFile(join(dir, "01-base.json"), JSON.stringify(base, null, 2) + "\n");
    await writeFile(join(dir, "02-policy.json"), JSON.stringify(makePolicy(settings, base, role), null, 2) + "\n");
    const proc = Bun.spawnSync([...singBoxCommand(), "merge", target, "-C", dir], { stdio: ["ignore", "inherit", "inherit"] });
    if (proc.exitCode !== 0) throw new Error(`sing-box merge 失败 (${role}): exit ${proc.exitCode}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const readPlatform = async (role: Role) =>
  Bun.YAML.parse(await Bun.file(join(CONFIG, "platforms", `${role}.yaml`)).text()) as Platform;

function firstDiff(a: Uint8Array, b: Uint8Array): string | null {
  if (a.length === b.length && a.every((v, i) => v === b[i])) return null;
  let i = 0;
  while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
  const ctx = (buf: Uint8Array) =>
    JSON.stringify(new TextDecoder().decode(buf.subarray(Math.max(0, i - 30), i + 30)));
  return `字节 ${i}: 磁盘 ${ctx(b)} != 重算 ${ctx(a)}`;
}

if (import.meta.main) {
  const base = loadBase();
  const settings = loadSettings(base);
  for (const warning of inactiveAnchors(settings)) console.warn(`WARN: ${warning}`);
  const check = Bun.argv.includes("--check");
  let failed = false;

  for (const role of Object.keys(OUTPUTS) as Role[]) {
    const platform = await readPlatform(role);
    const work = await mkdtemp(join(tmpdir(), "sing-box-build-"));
    const target = check ? join(work, "template.json") : join(CONFIG, OUTPUTS[role]);
    try {
      await mergeTo(target, base, platform, settings, role);
      if (!check) {
        console.log(`${OUTPUTS[role]}: 已生成`);
        continue;
      }
      const diff = firstDiff(await Bun.file(target).bytes(), await Bun.file(join(CONFIG, OUTPUTS[role])).bytes());
      if (diff) {
        failed = true;
        console.error(`${OUTPUTS[role]}: 与重算结果不一致 — ${diff}`);
      } else console.log(`${OUTPUTS[role]}: OK`);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
  if (failed) process.exit(1);
}
