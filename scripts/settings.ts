#!/usr/bin/env bun
// settings.yaml 的唯一规范化输入：解析、校验、本地路径解析、产物命名与碰撞检测。
// build-config（装配底模）与 rules-compile（编译规则产物）都取同一份模型，
// 避免两套解析/命名/路径解释。

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const CONFIG_DIR = resolve(import.meta.dir, "../config/sing-box");
export const CUSTOM_DIR = resolve(import.meta.dir, "../config/rules/custom");
/** 本仓库发布规则产物的前缀；产物名由 artifactName 归一化。装配器与沙箱消费链共用。 */
export const RULES_URL = "https://raw.githubusercontent.com/shelken/proxy/sing-box-rules/singbox";

export type RuleKind = "local" | "geosite" | "geoip" | "url";
export interface Rule {
  name: string;
  source: string;
  to: string;
  kind: RuleKind;
  artifact: string;
  /** 本地 YAML 与 geosite 才产出 `-dns` 域名版伴生 */
  companion: boolean;
  /** 本地来源的绝对路径 */
  path?: string;
}
/** 分组：options 是候选，其余字段（type、default、url……）原样写进 sing-box 出站。 */
export interface Group {
  options: string[];
  default?: string;
  [field: string]: unknown;
}
export interface Settings {
  groups: Record<string, Group>;
  rules: Rule[];
  byName: Map<string, Rule>;
}
export interface Shared {
  outbounds: Array<{ tag: string; default?: string } & Record<string, any>>;
  [key: string]: unknown;
}

export const loadShared = (): Shared =>
  Bun.YAML.parse(readFileSync(join(CONFIG_DIR, "shared.yaml"), "utf8")) as Shared;

/** 稳定产物名：保留 Unicode 字母数字与 ._-，其余折叠为下划线；空名回退 rule。 */
export function artifactName(tag: string): string {
  return tag.replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/^_+|_+$/g, "") || "rule";
}

/** sing-box 命令：SING_BOX 覆盖，缺省走 mise；底模 merge 与规则 compile 共用。 */
export const singBoxCommand = (env = process.env.SING_BOX) =>
  (env ?? "mise exec -- sing-box").split(/\s+/);

const GEO_SOURCE = /^(geosite|geoip):([a-z0-9_-]+)$/;

/** geosite:x / geoip:x → { kind, name }；不完整或不合法返回 null。 */
export function geoTarget(source: string): { kind: "geosite" | "geoip"; name: string } | null {
  const m = source.match(GEO_SOURCE);
  return m ? { kind: m[1] as "geosite" | "geoip", name: m[2] } : null;
}

/** 分类来源：本地路径 / geosite:x / geoip:x / 远程 .srs（pathname 以 .srs 结尾，允许 query）。 */
function classify(source: string, at: string): RuleKind {
  if (/^https?:\/\//.test(source)) {
    let url: URL;
    try {
      url = new URL(source);
    } catch {
      throw new Error(`settings.yaml: ${at} 的来源不是合法 URL: ${source}`);
    }
    if (!url.pathname.endsWith(".srs")) {
      throw new Error(`settings.yaml: ${at} 的远程来源必须是 .srs: ${source}`);
    }
    return "url";
  }
  const geo = geoTarget(source);
  if (geo) return geo.kind;
  if (/^geo(site|ip):/.test(source)) {
    throw new Error(`settings.yaml: ${at} 的来源格式无效（geosite:x / geoip:x）: ${source}`);
  }
  return "local";
}

/** 去向集合：显式 reject、共用段的全部出站 tag、settings.yaml 的全部分组名。 */
export const destinations = (shared: Shared, groups: Record<string, Group>): Set<string> =>
  new Set(["reject", ...shared.outbounds.map((o) => o.tag), ...Object.keys(groups)]);

/** tag 是否已有定义：settings.yaml 分组或共用段出站。 */
const known = (tag: string, settings: Settings, shared: Shared): boolean =>
  tag in settings.groups || shared.outbounds.some((o) => o.tag === tag);

/** 规则去向沿分组默认候选走到底经过的全部名字（含自身）；成环在配置期报错。selector 没写 default 时内核选首个候选。 */
export function chain(rule: Rule, settings: Settings, shared: Shared): string[] {
  const path = [rule.to];
  for (;;) {
    const at = path[path.length - 1];
    const group = settings.groups[at];
    const first = group?.type === undefined || group.type === "selector" ? group?.options[0] : undefined;
    const next = group
      ? (group.default ?? (first !== undefined && known(first, settings, shared) ? first : undefined))
      : shared.outbounds.find((o) => o.tag === at)?.default;
    if (next === undefined) return path;
    if (path.includes(next)) throw new Error(`settings.yaml: 去向默认值成环: ${[...path, next].join(" -> ")}`);
    path.push(next);
  }
}

/** 解析并校验 settings.yaml；本地来源在此解析为绝对路径。 */
export function loadSettings(shared: Shared, path = join(CONFIG_DIR, "settings.yaml")): Settings {
  const parsed = Bun.YAML.parse(readFileSync(path, "utf8")) as any;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("settings.yaml: 顶层必须是 groups 与 rules 映射");
  }

  const groups: Record<string, Group> = {};
  for (const [name, value] of Object.entries<any>(parsed.groups ?? {})) {
    if (!Array.isArray(value?.options)) throw new Error(`settings.yaml: 分组 ${name} 需要 options 数组`);
    if (!value.options.every((o: unknown) => typeof o === "string" && o)) {
      throw new Error(`settings.yaml: 分组 ${name} 的 options 只能是非空字符串`);
    }
    if (value.default !== undefined && !value.options.includes(value.default)) {
      throw new Error(`settings.yaml: 分组 ${name} 的 default ${value.default} 不在 options 里`);
    }
    if (shared.outbounds.some((o) => o.tag === name)) {
      throw new Error(`settings.yaml: 分组 ${name} 与 shared.yaml 已有出站同名`);
    }
    groups[name] = value;
  }

  const dests = destinations(shared, groups);
  const rules: Rule[] = [];
  const seen = new Set<string>();
  for (const [i, value] of (parsed.rules ?? []).entries()) {
    const rule = value as any;
    const at = rule?.name ? `规则 ${rule.name}` : `第 ${i + 1} 条规则`;
    if (typeof rule?.name !== "string" || !rule.name) throw new Error(`settings.yaml: ${at} 缺少 name`);
    if (seen.has(rule.name)) throw new Error(`settings.yaml: 规则名重复: ${rule.name}`);
    if (typeof rule.source !== "string" || !rule.source) throw new Error(`settings.yaml: ${at} 缺少 source`);
    if (typeof rule.to !== "string" || !rule.to) throw new Error(`settings.yaml: ${at} 缺少 to`);
    if (!dests.has(rule.to)) {
      throw new Error(`settings.yaml: ${at} 的去向 ${rule.to} 无效（可用: ${[...dests].join(", ")}）`);
    }
    const kind = classify(rule.source, at);
    const localPath =
      kind === "local" ? (isAbsolute(rule.source) ? rule.source : resolve(dirname(path), rule.source)) : undefined;
    if (localPath && !existsSync(localPath)) {
      throw new Error(`settings.yaml: ${at} 的来源不存在: ${rule.source}`);
    }
    seen.add(rule.name);
    rules.push({
      name: rule.name,
      source: rule.source,
      to: rule.to,
      kind,
      artifact: artifactName(rule.name),
      companion: kind === "local" || kind === "geosite",
      path: localPath,
    });
  }

  detectCollisions(rules);
  return { groups, rules, byName: new Map(rules.map((r) => [r.name, r])) };
}

/** 构建前拒绝重名：tag 命名空间含所有来源（含 `-dns` 伴生），文件命名空间只看真会写盘的产物。 */
function detectCollisions(rules: Rule[]) {
  const claim = (owner: Map<string, string>, key: string, rule: string, label: string) => {
    const prev = owner.get(key);
    if (prev) throw new Error(`settings.yaml: 规则 ${prev} 与规则 ${rule} 的${label}冲突: ${key}`);
    owner.set(key, rule);
  };
  const tags = new Map<string, string>();
  const files = new Map<string, string>();
  for (const rule of rules) {
    claim(tags, rule.name, rule.name, " tag ");
    if (rule.companion) claim(tags, `${rule.name}-dns`, rule.name, " tag ");
    if (rule.kind === "url") continue;
    claim(files, rule.artifact, rule.name, "产物名");
    if (rule.companion) claim(files, `${rule.artifact}-dns`, rule.name, "产物名");
  }
}
