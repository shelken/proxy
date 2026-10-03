#!/usr/bin/env bun
/**
 * 规则编译器：`config/rules/index.yaml` 清单 → 各客户端规则产物 + `sing-box` 二进制规则集。
 *
 * 三种产物形态，同一份源规则各自表达：
 *   - singbox  源规则 JSON，再用官方 `sing-box rule-set compile` 编成 `.srs`
 *   - clash    mihomo rule-provider 的 payload 文本
 *   - plain    原样文本，供 Loon / Surge 直接按 URL 引用
 *
 * 另有 `-dns` 伴生规则集：DNS 规则在拿到响应前只能按查询名判定，IP 类条目在 1.14 起废弃、
 * 1.16 移除，所以被 DNS 规则引用的清单要有一份只含域名条目的副本。
 *
 * 不做的事：不解析订阅、不装配节点（那是 sbtools 服务端的职责）、不写 template.json
 * （底模是手写的单一配置源，这里只校验它与清单是否漂移）。
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const MANIFEST_PATH = join(ROOT, "config/rules/index.yaml");
const GENERATED_DIR = join(ROOT, "config/rules/generated");
const TEMPLATE_PATH = join(ROOT, "config/sing-box/template.json");
const SING_GEOIP_PREFIX = "https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set";
const SING_GEOSITE_PREFIX =
  "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set";

const DNS_RULE_FIELDS = [
  "domain",
  "domain_suffix",
  "domain_keyword",
  "domain_regex",
] as const;
const DNS_SUFFIX = "-dns";
const ZONE_RULESET_TAG = "zone-internal";

/** 产物内规则字段的排序：域名类在前，过程/网络类在后，逻辑规则恒排最后。 */
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

const SUFFIXES: Record<Client, string> = {
  singbox: ".json",
  clash: ".yaml",
  plain: ".list",
};

export type Client = "singbox" | "clash" | "plain";

type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
export type SingBoxRule = Record<string, JsonValue>;

export interface Emission {
  text: string;
  skipped: string[];
  specialRefs: { kind: string; value: string }[];
}

export interface ManifestItem {
  tag: string;
  source: string;
}

export interface BuildResult {
  client: Client;
  path: string;
  total: number;
  skipped: number;
}

// ---------------------------------------------------------------- 源读取

/** 清单 source：http(s) 联网拉取，否则按仓库相对路径读本地文件。 */
function readSource(source: string): string {
  if (source.startsWith("http://") || source.startsWith("https://")) {
    const res = fetchSync(source);
    if (!res.ok) throw new Error(`拉取失败 ${res.status}: ${source}`);
    return res.text;
  }
  const path = join(ROOT, source);
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new Error(`规则源不存在: ${source}`);
  }
}

/** Bun 的同步 fetch：生成器要保持顺序执行，避免并发改写的复杂度。 */
function fetchSync(url: string): { ok: boolean; status: number; text: string } {
  const proc = spawnSync(
    "curl",
    ["-fsSL", "--max-time", "60", "-A", "singbox-rule-builder/2.0", url],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (proc.status !== 0) {
    return { ok: false, status: proc.status ?? 1, text: "" };
  }
  return { ok: true, status: 200, text: proc.stdout };
}

/** 下载上游预编译 .srs（GEOIP/GEOSITE 退化形态）。 */
function fetchBytes(url: string): Buffer {
  const proc = spawnSync(
    "curl",
    ["-fsSL", "--max-time", "60", "-A", "singbox-rule-builder/2.0", url],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  if (proc.status !== 0) throw new Error(`下载规则集失败: ${url}`);
  return proc.stdout;
}

/**
 * `custom/` 下存在但没被清单引用的列表。
 *
 * 只把文件放进 custom/ 不会产出任何规则：清单是唯一入口。这是最容易踩的坑
 * （加完文件以为 CI 会自己发现），所以显式提醒而不是静默忽略。
 */
export function orphanCustomLists(items: ManifestItem[]): string[] {
  const referenced = new Set(items.map((i) => i.source));
  const customDir = join(ROOT, "config/rules/custom");
  let entries: string[] = [];
  try {
    entries = readdirSync(customDir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith(".yaml") || name.endsWith(".yml") || name.endsWith(".list"))
    .map((name) => `config/rules/custom/${name}`)
    .filter((rel) => !referenced.has(rel))
    .sort();
}

/**
 * 解析清单 YAML：顶层是 `tag: source` 映射，注释与空行由 YAML 解析器处理。
 *
 * 纯数字 tag 在文件里须带引号，否则 YAML 解析成数字键——JS 对象键恒为字符串，
 * 这里不额外转换，由文件侧约定保证形态一致。
 */
export function loadManifest(path = MANIFEST_PATH): ManifestItem[] {
  const raw = readFileSync(path, "utf8");
  const parsed = Bun.YAML.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`清单必须是 tag: source 映射: ${path}`);
  }
  const items: ManifestItem[] = [];
  for (const [tag, source] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof source !== "string" || !source) {
      throw new Error(`清单项 ${tag} 的 source 必须是非空字符串`);
    }
    items.push({ tag, source });
  }
  return items;
}

/** 产物文件名：tag 直接作产物名，只做一次字符净化（tag 可能来自 URL 文件名）。 */
export function outputName(tag: string): string {
  const safe = tag.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return safe || "rule";
}

// ---------------------------------------------------------------- AST 统一解析

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
  raw_unsupported?: string[];
  special?: string[];
}

export function formatLogicalRule(r: Record<string, unknown>): string {
  const mode = String(r.mode ?? "and").toUpperCase();
  const children = ((r.rules as Record<string, unknown>[]) ?? []).map((sub) => {
    if ("mode" in sub) return `(${formatLogicalRule(sub)})`;
    const [k, v] = Object.entries(sub)[0];
    const type = k.toUpperCase().replace(/_/g, "-");
    return `(${type},${v})`;
  });
  return `${mode},(${children.join(",")})`;
}

export function parseSourceToAst(content: string, sourcePath?: string): {
  ast: RuleAST;
  specialRefs: { kind: string; value: string }[];
  skipped: string[];
} {
  const firstNonComment = content
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#"));

  const isRulesYaml = firstNonComment?.startsWith("rules:");
  const isPayloadYaml = firstNonComment === "payload:";
  const isYamlFile = sourcePath
    ? sourcePath.endsWith(".yaml") || sourcePath.endsWith(".yml")
    : false;

  const ast: RuleAST = {};
  const specialRefs: { kind: string; value: string }[] = [];
  const skipped: string[] = [];

  const add = (key: keyof RuleAST, val: unknown): void => {
    const target = (ast[key] ??= [] as unknown[]) as unknown[];
    if (!target.includes(val)) target.push(val);
  };

  // 1. 结构化 custom rules YAML
  if (isRulesYaml || (isYamlFile && !isPayloadYaml)) {
    const parsed = Bun.YAML.parse(content) as { rules?: Record<string, unknown>[] };
    for (const item of parsed?.rules ?? []) {
      for (const [rawKey, rawValues] of Object.entries(item)) {
        const key = rawKey.replace(/-/g, "_");
        if (key === "logical") {
          const list = Array.isArray(rawValues) ? rawValues : [rawValues];
          for (const l of list) {
            if (typeof l === "object" && l !== null) {
              (ast.logical ??= []).push(l as Record<string, unknown>);
            }
          }
          continue;
        }
        const values = Array.isArray(rawValues) ? rawValues : [rawValues];
        for (const val of values) {
          if (key === "port" || key === "source_port") {
            add(key, Number(val));
          } else if (key === "port_range" || key === "source_port_range") {
            add(key, String(val).replace("-", ":"));
          } else if (key === "ip_asn") {
            add("ip_asn", String(val));
          } else if (FIELD_ORDER.includes(key as keyof RuleAST)) {
            add(key as keyof RuleAST, String(val));
          } else {
            skipped.push(`${key},${val}`);
          }
        }
      }
    }
    return { ast, specialRefs, skipped };
  }

  // 2. 外部纯文本行或 Classical Payload
  let rawLines: string[] = [];
  if (isPayloadYaml) {
    const parsed = Bun.YAML.parse(content) as { payload?: string[] };
    rawLines = parsed?.payload ?? [];
  } else {
    rawLines = content.split("\n");
  }

  for (const rawLine of rawLines) {
    const stripped = rawLine.trim();
    if (!stripped || stripped.startsWith("#")) continue;

    if (!stripped.includes(",")) {
      if (stripped.startsWith(".")) add("domain_suffix", stripped.slice(1));
      else add("domain", stripped);
      continue;
    }

    if (/^(AND|OR|NOT),/i.test(stripped)) {
      const comma = stripped.indexOf(",");
      const mode = stripped.slice(0, comma).toLowerCase();
      const rest = stripped.slice(comma + 1);
      const subRules: Record<string, unknown>[] = [];
      const re = /\(([^()]+)\)/g;
      let m;
      while ((m = re.exec(rest)) !== null) {
        const [t, v] = m[1].split(",");
        if (t && v) {
          const k = t.trim().toLowerCase().replace(/-/g, "_");
          subRules.push({ [k]: v.trim() });
        }
      }
      if (subRules.length > 0) {
        (ast.logical ??= []).push({ mode, rules: subRules });
      } else {
        (ast.raw_unsupported ??= []).push(stripped);
        skipped.push(stripped);
      }
      continue;
    }

    const parts = stripped.split(",").map((s) => s.trim());
    const type = parts[0].toUpperCase();
    const val = parts[1];
    const extra = parts.slice(2).join(",");

    if (type === "GEOIP" || type === "GEOSITE") {
      specialRefs.push({ kind: type.toLowerCase(), value: val.toLowerCase() });
      (ast.special ??= []).push(stripped);
    } else if (type === "DOMAIN") add("domain", val);
    else if (type === "DOMAIN-SUFFIX") add("domain_suffix", val);
    else if (type === "DOMAIN-KEYWORD") add("domain_keyword", val);
    else if (type === "DOMAIN-REGEX") add("domain_regex", val);
    else if (type === "IP-CIDR" || type === "IP-CIDR6") add("ip_cidr", extra ? `${val},${extra}` : val);
    else if (type === "SRC-IP-CIDR") add("source_ip_cidr", val);
    else if (type === "IP-ASN") add("ip_asn", extra ? `${val},${extra}` : val);
    else if (type === "PROCESS-NAME") add("process_name", val);
    else if (type === "NETWORK") add("network", val);
    else if (type === "DST-PORT" || type === "DEST-PORT" || type === "PORT") {
      if (val.includes("-") || val.includes(":")) add("port_range", val.replace("-", ":"));
      else add("port", Number(val));
    } else if (type === "DST-PORT-RANGE" || type === "DEST-PORT-RANGE" || type === "PORT-RANGE") {
      add("port_range", val.replace("-", ":"));
    } else if (type === "SRC-PORT") {
      if (val.includes("-") || val.includes(":")) add("source_port_range", val.replace("-", ":"));
      else add("source_port", Number(val));
    } else if (type === "SRC-PORT-RANGE") {
      add("source_port_range", val.replace("-", ":"));
    } else {
      (ast.raw_unsupported ??= []).push(stripped);
      skipped.push(stripped);
    }
  }

  return { ast, specialRefs, skipped };
}

export function readRuleLines(content: string, sourcePath?: string): string[] {
  const { ast } = parseSourceToAst(content, sourcePath);
  return emitPlain(ast).text.split("\n").filter(Boolean);
}

export function normalizeRuleLines(text: string): string[] {
  const rawLines = text.split("\n");
  const firstNonComment = rawLines.map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
  if (firstNonComment === "payload:") {
    const parsed = Bun.YAML.parse(text) as { payload?: string[] };
    return parsed?.payload ?? [];
  }
  return rawLines.map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
}

export function parseYamlToRuleLines(yamlText: string): string[] {
  const { ast } = parseSourceToAst(yamlText, "custom.yaml");
  const lines: string[] = [];
  for (const d of ast.domain_suffix ?? []) lines.push(`DOMAIN-SUFFIX,${d}`);
  for (const d of ast.domain_keyword ?? []) lines.push(`DOMAIN-KEYWORD,${d}`);
  for (const d of ast.domain ?? []) lines.push(`DOMAIN,${d}`);
  for (const d of ast.domain_regex ?? []) lines.push(`DOMAIN-REGEX,${d}`);
  for (const p of ast.process_name ?? []) lines.push(`PROCESS-NAME,${p}`);
  for (const c of ast.ip_cidr ?? []) lines.push(`IP-CIDR,${c}`);
  for (const a of ast.ip_asn ?? []) lines.push(`IP-ASN,${a}`);
  for (const p of ast.port ?? []) lines.push(`DST-PORT,${p}`);
  for (const r of ast.port_range ?? []) lines.push(`DST-PORT-RANGE,${r}`);
  for (const l of ast.logical ?? []) lines.push(formatLogicalRule(l));
  return lines;
}

// ---------------------------------------------------------------- 各端纯净发射器

export type EmitterInput =
  | RuleAST
  | string[]
  | { ast: RuleAST; specialRefs?: { kind: string; value: string }[]; skipped?: string[] };

export function unpackInput(input: EmitterInput): {
  ast: RuleAST;
  specialRefs: { kind: string; value: string }[];
  skipped: string[];
} {
  if (Array.isArray(input)) {
    return parseSourceToAst(input.join("\n"));
  }
  if ("ast" in input && typeof input.ast === "object") {
    return {
      ast: input.ast,
      specialRefs: input.specialRefs ?? [],
      skipped: input.skipped ?? [],
    };
  }
  return {
    ast: input as RuleAST,
    specialRefs: [],
    skipped: [],
  };
}

export function emitSingbox(input: EmitterInput): Emission {
  const { ast, specialRefs, skipped } = unpackInput(input);

  const hasContentRules =
    FIELD_ORDER.some((f) => (ast[f as keyof RuleAST] as unknown[])?.length) ||
    (ast.logical?.length ?? 0) > 0;

  if (specialRefs.length > 0 && !hasContentRules) {
    return {
      text: `${JSON.stringify({
        version: 1,
        kind: "external_rule_set",
        references: specialRefs.map((ref) => ({
          type: ref.kind,
          value: ref.value,
          tag: `${ref.kind}-${ref.value}`,
          url: specialRefToUrl(ref),
        })),
      }, null, 2)}\n`,
      skipped: [],
      specialRefs,
    };
  }

  const rules: SingBoxRule[] = [];
  const finalSkipped = [...skipped];
  if (ast.ip_asn?.length) {
    for (const a of ast.ip_asn) finalSkipped.push(`IP-ASN,${a}`);
  }

  for (const field of FIELD_ORDER) {
    const vals = ast[field as keyof RuleAST];
    if (vals && vals.length > 0) {
      if (field === "ip_cidr") {
        rules.push({ [field]: (vals as string[]).map((v) => v.split(",")[0].trim()) });
      } else {
        rules.push({ [field]: vals as JsonValue });
      }
    }
  }
  function normalizeSingboxLogical(node: Record<string, unknown>): SingBoxRule {
    if ("mode" in node && Array.isArray(node.rules)) {
      if (node.mode === "not" && node.rules.length === 1) {
        const sub = normalizeSingboxLogical(node.rules[0] as Record<string, unknown>);
        const currentInvert = Boolean(sub.invert);
        return { ...sub, invert: !currentInvert };
      }
      return {
        type: "logical",
        mode: String(node.mode),
        rules: (node.rules as Record<string, unknown>[]).map(normalizeSingboxLogical),
      };
    }
    const res: SingBoxRule = {};
    for (const [k, v] of Object.entries(node)) {
      res[k] = (Array.isArray(v) ? v : [v]) as JsonValue;
    }
    return res;
  }

  for (const l of ast.logical ?? []) {
    rules.push(normalizeSingboxLogical(l));
  }
  return { text: `${JSON.stringify({ version: 3, rules }, null, 2)}\n`, skipped: finalSkipped, specialRefs };
}

export function emitSingboxDns(input: EmitterInput): Emission {
  const { ast, skipped } = unpackInput(input);

  const rules: SingBoxRule[] = [];
  for (const field of DNS_RULE_FIELDS) {
    const vals = ast[field as keyof RuleAST];
    if (vals && vals.length > 0) {
      rules.push({ [field]: vals as JsonValue });
    }
  }
  return { text: `${JSON.stringify({ version: 3, rules }, null, 2)}\n`, skipped, specialRefs: [] };
}

export function emitClash(input: EmitterInput): Emission {
  const { ast, skipped, specialRefs } = unpackInput(input);

  const payload: string[] = [];
  for (const d of ast.domain_suffix ?? []) payload.push(`DOMAIN-SUFFIX,${d}`);
  for (const d of ast.domain_keyword ?? []) payload.push(`DOMAIN-KEYWORD,${d}`);
  for (const d of ast.domain ?? []) payload.push(`DOMAIN,${d}`);
  for (const d of ast.domain_regex ?? []) payload.push(`DOMAIN-REGEX,${d}`);
  for (const p of ast.process_name ?? []) payload.push(`PROCESS-NAME,${p}`);
  for (const c of ast.ip_cidr ?? []) payload.push(`IP-CIDR,${c}`);
  for (const c of ast.source_ip_cidr ?? []) payload.push(`SRC-IP-CIDR,${c}`);
  for (const a of ast.ip_asn ?? []) payload.push(`IP-ASN,${a}`);
  for (const p of ast.port ?? []) payload.push(`DST-PORT,${p}`);
  for (const r of ast.port_range ?? []) payload.push(`DST-PORT,${r.replace(":", "-")}`);
  for (const p of ast.source_port ?? []) payload.push(`SRC-PORT,${p}`);
  for (const r of ast.source_port_range ?? []) payload.push(`SRC-PORT,${r.replace(":", "-")}`);
  for (const n of ast.network ?? []) payload.push(`NETWORK,${n}`);
  for (const s of ast.special ?? []) payload.push(s);
  for (const l of ast.logical ?? []) payload.push(formatLogicalRule(l));

  const text = payload.length > 0
    ? `payload:\n` + payload.map((line) => `  - '${line}'`).join("\n") + "\n"
    : "payload: []\n";
  return { text, skipped, specialRefs };
}

export function plainRuleLine(line: string): string {
  const stripped = line.trim();
  if (!stripped.includes(",")) return stripped;
  const parts = stripped.split(",");
  const ruleType = parts[0].trim().toUpperCase();
  const value = parts[1]?.trim() ?? "";
  const extra = parts.slice(2).join(",");

  const isDstPort =
    ruleType === "DST-PORT" ||
    ruleType === "DEST-PORT" ||
    ruleType === "PORT" ||
    ruleType === "DST-PORT-RANGE" ||
    ruleType === "DEST-PORT-RANGE" ||
    ruleType === "PORT-RANGE";

  if (isDstPort) {
    const portVal = value.replace(":", "-");
    return extra ? `DEST-PORT,${portVal},${extra}` : `DEST-PORT,${portVal}`;
  }
  if (ruleType === "SRC-PORT-RANGE" || ruleType === "SRC-PORT") {
    const portVal = value.replace(":", "-");
    return extra ? `SRC-PORT,${portVal},${extra}` : `SRC-PORT,${portVal}`;
  }
  if (ruleType === "IP-CIDR" && value.includes(":")) {
    return extra ? `IP-CIDR6,${value},${extra}` : `IP-CIDR6,${value}`;
  }
  return stripped;
}

export function emitPlain(input: EmitterInput): Emission {
  if (Array.isArray(input)) {
    const lines = input.map(plainRuleLine);
    return { text: `${lines.join("\n")}\n`, skipped: [], specialRefs: [] };
  }

  const { ast, skipped, specialRefs } = unpackInput(input);
  const lines: string[] = [];
  for (const d of ast.domain_suffix ?? []) lines.push(`DOMAIN-SUFFIX,${d}`);
  for (const d of ast.domain_keyword ?? []) lines.push(`DOMAIN-KEYWORD,${d}`);
  for (const d of ast.domain ?? []) lines.push(`DOMAIN,${d}`);
  for (const d of ast.domain_regex ?? []) lines.push(`DOMAIN-REGEX,${d}`);
  for (const p of ast.process_name ?? []) lines.push(`PROCESS-NAME,${p}`);
  for (const c of ast.ip_cidr ?? []) {
    lines.push(c.includes(":") ? `IP-CIDR6,${c}` : `IP-CIDR,${c}`);
  }
  for (const c of ast.source_ip_cidr ?? []) lines.push(`SRC-IP-CIDR,${c}`);
  for (const a of ast.ip_asn ?? []) lines.push(`IP-ASN,${a}`);
  for (const p of ast.port ?? []) lines.push(`DEST-PORT,${p}`);
  for (const r of ast.port_range ?? []) lines.push(`DEST-PORT,${r.replace(":", "-")}`);
  for (const p of ast.source_port ?? []) lines.push(`SRC-PORT,${p}`);
  for (const r of ast.source_port_range ?? []) lines.push(`SRC-PORT,${r.replace(":", "-")}`);
  for (const n of ast.network ?? []) lines.push(`NETWORK,${n}`);
  for (const l of ast.logical ?? []) lines.push(formatLogicalRule(l));
  for (const s of ast.special ?? []) lines.push(s);
  for (const u of ast.raw_unsupported ?? []) lines.push(u);

  return { text: `${lines.join("\n")}\n`, skipped, specialRefs };
}

export const CLIENT_EMITTERS: Record<Client, (input: EmitterInput) => Emission> = {
  singbox: emitSingbox,
  clash: emitClash,
  plain: emitPlain,
};

export function specialRefToUrl(ref: { kind: string; value: string }): string {
  const suffix = `${ref.kind}-${ref.value}.srs`;
  return ref.kind === "geoip"
    ? `${SING_GEOIP_PREFIX}/${suffix}`
    : `${SING_GEOSITE_PREFIX}/${suffix}`;
}

// ---------------------------------------------------------------- 模板契约

interface Template {
  route?: {
    rule_set?: { tag?: string }[];
    rules?: { rule_set?: string | string[]; action?: string; outbound?: string }[];
  };
  dns?: { rules?: { rule_set?: string | string[] }[] };
}

export function loadTemplate(): Template {
  return JSON.parse(readFileSync(TEMPLATE_PATH, "utf8")) as Template;
}

export function dnsRulesetName(name: string): string {
  return name + DNS_SUFFIX;
}

/**
 * 需要额外产出一份「只含域名条目」副本的产物名。
 *
 * 底模 DNS 规则引用到的清单必须都有域名版。底模内联声明的（zone-internal）不需要。
 */
export function dnsCompanionNames(template: Template, items: ManifestItem[]): string[] {
  const manifestNames = new Set<string>();
  for (const item of items) {
    manifestNames.add(outputName(item.tag));
    manifestNames.add(item.tag);
  }

  // 内联声明 = 底模里声明了、但不是清单产物的 tag（如 zone-internal）。
  // 清单产物及其 DNS 伴生都不算内联，否则伴生会被自己排除掉。
  const inline = new Set<string>([ZONE_RULESET_TAG]);
  for (const entry of template.route?.rule_set ?? []) {
    const tag = entry?.tag ? String(entry.tag) : "";
    if (tag && !manifestNames.has(tag) && !tag.endsWith(DNS_SUFFIX)) inline.add(tag);
  }

  const byOutput = new Map<string, ManifestItem>();
  for (const item of items) {
    byOutput.set(outputName(item.tag), item);
    if (!byOutput.has(item.tag)) byOutput.set(item.tag, item);
  }

  const names: string[] = [];
  for (const rule of template.dns?.rules ?? []) {
    const referenced = rule?.rule_set;
    const tags = typeof referenced === "string" ? [referenced] : (referenced ?? []);
    for (const raw of tags) {
      const tag = String(raw);
      const base = tag.endsWith(DNS_SUFFIX) ? tag.slice(0, -DNS_SUFFIX.length) : tag;
      const companion = dnsRulesetName(base);
      if (inline.has(tag) || names.includes(companion)) continue;
      if (!byOutput.has(base)) {
        throw new Error(
          `底模 DNS 规则引用了既不在清单里、也不是内联声明的规则集：${tag}`,
        );
      }
      names.push(companion);
    }
  }
  return names;
}

/**
 * 校验底模与清单是否漂移。这是底模那侧唯一被生成器触碰的地方。
 *
 * 不变量：底模 route.rule_set 声明的 tag 集合 == 清单 tag 集合 + DNS 伴生，
 * 且清单里每个 tag 都出现在 route.rules 里。任一处不一致都说明有人改了单边：
 * 模板声明了没构建的 .srs，内核启动即 FATAL。
 *
 * 路由去向（outbound）由底模单方面决定，不再与清单交叉校验——底模的手写分组
 * （多 tag 合组、顺序即优先级）无法由清单派生，硬校验只会逼出无意义的重复字段。
 *
 * 底模是手写单一配置源，这里只报错不改写。静默回写会覆盖手写意图
 * （如 `apple` 从 direct 聚合里拆出来独立成组）。
 */
export function validateTemplate(template: Template, items: ManifestItem[]): string[] {
  const errors: string[] = [];
  const manifestTags = new Set(items.map((i) => i.tag));
  // 先算伴生：它自身会对「DNS 规则引用清单外规则集」直接抛错，这属于配置错误。
  const companions = new Set(dnsCompanionNames(template, items));

  const declared = new Set<string>();
  for (const entry of template.route?.rule_set ?? []) {
    if (entry?.tag) declared.add(String(entry.tag));
  }

  const routed = new Map<string, string>();
  for (const rule of template.route?.rules ?? []) {
    const referenced = rule?.rule_set;
    if (!referenced) continue;
    const tags = typeof referenced === "string" ? [referenced] : referenced;
    const dest = rule.action === "reject" ? "reject" : String(rule.outbound ?? "");
    for (const tag of tags) routed.set(String(tag), dest);
  }

  for (const tag of manifestTags) {
    if (!declared.has(tag)) errors.push(`清单里的 ${tag} 未在底模 route.rule_set 声明`);
    if (!routed.has(tag)) errors.push(`清单里的 ${tag} 未出现在底模 route.rules`);
  }

  for (const companion of companions) {
    if (!declared.has(companion)) {
      errors.push(`DNS 伴生规则集 ${companion} 未在底模 route.rule_set 声明`);
    }
    if (routed.has(companion)) {
      errors.push(`DNS 伴生规则集 ${companion} 不应参与路由，却被 route.rules 引用`);
    }
  }

  for (const tag of declared) {
    if (!manifestTags.has(tag) && !companions.has(tag)) {
      errors.push(`底模声明了 ${tag}，但它既不在清单里也不是 DNS 伴生`);
    }
  }
  return errors;
}

// ---------------------------------------------------------------- 构建

export function ensureSingBox(): string {
  const which = spawnSync("sh", ["-c", "command -v sing-box"], { encoding: "utf8" });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();

  // 开发机上 sing-box 常由 mise 安装而不在 PATH 上
  const home = process.env.HOME ?? "";
  const installRoot = join(home, ".local/share/mise/installs/sing-box");
  const ls = spawnSync("sh", ["-c", `ls -1 '${installRoot}' 2>/dev/null | sort -Vr`], {
    encoding: "utf8",
  });
  for (const version of (ls.stdout ?? "").split("\n").filter(Boolean)) {
    const candidate = join(installRoot, version, "sing-box");
    if (spawnSync("sh", ["-c", `test -x '${candidate}'`]).status === 0) return candidate;
  }
  throw new Error(
    "找不到 sing-box 可执行文件（编译 .srs 需要它；可用 mise install 安装）",
  );
}

export function compileSrs(binary: string, sourcePath: string, outputPath: string): void {
  mkdirSync(dirname(outputPath), { recursive: true });
  const proc = spawnSync(binary, ["rule-set", "compile", "-o", outputPath, sourcePath], {
    encoding: "utf8",
  });
  if (proc.status !== 0) {
    throw new Error(`sing-box 编译失败 ${sourcePath}: ${proc.stderr || proc.stdout}`);
  }
}

function writeText(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

/** 为单个 tag 产出全部客户端产物。 */
export function buildOne(
  item: ManifestItem,
  binary: string,
  dnsCompanion: boolean,
): BuildResult[] {
  const rawSource = readSource(item.source);
  const { ast, specialRefs, skipped } = parseSourceToAst(rawSource, item.source);
  const name = outputName(item.tag);
  const results: BuildResult[] = [];
  const totalCount = Object.values(ast).reduce(
    (acc, v) => acc + (Array.isArray(v) ? v.length : 0),
    0,
  );

  for (const client of Object.keys(CLIENT_EMITTERS) as Client[]) {
    const emission = CLIENT_EMITTERS[client]({ ast, specialRefs, skipped });
    const path = join(GENERATED_DIR, client, `${name}${SUFFIXES[client]}`);
    writeText(path, emission.text);

    if (client === "singbox") {
      const srs = path.replace(/\.json$/, ".srs");
      if (emission.specialRefs.length === 1) {
        writeFileSync(srs, fetchBytes(specialRefToUrl(emission.specialRefs[0])));
      } else if (emission.specialRefs.length > 1) {
        throw new Error(`${item.tag}: 暂不支持同时引用多个 GEOIP/GEOSITE 规则集`);
      } else {
        compileSrs(binary, path, srs);
      }
    }

    const report = join(GENERATED_DIR, "unsupported", client, `${name}.txt`);
    if (emission.skipped.length > 0) {
      writeText(report, `${emission.skipped.join("\n")}\n`);
    } else {
      rmSync(report, { force: true });
    }
    results.push({
      client,
      path,
      total: totalCount,
      skipped: emission.skipped.length,
    });
  }

  if (dnsCompanion) {
    const dns = emitSingboxDns(ast);
    const dnsPath = join(GENERATED_DIR, "singbox", `${dnsRulesetName(name)}.json`);
    writeText(dnsPath, dns.text);
    compileSrs(binary, dnsPath, dnsPath.replace(/\.json$/, ".srs"));
    results.push({ client: "singbox", path: dnsPath, total: totalCount, skipped: 0 });
  }
  return results;
}

function jsonPretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export interface BuildOptions {
  all?: boolean;
  tag?: string;
  manifest?: string;
}

export function runBuild(options: BuildOptions): number {
  const items = loadManifest(options.manifest ?? MANIFEST_PATH);
  const template = loadTemplate();

  const orphans = orphanCustomLists(items);
  if (orphans.length > 0) {
    console.warn(
      `WARN: 以下 custom/ 列表没有被 index.yaml 引用，不会产出任何规则：\n  ${orphans.join("\n  ")}`,
    );
  }

  const drift = validateTemplate(template, items);
  if (drift.length > 0) {
    for (const err of drift) console.error(`ERROR: ${err}`);
    return 1;
  }

  const targets = options.all ? items : [findItem(items, options.tag ?? "")];

  if (options.all) rmSync(GENERATED_DIR, { recursive: true, force: true });
  const binary = ensureSingBox();

  let built = 0;
  for (const item of targets) {
    // 每个 tag 都产出 `-dns` 伴生，而不是只产底模引用到的那几个：
    // 设备 overlay 的运行期引用无法在构建期枚举，缺哪份都会让内核启动 FATAL。
    // 底模仍只需声明自己真正引用的伴生，校验语义（validateTemplate）不变。
    const results = buildOne(item, binary, true);
    const parts = results.map((r) => `${r.client}=${r.total - r.skipped}/${r.total}`);
    console.log(`built ${item.tag} -> ${parts.join(", ")}`);
    built++;
  }

  const reports = listReports();
  if (reports.length > 0) {
    console.log(`skipped reports (${reports.length}):`);
    for (const r of reports) console.log(`  ${r}`);
  }
  console.log(`done: built=${built}, dns_companions=${built}`);
  return 0;
}

function listReports(): string[] {
  const out: string[] = [];
  const root = join(GENERATED_DIR, "unsupported");
  const walk = (dir: string): void => {
    const proc = spawnSync("sh", ["-c", `ls -1d '${dir}'/* 2>/dev/null`], { encoding: "utf8" });
    const entries = (proc.stdout ?? "").split("\n").filter(Boolean).sort().reverse();
    for (const entry of entries) {
      if (entry.endsWith(".txt")) out.push(entry.replace(`${ROOT}/`, ""));
      else walk(entry);
    }
  };
  walk(root);
  return out.sort();
}

export function findItem(items: ManifestItem[], target: string): ManifestItem {
  const needle = target.toLowerCase();
  const hit = items.find(
    (i) => i.tag.toLowerCase() === needle || outputName(i.tag).toLowerCase() === needle,
  );
  if (!hit) throw new Error(`清单里没有这个 tag: ${target}`);
  return hit;
}

// ---------------------------------------------------------------- CLI

function usage(): string {
  return [
    "rules-compile — 规则清单 → 各端产物",
    "",
    "用法:",
    "  bun scripts/rules-compile.ts build --all              全量构建",
    "  bun scripts/rules-compile.ts build <tag>              只构建单个 tag",
    "  bun scripts/rules-compile.ts convert --input <文件|-> --client <singbox|clash|plain> [--output <文件|->] [--dns-only] [--report <文件>]",
    "  bun scripts/rules-compile.ts check                    只校验底模与清单有无漂移",
  ].join("\n");
}

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function cmdConvert(args: string[]): number {
  const input = argValue(args, "--input");
  const client = argValue(args, "--client") as Client | undefined;
  if (!input || !client) {
    console.error(usage());
    return 2;
  }
  if (!["singbox", "clash", "plain"].includes(client)) {
    console.error(`未知客户端: ${client}`);
    return 2;
  }

  const raw = input === "-" ? readFileSync(0, "utf8") : readFileSync(input, "utf8");
  const parsed = parseSourceToAst(raw, input === "-" ? undefined : input);
  const dnsOnly = args.includes("--dns-only");
  const emission = dnsOnly ? emitSingboxDns(parsed) : CLIENT_EMITTERS[client](parsed);

  const output = argValue(args, "--output") ?? "-";
  if (output === "-") process.stdout.write(emission.text);
  else writeText(resolve(output), emission.text);

  const report = argValue(args, "--report");
  if (report) writeText(resolve(report), `${emission.skipped.join("\n")}\n`);
  return 0;
}

function cmdBuild(args: string[]): number {
  const manifest = argValue(args, "--manifest");
  if (args.includes("--all")) return runBuild({ all: true, manifest });
  const tag = args.find((a) => !a.startsWith("-") && a !== "build");
  if (!tag) {
    console.error(usage());
    return 2;
  }
  return runBuild({ tag, manifest });
}

function cmdCheck(): number {
  const items = loadManifest();
  const orphans = orphanCustomLists(items);
  for (const rel of orphans) {
    console.warn(`WARN: ${rel} 没有被 index.yaml 引用，不会产出任何规则`);
  }
  const errors = validateTemplate(loadTemplate(), items);
  if (errors.length === 0) {
    console.log(`清单与底模一致：${items.length} 个 tag`);
    return 0;
  }
  for (const err of errors) console.error(`ERROR: ${err}`);
  return 1;
}

function main(): number {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "build":
      return cmdBuild(rest);
    case "convert":
      return cmdConvert(rest);
    case "check":
      return cmdCheck();
    default:
      console.error(usage());
      return 2;
  }
}

if (import.meta.main) process.exit(main());
