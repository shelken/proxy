#!/usr/bin/env bun
/**
 * 规则编译器：`config/rules/index.txt` 清单 → 各客户端规则产物 + `sing-box` 二进制规则集。
 *
 * 三种产物形态，同一份源规则各自表达：
 *   - singbox  源规则 JSON，再用官方 `sing-box rule-set compile` 编成 `.srs`
 *   - clash    mihomo rule-provider 的 payload 文本
 *   - plain    原样文本，供 Loon / Surge 直接按 URL 引用
 *
 * 另有 `-dns` 伴生规则集：DNS 规则在拿到响应前只能按查询名判定，IP 类条目在 1.14 起废弃、
 * 1.16 移除，所以被 DNS 规则引用的清单要有一份只含域名条目的副本。
 *
 * 不做的事：不解析订阅、不装配节点（那是 sb-sync 服务端的职责）、不写 template.json
 * （底模是手写的单一配置源，这里只校验它与清单是否漂移）。
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const MANIFEST_PATH = join(ROOT, "config/rules/index.txt");
const GENERATED_DIR = join(ROOT, "config/rules/generated");
const TEMPLATE_PATH = join(ROOT, "config/sing-box/template.json");
const REMOTE_BASE =
  "https://raw.githubusercontent.com/shelken/proxy/sing-box-rules";
const SING_GEOIP_PREFIX = "https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set";
const SING_GEOSITE_PREFIX =
  "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set";

/** 源语法 → sing-box 字段。未列出的类型一律跳过并记录。 */
const SUPPORTED_FIELDS: Record<string, string> = {
  DOMAIN: "domain",
  "DOMAIN-SUFFIX": "domain_suffix",
  "DOMAIN-KEYWORD": "domain_keyword",
  "DOMAIN-REGEX": "domain_regex",
  "IP-CIDR": "ip_cidr",
  "IP-CIDR6": "ip_cidr",
  "SRC-IP-CIDR": "source_ip_cidr",
  "SRC-PORT": "source_port",
  "DST-PORT": "port",
  "DEST-PORT": "port",
  PORT: "port",
  "PROCESS-NAME": "process_name",
  NETWORK: "network",
};

/**
 * sing-box 路由没有对应表达、只能跳过的类型。
 *
 * USER-AGENT / URL-REGEX：单靠 TLS 嗅探拿不到这两个维度。
 * IP-ASN / SRC-GEOIP / SRC-IP-ASN：geoip 族行内匹配已在 1.12.0 移除，源侧无等价表达。
 * IN-PORT：sing-box 用 inbound tag 区分入口，不是端口号。
 * PROTOCOL：Loon 取值（TCP/UDP/QUIC/HTTP）与 sing-box 的 protocol/network 两套语义交叉，
 *           无法一一映射，宁可跳过也不猜。
 *
 * GEOIP / GEOSITE 不在此列：整份列表只剩这类引用时，退化为对上游预编译规则集的引用。
 */
const UNSUPPORTED_TYPES = new Set([
  "USER-AGENT",
  "URL-REGEX",
  "IP-ASN",
  "SRC-GEOIP",
  "SRC-IP-ASN",
  "IN-PORT",
  "PROTOCOL",
]);

/** mihomo 的 classical provider 能原生吃下这些行。 */
const CLASH_SUPPORTED = new Set([
  ...Object.keys(SUPPORTED_FIELDS),
  "IP-ASN",
  "GEOIP",
  "GEOSITE",
  "SRC-GEOIP",
  "SRC-IP-ASN",
  "SRC-IP-SUFFIX",
  "IP-SUFFIX",
  "AND",
  "OR",
  "NOT",
]);

/** Loon 用 DEST-PORT，mihomo 用 DST-PORT，同一语义两种拼写。 */
const CLASH_RENAMES: Record<string, string> = { "DEST-PORT": "DST-PORT" };

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
  "source_port",
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
  policy: string;
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
    .filter((name) => name.endsWith(".list"))
    .map((name) => `config/rules/custom/${name}`)
    .filter((rel) => !referenced.has(rel))
    .sort();
}

export function loadManifest(path = MANIFEST_PATH): ManifestItem[] {
  const items: ManifestItem[] = [];
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split("|").map((p) => p.trim());
    if (parts.length !== 3) {
      throw new Error(`清单行格式错误（应为 tag|policy|source）: ${line}`);
    }
    const [tag, policy, source] = parts;
    if (!tag || !policy || !source) {
      throw new Error(`清单行有空字段: ${line}`);
    }
    items.push({ tag, policy, source });
  }
  return items;
}

/** 产物文件名：tag 直接作产物名，只做一次字符净化（tag 可能来自 URL 文件名）。 */
export function outputName(tag: string): string {
  const safe = tag.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return safe || "rule";
}

// ---------------------------------------------------------------- 归一化

/**
 * provider 的 YAML payload 形态：只取 `payload:` 列表里的条目。
 * 上游 blackmatrix7 的 Clash 列表就是这个格式。
 */
function parsePayloadYaml(lines: string[]): string[] {
  const payload: string[] = [];
  let inPayload = false;
  for (const rawLine of lines) {
    const stripped = rawLine.trim();
    if (!stripped || stripped.startsWith("#")) continue;
    if (stripped === "payload:") {
      inPayload = true;
      continue;
    }
    if (!inPayload) continue;
    if (rawLine.replace(/^\s+/, "").startsWith("- ")) {
      payload.push(
        rawLine
          .replace(/^\s+/, "")
          .slice(2)
          .trim()
          .replace(/^['"]|['"]$/g, ""),
      );
      continue;
    }
    // payload 段结束：遇到一个顶格的新键
    if (!rawLine.startsWith(" ")) break;
  }
  return payload;
}

/** 去掉注释与空行，并把 YAML payload 还原成纯规则行。 */
export function normalizeRuleLines(text: string): string[] {
  const rawLines = text.split("\n");
  const firstNonComment = rawLines
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#"));
  if (firstNonComment === "payload:") return parsePayloadYaml(rawLines);

  const lines: string[] = [];
  for (const rawLine of rawLines) {
    const stripped = rawLine.trim();
    if (!stripped || stripped.startsWith("#")) continue;
    lines.push(stripped);
  }
  return lines;
}

// ---------------------------------------------------------------- 解析

/** 剥掉最外层括号，但仅当它真的包住整串（`(a),(b)` 不能剥）。 */
export function stripOuterParens(text: string): string {
  const stripped = text.trim();
  if (!stripped.startsWith("(") || !stripped.endsWith(")")) return stripped;
  let depth = 0;
  for (let i = 0; i < stripped.length; i++) {
    if (stripped[i] === "(") depth++;
    else if (stripped[i] === ")") {
      depth--;
      if (depth === 0 && i !== stripped.length - 1) return stripped;
    }
  }
  return stripped.slice(1, -1).trim();
}

/** 按顶层逗号切分，括号内的逗号不算。 */
export function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  for (const char of text) {
    if (char === "," && depth === 0) {
      const part = current.trim();
      if (part) parts.push(part);
      current = "";
      continue;
    }
    if (char === "(") depth++;
    else if (char === ")") depth--;
    current += char;
  }
  const tail = current.trim();
  if (tail) parts.push(tail);
  return parts;
}

type Classified =
  | { kind: "rule"; field: string; value: string | number }
  | { kind: "special"; ref: { kind: string; value: string } }
  | { kind: "unsupported" };

/**
 * 判定一行源规则。
 *
 * 省略写法：`.domain.com` 等同 DOMAIN-SUFFIX，裸域名等同 DOMAIN。
 * 这在 Surge/Loon 的列表里很常见（如 Apple_Domain.list）。
 */
export function classifySimpleRule(line: string): Classified {
  const stripped = line.trim();
  if (!stripped.includes(",")) {
    if (stripped.startsWith(".")) {
      return { kind: "rule", field: "domain_suffix", value: stripped.slice(1) };
    }
    return { kind: "rule", field: "domain", value: stripped };
  }

  const parts = stripped.split(",").map((p) => p.trim());
  if (parts.length < 2) return { kind: "unsupported" };
  const ruleType = parts[0].toUpperCase();
  const value = parts[1];

  if (ruleType === "GEOIP" || ruleType === "GEOSITE") {
    return { kind: "special", ref: { kind: ruleType.toLowerCase(), value: value.toLowerCase() } };
  }
  if (UNSUPPORTED_TYPES.has(ruleType)) return { kind: "unsupported" };

  const field = SUPPORTED_FIELDS[ruleType];
  if (!field) return { kind: "unsupported" };

  if (field === "port" || field === "source_port") {
    const port = Number.parseInt(value, 10);
    if (!Number.isFinite(port)) return { kind: "unsupported" };
    return { kind: "rule", field, value: port };
  }
  return { kind: "rule", field, value };
}

export function specialRefToUrl(ref: { kind: string; value: string }): string {
  const suffix = `${ref.kind}-${ref.value}.srs`;
  return ref.kind === "geoip"
    ? `${SING_GEOIP_PREFIX}/${suffix}`
    : `${SING_GEOSITE_PREFIX}/${suffix}`;
}

export interface ConvertResult {
  rules: SingBoxRule[];
  specialRefs: { kind: string; value: string }[];
  unsupported: string[];
}

/**
 * 源规则行 → sing-box 源规则集 rules。
 *
 * 同字段的值合并进一条规则（内核语义相同，合并后体积更小）。
 * GEOIP/GEOSITE 单独收集：整份列表只有它们时退化为上游预编译规则集的引用。
 */
export function convertRuleLines(ruleLines: string[]): ConvertResult {
  // 字段名来自固定表，值去重要保序：Record 做字段表，Set 做值集合（都是插入序）。
  const grouped: Record<string, Set<string>> = {};
  const logicalRules: SingBoxRule[] = [];
  const specialRefs: { kind: string; value: string }[] = [];
  const unsupported: string[] = [];

  const addValue = (field: string, value: string): void => {
    (grouped[field] ??= new Set()).add(value);
  };

  for (const line of ruleLines) {
    const stripped = line.trim();
    if (/^(AND|OR|NOT),/i.test(stripped)) {
      const parsed = parseLogicalRule(stripped);
      if (parsed.rule) logicalRules.push(parsed.rule);
      unsupported.push(...parsed.unsupported);
      continue;
    }

    const classified = classifySimpleRule(stripped);
    if (classified.kind === "unsupported") {
      unsupported.push(stripped);
      continue;
    }
    if (classified.kind === "special") {
      specialRefs.push(classified.ref);
      continue;
    }
    addValue(classified.field, String(classified.value));
  }

  const rules: SingBoxRule[] = [];
  for (const [field, values] of Object.entries(grouped)) {
    const list: JsonValue[] =
      field === "port" || field === "source_port"
        ? [...values].map((v) => Number.parseInt(v, 10))
        : [...values];
    rules.push({ [field]: list });
  }
  rules.push(...logicalRules);
  return { rules, specialRefs, unsupported: [...new Set(unsupported)].sort() };
}

interface LogicalParse {
  rule: SingBoxRule | null;
  unsupported: string[];
}

/** `AND,(...),(...)` / `OR,(...)` / `NOT,(...)`，子表达式可嵌套。 */
export function parseLogicalRule(line: string): LogicalParse {
  const comma = line.indexOf(",");
  const op = line.slice(0, comma).toUpperCase();
  // 括号有两种形态，都要能吃下：
  //   AND,(a),(b)      → 顶层逗号直接切
  //   AND,((a),(OR,...)) → 多包了一层，先剥掉才能按顶层逗号切
  // NOT 的子表达式同理，但它只有一个，剥不剥都能交给 parseRuleExpression。
  const rest = stripOuterParens(line.slice(comma + 1).trim());
  const unsupported: string[] = [];

  if (op === "AND" || op === "OR") {
    const parts = splitTopLevel(rest);
    const children: SingBoxRule[] = [];
    for (const part of parts) {
      const child = parseRuleExpression(stripOuterParens(part));
      unsupported.push(...child.unsupported);
      if (!child.rule) {
        unsupported.push(line);
        return { rule: null, unsupported: [...new Set(unsupported)].sort() };
      }
      children.push(child.rule);
    }
    return {
      rule: { type: "logical", mode: op.toLowerCase(), rules: children },
      unsupported: [...new Set(unsupported)].sort(),
    };
  }

  if (op === "NOT") {
    const child = parseRuleExpression(rest);
    unsupported.push(...child.unsupported);
    if (!child.rule) {
      unsupported.push(line);
      return { rule: null, unsupported: [...new Set(unsupported)].sort() };
    }
    return {
      rule: { ...child.rule, invert: true },
      unsupported: [...new Set(unsupported)].sort(),
    };
  }

  return { rule: null, unsupported: [line] };
}

function parseRuleExpression(line: string): LogicalParse {
  const stripped = line.trim();
  if (/^(AND|OR|NOT),/i.test(stripped)) return parseLogicalRule(stripped);
  const classified = classifySimpleRule(stripped);
  if (classified.kind !== "rule") return { rule: null, unsupported: [stripped] };
  return { rule: { [classified.field]: [classified.value] }, unsupported: [] };
}

/** 把 rules 按字段稳定排序后包成源规则集文档。 */
export function toSourceJson(rules: SingBoxRule[]): { version: number; rules: SingBoxRule[] } {
  // 字段排序只影响「单字段规则」的相对位置；带 type/invert 等结构字段的规则
  // （logical、invert）没有可排序的字段名，必须原样保留在末位。
  const isPlainFieldRule = (rule: SingBoxRule): boolean =>
    !("type" in rule) && !("invert" in rule) && Object.keys(rule).length === 1;

  const ordered: SingBoxRule[] = [];
  for (const field of FIELD_ORDER) {
    for (const rule of rules) {
      if (isPlainFieldRule(rule) && field in rule) ordered.push(rule);
    }
  }
  for (const rule of rules) {
    if (!isPlainFieldRule(rule)) ordered.push(rule);
  }
  return { version: 3, rules: ordered };
}

// ---------------------------------------------------------------- 各端产物

export function emitSingbox(ruleLines: string[]): Emission {
  const { rules, specialRefs, unsupported } = convertRuleLines(ruleLines);
  // 整份列表只有 GEOIP/GEOSITE 时，行内表达为空 → 退化为对上游预编译规则集的引用
  if (specialRefs.length > 0 && rules.length === 0 && unsupported.length === 0) {
    return {
      text: `${jsonPretty({
        version: 1,
        kind: "external_rule_set",
        references: specialRefs.map((ref) => ({
          type: ref.kind,
          value: ref.value,
          tag: `${ref.kind}-${ref.value}`,
          url: specialRefToUrl(ref),
        })),
      })}\n`,
      skipped: [],
      specialRefs,
    };
  }
  return { text: `${jsonPretty(toSourceJson(rules))}\n`, skipped: unsupported, specialRefs };
}

/** 只保留按查询名匹配的字段，产出 DNS 规则专用的规则集。 */
export function emitSingboxDns(ruleLines: string[], label = ""): Emission {
  const base = emitSingbox(ruleLines);
  const payload = JSON.parse(base.text) as {
    kind?: string;
    rules?: SingBoxRule[];
  };
  // 纯 GEOIP/GEOSITE 列表退化成 external_rule_set 形态，没有可过滤的 rules，
  // 与「没有域名条目」是同一个结局：产不出 DNS 版。
  const rules = payload.kind === "external_rule_set" ? [] : (payload.rules ?? []);

  const kept: SingBoxRule[] = [];
  for (const rule of rules) {
    const domainFields: SingBoxRule = {};
    for (const field of DNS_RULE_FIELDS) {
      if (field in rule) domainFields[field] = rule[field];
    }
    if (Object.keys(domainFields).length > 0) kept.push(domainFields);
  }
  if (kept.length === 0) {
    // 抄一份没有域名条目的列表进 DNS 规则，等于把废弃写法再写一遍，宁可构建失败。
    throw new Error(
      `${label || "规则集"}里没有域名类条目，生成不出 DNS 规则用的规则集`,
    );
  }
  return { text: `${jsonPretty(toSourceJson(kept))}\n`, skipped: base.skipped, specialRefs: [] };
}

/** 一行源规则 → mihomo classical provider 的行；无法表达时返回 null。 */
export function clashRuleLine(stripped: string): string | null {
  if (!stripped.includes(",")) {
    return stripped.startsWith(".")
      ? `DOMAIN-SUFFIX,${stripped.slice(1)}`
      : `DOMAIN,${stripped}`;
  }
  const ruleType = stripped.split(",", 1)[0].trim().toUpperCase();
  if (!CLASH_SUPPORTED.has(ruleType)) return null;
  const renamed = CLASH_RENAMES[ruleType] ?? ruleType;
  return renamed + stripped.slice(ruleType.length);
}

export function emitClash(ruleLines: string[]): Emission {
  const kept: string[] = [];
  const skipped: string[] = [];
  for (const line of ruleLines) {
    const stripped = line.trim();
    if (!stripped) continue;
    const converted = clashRuleLine(stripped);
    if (converted === null) {
      skipped.push(stripped);
      continue;
    }
    kept.push(converted);
  }
  const body = kept.map((line) => `  - '${line}'`).join("\n");
  return { text: kept.length > 0 ? `payload:\n${body}\n` : "payload: []\n", skipped, specialRefs: [] };
}

/** Loon / Surge 的行格式与源格式一致，原样输出。 */
export function emitPlain(ruleLines: string[]): Emission {
  return { text: `${ruleLines.join("\n")}\n`, skipped: [], specialRefs: [] };
}

export const CLIENT_EMITTERS: Record<Client, (lines: string[]) => Emission> = {
  singbox: emitSingbox,
  clash: emitClash,
  plain: emitPlain,
};

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
 * 两点必须一致，任一处不一致都说明有人改了单边：
 *   1. 底模 route.rule_set 声明的 tag 集合 == 清单 tag 集合 + DNS 伴生
 *   2. 底模 route.rules 里每个 tag 的去向 == 清单 policy 列
 *
 * 底模是手写单一配置源，这里只报错不改写。静默回写会覆盖手写意图
 * （如 `apple` 从 direct 聚合里拆出来独立成组）。
 */
export function validateTemplate(template: Template, items: ManifestItem[]): string[] {
  const errors: string[] = [];
  const expectedPolicies = new Map(items.map((i) => [i.tag, i.policy]));
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

  for (const [tag, policy] of expectedPolicies) {
    if (!declared.has(tag)) errors.push(`清单里的 ${tag} 未在底模 route.rule_set 声明`);
    const actual = routed.get(tag);
    if (actual === undefined) {
      errors.push(`清单里的 ${tag} 未出现在底模 route.rules`);
    } else if (actual !== policy) {
      errors.push(
        `清单与底模路由不一致：${tag} 清单写 policy=${policy}，底模路由到 ${actual}`,
      );
    }
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
    if (!expectedPolicies.has(tag) && !companions.has(tag)) {
      errors.push(`底模声明了 ${tag}，但它既不在清单里也不是 DNS 伴生`);
    }
  }
  return errors;
}

// ---------------------------------------------------------------- 索引 / 路由片段

export function buildIndex(items: ManifestItem[]): unknown {
  return {
    version: 2,
    entries: items.map((item) => {
      const name = outputName(item.tag);
      const paths: Record<string, string> = {};
      const remoteUrls: Record<string, string> = {};
      for (const client of Object.keys(SUFFIXES) as Client[]) {
        const suffix = SUFFIXES[client];
        paths[client] = `config/rules/generated/${client}/${name}${suffix}`;
        remoteUrls[client] = `${REMOTE_BASE}/${client}/${name}${suffix}`;
      }
      return {
        tag: item.tag,
        policy: item.policy,
        source: item.source,
        output_name: name,
        local_source: !item.source.startsWith("http"),
        paths,
        remote_urls: remoteUrls,
      };
    }),
  };
}

/**
 * 发布分支用的路由片段：声明全部远端 rule_set 并按 policy 分组下发路由。
 *
 * 与底模的 route 段同构，供不克隆本仓库的用户直接引用。policy 分组的顺序按清单首次
 * 出现顺序稳定排列，保证同一份清单每次产出相同。
 */
export function buildRemoteRouteset(items: ManifestItem[], companions: string[]): unknown {
  const byPolicy = new Map<string, string[]>();
  for (const item of items) {
    const bucket = byPolicy.get(item.policy) ?? [];
    bucket.push(item.tag);
    byPolicy.set(item.policy, bucket);
  }

  const rules: unknown[] = [];
  for (const [policy, tags] of byPolicy) {
    const sorted = [...tags].sort();
    rules.push(
      policy === "reject"
        ? { rule_set: sorted, action: "reject" }
        : { rule_set: sorted, action: "route", outbound: policy },
    );
  }

  const ruleSetEntry = (name: string): Record<string, string> => ({
    type: "remote",
    tag: name,
    format: "binary",
    url: `${REMOTE_BASE}/singbox/${name}.srs`,
    update_interval: "1d",
  });

  const declared = [...items]
    .sort((a, b) => outputName(a.tag).localeCompare(outputName(b.tag)))
    .map((item) => ruleSetEntry(outputName(item.tag)));
  declared.push(...companions.map(ruleSetEntry));

  return { route: { rule_set: declared, rules } };
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
  const ruleLines = normalizeRuleLines(readSource(item.source));
  const name = outputName(item.tag);
  const results: BuildResult[] = [];

  for (const client of Object.keys(CLIENT_EMITTERS) as Client[]) {
    const emission = CLIENT_EMITTERS[client](ruleLines);
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
      total: ruleLines.length,
      skipped: emission.skipped.length,
    });
  }

  if (dnsCompanion) {
    const dns = emitSingboxDns(ruleLines, item.tag);
    const dnsPath = join(GENERATED_DIR, "singbox", `${dnsRulesetName(name)}.json`);
    writeText(dnsPath, dns.text);
    compileSrs(binary, dnsPath, dnsPath.replace(/\.json$/, ".srs"));
    results.push({ client: "singbox", path: dnsPath, total: ruleLines.length, skipped: 0 });
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
      `WARN: 以下 custom/ 列表没有被 index.txt 引用，不会产出任何规则：\n  ${orphans.join("\n  ")}`,
    );
  }

  const drift = validateTemplate(template, items);
  if (drift.length > 0) {
    for (const err of drift) console.error(`ERROR: ${err}`);
    return 1;
  }

  // companions 里是伴生名（ChinaMax-dns），buildOne 需要按基础名判断
  const companions = new Set(dnsCompanionNames(template, items));
  const targets = options.all ? items : [findItem(items, options.tag ?? "")];

  if (options.all) rmSync(GENERATED_DIR, { recursive: true, force: true });
  const binary = ensureSingBox();

  let built = 0;
  for (const item of targets) {
    const needsDns = companions.has(dnsRulesetName(outputName(item.tag)));
    const results = buildOne(item, binary, needsDns);
    const parts = results.map((r) => `${r.client}=${r.total - r.skipped}/${r.total}`);
    console.log(`built ${item.tag} -> ${parts.join(", ")}, policy=${item.policy}`);
    built++;
  }

  if (options.all) {
    writeText(
      join(GENERATED_DIR, "index.json"),
      `${jsonPretty(buildIndex(items))}\n`,
    );
    writeText(
      join(GENERATED_DIR, "45-ruleset-remote.json"),
      `${jsonPretty(buildRemoteRouteset(items, [...companions]))}\n`,
    );
  }

  const reports = listReports();
  if (reports.length > 0) {
    console.log(`skipped reports (${reports.length}):`);
    for (const r of reports) console.log(`  ${r}`);
  }
  console.log(`done: built=${built}, dns_companions=${companions.size}`);
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
    "  bun scripts/rules-compile.ts build --all              全量构建并写 index.json",
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
  const lines = normalizeRuleLines(raw);
  const dnsOnly = args.includes("--dns-only");
  const emission = dnsOnly ? emitSingboxDns(lines) : CLIENT_EMITTERS[client](lines);

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
    console.warn(`WARN: ${rel} 没有被 index.txt 引用，不会产出任何规则`);
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
