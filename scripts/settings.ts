#!/usr/bin/env bun
// settings.yaml 的唯一规范化输入：解析、校验、本地路径解析、产物命名与碰撞检测。
// build-config（装配底模）与 rules-compile（编译规则产物）都取同一份模型，
// 避免两套解析/命名/路径解释（PR #153 审查）。

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const CONFIG_DIR = resolve(import.meta.dir, "../config/sing-box");
export const CUSTOM_DIR = resolve(import.meta.dir, "../config/rules/custom");

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
export interface Group {
  options: string[];
  default: string;
}
export interface Settings {
  groups: Record<string, Group>;
  rules: Rule[];
  byName: Map<string, Rule>;
}
export interface Base {
  rule_set_url: string;
  dns_companions: string[];
  resolve_exclude: string[];
  log?: Record<string, unknown>;
  dns: { rules: Array<Record<string, any>>; [k: string]: any };
  http_clients: unknown[];
  experimental: Record<string, any>;
  outbounds: Array<{ tag: string } & Record<string, any>>;
  route: { rules: Array<Record<string, any>>; [k: string]: any };
}

export const loadBase = (): Base =>
  Bun.YAML.parse(readFileSync(join(CONFIG_DIR, "base.yaml"), "utf8")) as Base;

/** 稳定产物名：保留 Unicode 字母数字与 ._-，其余折叠为下划线；空名回退 rule。 */
export function artifactName(tag: string): string {
  return tag.replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/^_+|_+$/g, "") || "rule";
}

/** 本仓库发布地址：归一化后的产物名替换进 {artifact}。 */
export const repoUrl = (base: Base, artifact: string) =>
  base.rule_set_url.replace("{artifact}", artifact);

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
  if (source.startsWith("geosite:") || source.startsWith("geoip:")) {
    const geo = geoTarget(source);
    if (!geo) throw new Error(`settings.yaml: ${at} 的来源格式无效（geosite:x / geoip:x）: ${source}`);
    return geo.kind;
  }
  return "local";
}

/** 解析并校验 settings.yaml；本地来源在此解析为绝对路径。 */
export function loadSettings(base: Base, path = join(CONFIG_DIR, "settings.yaml")): Settings {
  const parsed = Bun.YAML.parse(readFileSync(path, "utf8")) as any;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("settings.yaml: 顶层必须是 groups 与 rules 映射");
  }

  const groups: Record<string, Group> = {};
  for (const [name, value] of Object.entries<any>(parsed.groups ?? {})) {
    if (!Array.isArray(value?.options) || typeof value.default !== "string") {
      throw new Error(`settings.yaml: 分组 ${name} 需要 options 数组与 default 字符串`);
    }
    if (!value.options.every((o: unknown) => typeof o === "string" && o)) {
      throw new Error(`settings.yaml: 分组 ${name} 的 options 只能是非空字符串`);
    }
    if (!value.options.includes(value.default)) {
      throw new Error(`settings.yaml: 分组 ${name} 的 default ${value.default} 不在 options 里`);
    }
    if (base.outbounds.some((o) => o.tag === name)) {
      throw new Error(`settings.yaml: 分组 ${name} 与 base.yaml 已有出站同名`);
    }
    groups[name] = { options: value.options, default: value.default };
  }

  const destinations = new Set(["reject", ...base.outbounds.map((o) => o.tag), ...Object.keys(groups)]);
  const rules: Rule[] = [];
  const seen = new Set<string>();
  for (const [i, value] of (parsed.rules ?? []).entries()) {
    const rule = value as any;
    const at = rule?.name ? `规则 ${rule.name}` : `第 ${i + 1} 条规则`;
    if (typeof rule?.name !== "string" || !rule.name) throw new Error(`settings.yaml: ${at} 缺少 name`);
    if (seen.has(rule.name)) throw new Error(`settings.yaml: 规则名重复: ${rule.name}`);
    if (typeof rule.source !== "string" || !rule.source) throw new Error(`settings.yaml: ${at} 缺少 source`);
    if (typeof rule.to !== "string" || !rule.to) throw new Error(`settings.yaml: ${at} 缺少 to`);
    if (!destinations.has(rule.to)) {
      throw new Error(`settings.yaml: ${at} 的去向 ${rule.to} 无效（可用: ${[...destinations].join(", ")}）`);
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
