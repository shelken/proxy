#!/usr/bin/env bun
/**
 * 规则产物编译器：settings.yaml 的规则来源 → 各客户端产物。
 *
 *   - geosite:x / geoip:x  外部原生引用：下载 MetaCubeX/meta-rules-dat 三端同源产物，零解析。
 *   - 本地 *.yaml          内部结构化规则：YAML → AST → 三端发射，sing-box 端经官方 compile 编成 .srs。
 *   - 外部 .srs           底模直接远程引用，这里不反编译、不产三端产物。
 *
 * `-dns` 伴生：DNS 规则在拿到响应前只能按查询名判定，被引用的清单需要只含域名条目的副本。
 * 本地 YAML 与 geosite 产出伴生；geoip 是 IP 集合、外部 .srs 不可反编译，都不产。
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import {
  artifactName,
  CUSTOM_DIR,
  geoTarget,
  loadBase,
  loadSettings,
  singBoxCommand,
  type Rule,
  type Settings,
} from "./settings.ts";

const ROOT = join(import.meta.dir, "..");
const GENERATED_DIR = join(ROOT, "config/rules/generated");
const META_RULES_SING = "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo";
const META_RULES_MIHOMO = "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo";

export type Client = "singbox" | "clash" | "plain";
const SUFFIXES: Record<Client, string> = { singbox: ".json", clash: ".yaml", plain: ".list" };
const MIRROR_SUFFIXES: Record<Client, string> = { singbox: ".srs", clash: ".yaml", plain: ".list" };

const DNS_RULE_FIELDS = ["domain", "domain_suffix", "domain_keyword", "domain_regex"] as const;
/** 产物内规则字段排序：域名类在前，过程/网络类在后，逻辑规则恒排最后。 */
const FIELD_ORDER = [
  "domain",
  "domain_suffix",
  "domain_keyword",
  "domain_regex",
  "process_name",
  "ip_cidr",
  "source_ip_cidr",
  "port",
  "port_range",
  "source_port",
  "source_port_range",
  "network",
];

export interface RuleAST {
  domain?: string[];
  domain_suffix?: string[];
  domain_keyword?: string[];
  domain_regex?: string[];
  ip_cidr?: string[];
  source_ip_cidr?: string[];
  ip_asn?: string[];
  port?: number[];
  port_range?: string[];
  source_port?: number[];
  source_port_range?: string[];
  process_name?: string[];
  network?: string[];
  logical?: Array<Record<string, unknown>>;
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
export type SingBoxRule = Record<string, JsonValue>;
export interface Built {
  client: Client;
  path: string;
  total: number;
}

function fetchBytes(url: string): Buffer {
  const proc = spawnSync("curl", ["-fsSL", "--max-time", "60", "-A", "singbox-rule-builder/2.0", url], {
    maxBuffer: 64 * 1024 * 1024,
  });
  if (proc.status !== 0) throw new Error(`下载失败: ${url}`);
  return proc.stdout;
}

function write(path: string, data: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

/** custom/ 下存在但没被 settings 引用的列表：只放文件不登记不会产出规则，显式提醒。 */
export function orphanCustomLists(rules: Rule[]): string[] {
  const referenced = new Set(
    rules.filter((r) => r.kind === "local").map((r) => basename(r.path!)),
  );
  let entries: string[] = [];
  try {
    entries = readdirSync(CUSTOM_DIR);
  } catch {
    return [];
  }
  return entries
    .filter((name) => /\.(ya?ml|list)$/.test(name) && !referenced.has(name))
    .map((name) => `config/rules/custom/${name}`)
    .sort();
}

/** 外部原生引用：geosite:x / geoip:x → meta-rules-dat 三端同源 URL。 */
export function externalUrls(source: string): Record<Client, string> | null {
  const geo = geoTarget(source);
  if (!geo) return null;
  return {
    singbox: `${META_RULES_SING}/${geo.kind}/${geo.name}.srs`,
    clash: `${META_RULES_MIHOMO}/${geo.kind}/${geo.name}.yaml`,
    plain: `${META_RULES_MIHOMO}/${geo.kind}/${geo.name}.list`,
  };
}

/** 字段值只能是字符串或数字（或它们的数组）；null、映射对象、嵌套数组一律报错。 */
function scalarList(field: string, raw: unknown): unknown[] {
  const list = Array.isArray(raw) ? raw : [raw];
  for (const one of list) {
    if (typeof one !== "string" && typeof one !== "number") {
      throw new Error(`字段 ${field} 的值必须是字符串或数字: ${JSON.stringify(one)}`);
    }
  }
  return list;
}

/** logical 子树：键名归一化，叶节点必须是白名单内的单字段标量。 */
function normalizeLogical(node: Record<string, unknown>): Record<string, unknown> {
  const rules = (node.rules as unknown[]).map((sub) => {
    if (sub === null || typeof sub !== "object" || Array.isArray(sub)) {
      throw new Error(`logical 子规则必须是对象: ${JSON.stringify(sub)}`);
    }
    const child = sub as Record<string, unknown>;
    if ("mode" in child) return normalizeLogical(child);
    const keys = Object.keys(child);
    if (keys.length !== 1) throw new Error(`logical 叶节点必须恰好一个字段: ${JSON.stringify(child)}`);
    const k = keys[0].replace(/-/g, "_");
    if (!FIELD_ORDER.includes(k) && k !== "ip_asn") throw new Error(`logical 未知字段: ${keys[0]}`);
    const vals = scalarList(keys[0], child[keys[0]]);
    if (vals.length !== 1) throw new Error(`logical 叶节点值必须是单个标量: ${JSON.stringify(child)}`);
    return { [k]: vals[0] };
  });
  return { mode: node.mode, rules };
}

/** 内部 custom YAML → AST；未知字段直接抛错，静默跳过等于悄悄丢规则。 */
export function parseYamlAst(content: string): RuleAST {
  const parsed = Bun.YAML.parse(content) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("rules YAML 顶层必须是对象（rules: [...]）");
  }
  const { rules } = parsed as { rules?: unknown };
  if (!Array.isArray(rules)) throw new Error("rules YAML 缺少 rules: 列表（或形态不是数组）");

  const ast: RuleAST = {};
  const add = (key: keyof RuleAST, val: unknown) => {
    const target = (ast[key] ??= [] as unknown[]) as unknown[];
    if (!target.includes(val)) target.push(val);
  };
  for (const item of rules) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`rules 条目必须是对象: ${JSON.stringify(item)}`);
    }
    for (const [rawKey, rawValues] of Object.entries(item)) {
      const key = rawKey.replace(/-/g, "_");
      if (key === "logical") {
        for (const l of Array.isArray(rawValues) ? rawValues : [rawValues]) {
          const node = l as Record<string, unknown> | null;
          if (!node || typeof node !== "object" || Array.isArray(node) || !("mode" in node) || !Array.isArray(node.rules)) {
            throw new Error(`logical 条目必须包含 mode 与 rules 数组: ${JSON.stringify(l)}`);
          }
          (ast.logical ??= []).push(normalizeLogical(node));
        }
        continue;
      }
      if (!FIELD_ORDER.includes(key) && key !== "ip_asn") {
        throw new Error(`未知的规则字段: ${rawKey}（可用: ${[...FIELD_ORDER, "ip_asn", "logical"].join(", ")}）`);
      }
      for (const val of scalarList(rawKey, rawValues)) {
        if (key === "port" || key === "source_port") {
          const num = Number(val);
          if (!Number.isFinite(num)) throw new Error(`字段 ${rawKey} 必须是数字: ${JSON.stringify(val)}`);
          add(key, num);
        } else if (key === "port_range" || key === "source_port_range") {
          add(key, String(val).replace("-", ":"));
        } else add(key, String(val));
      }
    }
  }
  return ast;
}

/** 逻辑规则树 → Mihomo/Loon 的单行文本形态。 */
export function formatLogicalRule(r: Record<string, unknown>): string {
  const mode = String(r.mode ?? "and").toUpperCase();
  const children = ((r.rules as Record<string, unknown>[]) ?? []).map((sub) => {
    if ("mode" in sub) return `(${formatLogicalRule(sub)})`;
    const [k, v] = Object.entries(sub)[0];
    return `(${k.toUpperCase().replace(/_/g, "-")},${v})`;
  });
  return `${mode},(${children.join(",")})`;
}

/** sing-box 逻辑规则树：NOT 单子节点折叠为 invert，叶字段值转数组。 */
function singboxLogical(node: Record<string, unknown>): SingBoxRule {
  if ("mode" in node && Array.isArray(node.rules)) {
    if (node.mode === "not" && node.rules.length === 1) {
      const sub = singboxLogical(node.rules[0] as Record<string, unknown>);
      const nextInvert = !sub.invert;
      if (nextInvert) return { ...sub, invert: true };
      const copy = { ...sub };
      delete copy.invert;
      return copy;
    }
    return {
      type: "logical",
      mode: String(node.mode),
      rules: (node.rules as Record<string, unknown>[]).map(singboxLogical),
    };
  }
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, Array.isArray(v) ? v : [v]]));
}

/** 按字段表发射 sing-box 规则；ip_cidr 剥离 mihomo/Loon 专用的 no-resolve。 */
function singboxRules(ast: RuleAST, fields: readonly string[], dnsOnly: boolean): SingBoxRule[] {
  const rules: SingBoxRule[] = [];
  for (const field of fields) {
    const vals = ast[field as keyof RuleAST];
    if (!vals || vals.length === 0) continue;
    rules.push(
      field === "ip_cidr"
        ? { ip_cidr: (vals as string[]).map((v) => v.split(",")[0].trim()) }
        : { [field]: vals as JsonValue },
    );
  }
  for (const l of ast.logical ?? []) {
    if (!dnsOnly || dnsOnlyLogical(l)) rules.push(singboxLogical(l));
  }
  return rules;
}

export const emitSingbox = (ast: RuleAST): string => {
  if (ast.ip_asn?.length) console.warn(`WARN: IP-ASN 无法在 sing-box 规则集中表达，已忽略 ${ast.ip_asn.length} 条`);
  return `${JSON.stringify({ version: 3, rules: singboxRules(ast, FIELD_ORDER, false) }, null, 2)}\n`;
};

/** DNS 规则在拿到响应前只能按查询名判定，只保留域名字段。 */
export const emitSingboxDns = (ast: RuleAST): string =>
  `${JSON.stringify({ version: 3, rules: singboxRules(ast, DNS_RULE_FIELDS, true) }, null, 2)}\n`;

/** 逻辑树所有叶字段都属于 DNS 可判定字段（域名类）时为真。 */
function dnsOnlyLogical(node: Record<string, unknown>): boolean {
  if (Array.isArray(node.rules)) return (node.rules as Record<string, unknown>[]).every(dnsOnlyLogical);
  return Object.keys(node).every((k) => (DNS_RULE_FIELDS as readonly string[]).includes(k));
}

type EmitLine = [field: keyof RuleAST, format: (v: string | number) => string];
const CLASH_LINES: EmitLine[] = [
  ["domain_suffix", (v) => `DOMAIN-SUFFIX,${v}`],
  ["domain_keyword", (v) => `DOMAIN-KEYWORD,${v}`],
  ["domain", (v) => `DOMAIN,${v}`],
  ["domain_regex", (v) => `DOMAIN-REGEX,${v}`],
  ["process_name", (v) => `PROCESS-NAME,${v}`],
  ["ip_cidr", (v) => `IP-CIDR,${v}`],
  ["source_ip_cidr", (v) => `SRC-IP-CIDR,${v}`],
  ["ip_asn", (v) => `IP-ASN,${v}`],
  ["port", (v) => `DST-PORT,${v}`],
  ["port_range", (v) => `DST-PORT,${String(v).replace(":", "-")}`],
  ["source_port", (v) => `SRC-PORT,${v}`],
  ["source_port_range", (v) => `SRC-PORT,${String(v).replace(":", "-")}`],
  ["network", (v) => `NETWORK,${v}`],
];
/** Loon / Surge：DEST-PORT 拼写、连字符范围、IPv6 用 IP-CIDR6、协议大写。 */
const PLAIN_LINES: EmitLine[] = CLASH_LINES.map(([field, format]) =>
  field === "ip_cidr"
    ? [field, (v: string | number) => `${String(v).includes(":") ? "IP-CIDR6" : "IP-CIDR"},${v}`]
    : field === "port" || field === "port_range"
      ? [field, (v: string | number) => `DEST-PORT,${String(v).replace(":", "-")}`]
      : field === "network"
        ? [field, (v: string | number) => `PROTOCOL,${String(v).toUpperCase()}`]
        : [field, format],
);

export function emitClash(ast: RuleAST): string {
  const payload = emitLines(ast, CLASH_LINES);
  return payload.length > 0 ? `payload:\n${payload.map((line) => `  - '${line}'`).join("\n")}\n` : "payload: []\n";
}

export function emitPlain(ast: RuleAST): string {
  return `${emitLines(ast, PLAIN_LINES).join("\n")}\n`;
}

function emitLines(ast: RuleAST, table: EmitLine[]): string[] {
  const out: string[] = [];
  for (const [field, format] of table) {
    for (const v of ast[field] ?? []) out.push(format(v as string | number));
  }
  for (const l of ast.logical ?? []) out.push(formatLogicalRule(l));
  return out;
}

export const CLIENT_EMITTERS: Record<Client, (ast: RuleAST) => string> = {
  singbox: emitSingbox,
  clash: emitClash,
  plain: emitPlain,
};

function compileSrs(binary: string[], sourcePath: string, outputPath: string): void {
  mkdirSync(dirname(outputPath), { recursive: true });
  const proc = spawnSync(binary[0], [...binary.slice(1), "rule-set", "compile", "-o", outputPath, sourcePath], {
    encoding: "utf8",
  });
  if (proc.status !== 0) throw new Error(`sing-box 编译失败 ${sourcePath}: ${proc.stderr || proc.stdout}`);
}

/** 单条规则产出全部客户端产物；outDir 可注入临时目录用于测试。 */
export function buildOne(rule: Rule, binary: string[], outDir = GENERATED_DIR): Built[] {
  if (rule.kind === "url") return []; // 外部 .srs 由底模直接引用
  const name = rule.artifact;
  const results: Built[] = [];

  const mirrored = externalUrls(rule.source);
  if (mirrored) {
    for (const client of Object.keys(MIRROR_SUFFIXES) as Client[]) {
      const path = join(outDir, client, `${name}${MIRROR_SUFFIXES[client]}`);
      write(path, fetchBytes(mirrored[client]));
      results.push({ client, path, total: 0 });
    }
    // geosite 上游本就只含域名条目，-dns 伴生复用同一份 .srs；geoip 不产伴生（companion=false）
    if (rule.companion) {
      write(join(outDir, "singbox", `${name}-dns.srs`), fetchBytes(mirrored.singbox));
    }
    return results;
  }

  const ast = parseYamlAst(readFileSync(rule.path!, "utf8"));
  const total = Object.values(ast).reduce((n, v) => n + (Array.isArray(v) ? v.length : 0), 0);
  for (const client of Object.keys(CLIENT_EMITTERS) as Client[]) {
    const path = join(outDir, client, `${name}${SUFFIXES[client]}`);
    write(path, CLIENT_EMITTERS[client](ast));
    if (client === "singbox") compileSrs(binary, path, path.replace(/\.json$/, ".srs"));
    results.push({ client, path, total });
  }
  if (rule.companion) {
    const path = join(outDir, "singbox", `${name}-dns.json`);
    write(path, emitSingboxDns(ast));
    compileSrs(binary, path, path.replace(/\.json$/, ".srs"));
    results.push({ client: "singbox", path, total });
  }
  return results;
}

export function findRule(settings: Settings, target: string): Rule {
  const needle = target.toLowerCase();
  const hit = settings.rules.find((r) => r.name.toLowerCase() === needle || r.artifact.toLowerCase() === needle);
  if (!hit) throw new Error(`settings.yaml 里没有这个规则: ${target}`);
  return hit;
}

export function runBuild(options: { all?: boolean; tag?: string }): number {
  const settings = loadSettings(loadBase());
  const orphans = orphanCustomLists(settings.rules);
  if (orphans.length > 0) {
    console.warn(`WARN: 以下 custom/ 列表没有在 settings.yaml 引用，不会产出任何规则：\n  ${orphans.join("\n  ")}`);
  }

  const targets = options.all ? settings.rules : [findRule(settings, options.tag ?? "")];
  if (options.all) rmSync(GENERATED_DIR, { recursive: true, force: true });
  const binary = singBoxCommand();

  for (const rule of targets) {
    const built = buildOne(rule, binary);
    if (rule.kind === "url") console.log(`external ${rule.name} <- ${rule.source}（底模直接引用，不本地构建）`);
    else if (rule.kind === "local") console.log(`built ${rule.name} -> ${built.map((b) => `${b.client}=${b.total}`).join(", ")}`);
    else console.log(`mirrored ${rule.name} <- ${rule.source}`);
  }
  console.log(`done: built=${targets.length}`);
  return 0;
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  if (command !== "build" || (!rest.includes("--all") && !rest.some((a) => !a.startsWith("-")))) {
    console.error("用法: bun scripts/rules-compile.ts build --all | build <name>");
    process.exit(2);
  }
  process.exit(runBuild(rest.includes("--all") ? { all: true } : { tag: rest.find((a) => !a.startsWith("-")) }));
}
