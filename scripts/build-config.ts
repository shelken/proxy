#!/usr/bin/env bun
// 三份底模装配：platforms/*.yaml 是各平台完整的 sing-box 模板（YAML，结构与 JSON 一致），
// 共用的部分在 shared.yaml、你的分组与分流在 settings.yaml，模板里用 $include 引入。
// 本文件把 $include 展开成完整配置，再交给官方 sing-box merge 规范化后写出 JSON。

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chain, destinations, loadSettings, loadShared, RULES_URL, singBoxCommand, type Settings, type Shared } from "./settings.ts";

const CONFIG = join(import.meta.dir, "../config/sing-box");
const OUTPUTS: Record<string, string> = {
  mac: "template.json",
  ios: "template-ios.json",
  router: "template-router.json",
};

export type Role = keyof typeof OUTPUTS;
type Rec = Record<string, any>;
export type Doc = Rec;

const rulesUrl = (artifact: string) => `${RULES_URL}/${artifact}.srs`;

/**
 * 解析平台与 shared.yaml 里的 rule_set，这是模板引入 settings.yaml 的地方：
 * - 写规则名：引用那条规则，DNS 里还可以写它的 -dns 伴生；规则送往的 outbound 必须在它的去向链上
 * - 写去向名（reject、download、direct……）：引入 settings.yaml 里去向落在它的全部规则
 * 传入 claimed 时（路由规则），不带 invert 的去向名引入的规则记入 claimed，不再追加到服务段。
 * logical 规则的子规则同样检查，但不认领。
 */
function resolveRuleSets(rules: Rec[], settings: Settings, shared: Shared, companions: Set<string>, claimed?: Set<string>): Rec[] {
  const dests = destinations(shared, settings.groups);
  return rules.map((rule) => {
    const children = Array.isArray(rule.rules) ? resolveRuleSets(rule.rules, settings, shared, companions) : undefined;
    if (rule.rule_set === undefined) return children ? { ...rule, rules: children } : rule;
    const names = ([rule.rule_set].flat() as string[]).flatMap((tag) => {
      const own = settings.byName.get(tag);
      if (own) {
        if (dests.has(tag)) throw new Error(`rule_set 里的 ${tag} 既是规则名又是去向名，请改规则名`);
        if (rule.outbound && !rule.invert && !chain(own, settings, shared).includes(rule.outbound)) {
          throw new Error(`规则 ${tag} 的去向是 ${own.to}，但模板把它直接送往 ${rule.outbound}`);
        }
        return [tag];
      }
      if (tag.endsWith("-dns") && settings.byName.get(tag.slice(0, -4))?.companion) {
        companions.add(tag.slice(0, -4));
        return [tag];
      }
      if (!dests.has(tag)) throw new Error(`rule_set 里的 ${tag} 既不是 settings.yaml 的规则名，也不是去向名`);
      const hit = settings.rules.filter((r) => chain(r, settings, shared).includes(tag)).map((r) => r.name);
      if (claimed && !rule.invert) hit.forEach((n) => claimed.add(n));
      return hit;
    });
    return names.length ? { ...rule, rule_set: names } : null;
  }).filter((r): r is Rec => r !== null);
}

const ruleSetBlock = (tag: string, url: string) => ({ type: "remote", tag, format: "binary", url, update_interval: "1d" });

const isInclude = (x: unknown): x is { $include: string } =>
  typeof x === "object" && x !== null && !Array.isArray(x) && Object.keys(x).length === 1 && "$include" in x;
const isObject = (x: unknown): x is Rec => typeof x === "object" && x !== null && !Array.isArray(x);

const deepMerge = (defaults: Rec, overrides: Rec): Rec =>
  Object.fromEntries(
    [...new Set([...Object.keys(defaults), ...Object.keys(overrides)])].map((k) => [
      k,
      isObject(defaults[k]) && isObject(overrides[k]) ? deepMerge(defaults[k], overrides[k]) : (overrides[k] ?? defaults[k]),
    ]),
  );

/**
 * 展开 $include：数组里的 { $include: 名字 } 换成那一段的全部元素；对象里的 `$include: 名字`
 * 把那一段的字段并进来，本地写的同名字段优先。名字不在 frags 里的原样保留，留给下一轮。
 */
function include(node: any, frags: Rec): any {
  if (Array.isArray(node)) {
    return node.flatMap((x) => (isInclude(x) && x.$include in frags ? include(frags[x.$include], frags) : [include(x, frags)]));
  }
  if (!isObject(node)) return node;
  const { $include, ...rest } = node;
  const own = Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, include(v, frags)]));
  return typeof $include === "string" && $include in frags ? deepMerge(include(frags[$include], frags), own) : node.$include ? { $include, ...own } : own;
}

/** 平台模板展开 shared.yaml 的共用段，再展开 settings.yaml 生成的 groups、rule-sets、services。 */
export function assemble(settings: Settings, shared: Shared, platform: Doc) {
  const doc = include(platform, shared);
  const claimed = new Set<string>();
  const companions = new Set<string>();
  doc.route.rules = resolveRuleSets(doc.route.rules, settings, shared, companions, claimed);
  doc.dns.rules = resolveRuleSets(doc.dns.rules, settings, shared, companions);
  return include(doc, {
    groups: Object.entries(settings.groups).map(([tag, { options, ...native }]) => ({
      type: "selector",
      tag,
      outbounds: options,
      ...native,
      interrupt_exist_connections: true,
    })),
    "rule-sets": [
      ...[...companions].map((n) => ruleSetBlock(`${n}-dns`, rulesUrl(`${settings.byName.get(n)!.artifact}-dns`))),
      ...settings.rules.map((r) => ruleSetBlock(r.name, r.kind === "url" ? r.source : rulesUrl(r.artifact))),
    ],
    services: settings.rules
      .filter((r) => !claimed.has(r.name))
      .map((r) => ({ rule_set: [r.name], action: "route", outbound: r.to })),
  });
}

/** 展开后交给官方 sing-box merge 规范化并写出 target。 */
export async function mergeTo(target: string, shared: Shared, platform: Doc, settings: Settings): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "sing-box-input-"));
  try {
    await writeFile(join(dir, "00-template.json"), JSON.stringify(assemble(settings, shared, platform), null, 2) + "\n");
    const proc = Bun.spawnSync([...singBoxCommand(), "merge", target, "-C", dir], { stdio: ["ignore", "ignore", "pipe"] });
    if (proc.exitCode !== 0) throw new Error(`sing-box merge 失败: exit ${proc.exitCode}\n${proc.stderr}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const readPlatform = async (role: Role) =>
  Bun.YAML.parse(await Bun.file(join(CONFIG, "platforms", `${role}.yaml`)).text()) as Doc;

function firstDiff(a: Uint8Array, b: Uint8Array): string | null {
  if (a.length === b.length && a.every((v, i) => v === b[i])) return null;
  let i = 0;
  while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
  const ctx = (buf: Uint8Array) =>
    JSON.stringify(new TextDecoder().decode(buf.subarray(Math.max(0, i - 30), i + 30)));
  return `字节 ${i}: 磁盘 ${ctx(b)} != 重算 ${ctx(a)}`;
}

if (import.meta.main) {
  const shared = loadShared();
  const settings = loadSettings(shared);
  const check = Bun.argv.includes("--check");
  let failed = false;

  for (const role of Object.keys(OUTPUTS) as Role[]) {
    const platform = await readPlatform(role);
    const work = await mkdtemp(join(tmpdir(), "sing-box-build-"));
    const target = check ? join(work, "template.json") : join(CONFIG, OUTPUTS[role]);
    try {
      await mergeTo(target, shared, platform, settings);
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
