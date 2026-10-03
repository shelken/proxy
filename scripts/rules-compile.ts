#!/usr/bin/env bun
/**
 * 规则编译器：`config/rules/index.yaml` 清单 → 各客户端规则产物。
 *
 * 两种源、各自最短路径：
 *   - geosite:x / geoip:x  外部原生引用：直接下载 MetaCubeX/meta-rules-dat 的
 *                          三端同源产物（.srs / mihomo yaml / .list），零解析。
 *   - custom/*.yaml        内部结构化规则：YAML → AST → 三端发射，
 *                          sing-box 端再经官方 `rule-set compile` 编成 .srs。
 *
 * 另有 `-dns` 伴生规则集：DNS 规则在拿到响应前只能按查询名判定，IP 类条目在
 * 1.14 起废弃、1.16 移除，所以被 DNS 规则引用的清单要有一份只含域名条目的副本。
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

const META_RULES_SING = "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo";
const META_RULES_MIHOMO = "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo";

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

/** 下载远端产物（文本或二进制）。生成器保持顺序执行，避免并发改写的复杂度。 */
function fetchBytes(url: string): Buffer {
  const proc = spawnSync(
    "curl",
    ["-fsSL", "--max-time", "60", "-A", "singbox-rule-builder/2.0", url],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  if (proc.status !== 0) throw new Error(`下载失败: ${url}`);
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

// ---------------------------------------------------------------- 源解析

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

/** 外部原生引用：geosite:x / geoip:x → meta-rules-dat 三端同源 URL。 */
export function externalUrls(source: string): Record<Client, string> | null {
  const m = source.match(/^(geosite|geoip):([a-z0-9_-]+)$/);
  if (!m) return null;
  const [, kind, name] = m;
  return {
    singbox: `${META_RULES_SING}/${kind}/${name}.srs`,
    clash: `${META_RULES_MIHOMO}/${kind}/${name}.yaml`,
    plain: `${META_RULES_MIHOMO}/${kind}/${name}.list`,
  };
}

/**
 * 内部 custom YAML → AST。未知字段直接抛错（fail fast）：
 * 结构化源的形态应该确定，静默跳过等于悄悄丢规则。
 */
export function parseYamlAst(content: string): RuleAST {
  const parsed = Bun.YAML.parse(content) as { rules?: Record<string, unknown>[] } | null;
  const ast: RuleAST = {};
  const add = (key: keyof RuleAST, val: unknown): void => {
    const target = (ast[key] ??= [] as unknown[]) as unknown[];
    if (!target.includes(val)) target.push(val);
  };

  for (const item of parsed?.rules ?? []) {
    for (const [rawKey, rawValues] of Object.entries(item)) {
      const key = rawKey.replace(/-/g, "_");
      if (key === "logical") {
        for (const l of Array.isArray(rawValues) ? rawValues : [rawValues]) {
          if (typeof l === "object" && l !== null) (ast.logical ??= []).push(l as Record<string, unknown>);
        }
        continue;
      }
      if (!FIELD_ORDER.includes(key as keyof RuleAST) && key !== "ip_asn") {
        throw new Error(
          `未知的规则字段: ${rawKey}（可用: ${[...FIELD_ORDER, "ip_asn", "logical"].join(", ")}）`,
        );
      }
      for (const val of Array.isArray(rawValues) ? rawValues : [rawValues]) {
        if (key === "port" || key === "source_port") add(key, Number(val));
        else if (key === "port_range" || key === "source_port_range") add(key, String(val).replace("-", ":"));
        else add(key, String(val));
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
    const type = k.toUpperCase().replace(/_/g, "-");
    return `(${type},${v})`;
  });
  return `${mode},(${children.join(",")})`;
}

// ---------------------------------------------------------------- 各端发射器（内部 AST 专用）

/** sing-box 逻辑规则树规范化：NOT 单子节点折叠为 invert，叶字段值转数组。 */
function normalizeSingboxLogical(node: Record<string, unknown>): SingBoxRule {
  if ("mode" in node && Array.isArray(node.rules)) {
    if (node.mode === "not" && node.rules.length === 1) {
      const sub = normalizeSingboxLogical(node.rules[0] as Record<string, unknown>);
      const nextInvert = !sub.invert;
      if (nextInvert) return { ...sub, invert: true };
      const copy = { ...sub };
      delete copy.invert;
      return copy;
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

export function emitSingbox(ast: RuleAST): string {
  const rules: SingBoxRule[] = [];
  // sing-box 1.12 起移除行内 IP-ASN 匹配，只能放弃并提示（mihomo/Loon 端仍保留）
  if (ast.ip_asn?.length) {
    console.warn(`WARN: IP-ASN 无法在 sing-box 规则集中表达，已忽略 ${ast.ip_asn.length} 条`);
  }

  for (const field of FIELD_ORDER) {
    const vals = ast[field as keyof RuleAST];
    if (vals && vals.length > 0) {
      if (field === "ip_cidr") {
        // 剥离 mihomo/Loon 专用的 no-resolve 选项，sing-box 规则集无此概念
        rules.push({ [field]: (vals as string[]).map((v) => v.split(",")[0].trim()) });
      } else {
        rules.push({ [field]: vals as JsonValue });
      }
    }
  }
  for (const l of ast.logical ?? []) {
    rules.push(normalizeSingboxLogical(l));
  }
  return `${JSON.stringify({ version: 3, rules }, null, 2)}\n`;
}

/** 只保留按查询名匹配的字段，产出 DNS 规则专用的规则集。 */
export function emitSingboxDns(ast: RuleAST): string {
  const rules: SingBoxRule[] = [];
  for (const field of DNS_RULE_FIELDS) {
    const vals = ast[field as keyof RuleAST];
    if (vals && vals.length > 0) {
      rules.push({ [field]: vals as JsonValue });
    }
  }
  return `${JSON.stringify({ version: 3, rules }, null, 2)}\n`;
}

export function emitClash(ast: RuleAST): string {
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
  for (const l of ast.logical ?? []) payload.push(formatLogicalRule(l));

  return payload.length > 0
    ? `payload:\n${payload.map((line) => `  - '${line}'`).join("\n")}\n`
    : "payload: []\n";
}

/** Loon / Surge 文本产物：DEST-PORT 拼写、连字符端口范围、IPv6 用 IP-CIDR6。 */
export function emitPlain(ast: RuleAST): string {
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
  return `${lines.join("\n")}\n`;
}

export const CLIENT_EMITTERS: Record<Client, (ast: RuleAST) => string> = {
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

function writeBytes(path: string, data: Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

function writeText(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function readLocalSource(source: string): string {
  try {
    return readFileSync(join(ROOT, source), "utf8");
  } catch {
    throw new Error(`规则源不存在: ${source}`);
  }
}

/** 为单个 tag 产出全部客户端产物：外部镜像下载或内部 AST 发射。 */
export function buildOne(
  item: ManifestItem,
  binary: string,
  dnsCompanion: boolean,
): BuildResult[] {
  const name = outputName(item.tag);
  const ext = externalUrls(item.source);
  const results: BuildResult[] = [];

  // 外部原生引用：三端直接下载同源产物，零解析、零编译
  if (ext) {
    const srsPath = join(GENERATED_DIR, "singbox", `${name}.srs`);
    writeBytes(srsPath, fetchBytes(ext.singbox));
    results.push({ client: "singbox", path: srsPath, total: 0, skipped: 0 });
    for (const client of ["clash", "plain"] as const) {
      const path = join(GENERATED_DIR, client, `${name}${SUFFIXES[client]}`);
      writeBytes(path, fetchBytes(ext[client]));
      results.push({ client, path, total: 0, skipped: 0 });
    }
    if (dnsCompanion) {
      // geosite 上游本就只含域名条目，-dns 伴生直接复用同一份 .srs
      const dnsPath = join(GENERATED_DIR, "singbox", `${dnsRulesetName(name)}.srs`);
      writeBytes(dnsPath, fetchBytes(ext.singbox));
      results.push({ client: "singbox", path: dnsPath, total: 0, skipped: 0 });
    }
    return results;
  }

  // 内部 custom YAML → AST → 三端发射
  const ast = parseYamlAst(readLocalSource(item.source));
  const totalCount = Object.values(ast).reduce(
    (acc, v) => acc + (Array.isArray(v) ? v.length : 0),
    0,
  );

  for (const client of Object.keys(CLIENT_EMITTERS) as Client[]) {
    const path = join(GENERATED_DIR, client, `${name}${SUFFIXES[client]}`);
    writeText(path, CLIENT_EMITTERS[client](ast));
    if (client === "singbox") {
      compileSrs(binary, path, path.replace(/\.json$/, ".srs"));
    }
    results.push({ client, path, total: totalCount, skipped: 0 });
  }

  if (dnsCompanion) {
    // 每个 tag 都产出 `-dns` 伴生：设备 overlay 的运行期引用无法在构建期枚举，
    // 缺哪份都会让内核启动 FATAL。底模仍只需声明自己真正引用的伴生。
    const dnsPath = join(GENERATED_DIR, "singbox", `${dnsRulesetName(name)}.json`);
    writeText(dnsPath, emitSingboxDns(ast));
    compileSrs(binary, dnsPath, dnsPath.replace(/\.json$/, ".srs"));
    results.push({ client: "singbox", path: dnsPath, total: totalCount, skipped: 0 });
  }
  return results;
}

export interface BuildOptions {
  all?: boolean;
  tag?: string;
}

export function runBuild(options: BuildOptions): number {
  const items = loadManifest();
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
    const results = buildOne(item, binary, true);
    if (externalUrls(item.source)) {
      console.log(`mirrored ${item.tag} <- ${item.source}`);
    } else {
      const parts = results.map((r) => `${r.client}=${r.total}`);
      console.log(`built ${item.tag} -> ${parts.join(", ")}`);
    }
    built++;
  }
  console.log(`done: built=${built}`);
  return 0;
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
    "  bun scripts/rules-compile.ts build --all    全量构建",
    "  bun scripts/rules-compile.ts build <tag>    只构建单个 tag",
    "  bun scripts/rules-compile.ts check          只校验底模与清单有无漂移",
  ].join("\n");
}

function cmdBuild(args: string[]): number {
  if (args.includes("--all")) return runBuild({ all: true });
  const tag = args.find((a) => !a.startsWith("-") && a !== "build");
  if (!tag) {
    console.error(usage());
    return 2;
  }
  return runBuild({ tag });
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
    case "check":
      return cmdCheck();
    default:
      console.error(usage());
      return 2;
  }
}

if (import.meta.main) process.exit(main());
