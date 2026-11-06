#!/usr/bin/env bun
/**
 * 规则编译器：`config/sing-box/settings.yaml` 的规则来源 → 各客户端产物。
 *
 * 两种源、各自最短路径：
 *   - geosite:x / geoip:x  外部原生引用：直接下载 MetaCubeX/meta-rules-dat 的
 *                          三端同源产物（.srs / mihomo yaml / .list），零解析。
 *   - 本地 *.yaml          内部结构化规则：YAML → AST → 三端发射，
 *                          sing-box 端再经官方 `rule-set compile` 编成 .srs。
 *
 * 另有 `-dns` 伴生规则集：DNS 规则在拿到响应前只能按查询名判定，IP 类条目在
 * 1.14 起废弃、1.16 移除，所以被 DNS 规则引用的清单要有一份只含域名条目的副本。
 *
 * 外部 .srs（http/https 来源）由底模直接远程引用，这里不反编译、不产三端产物。
 *
 * 不做的事：不解析订阅、不装配节点（那是 sbtools 服务端的职责）、不写 template*.json
 * （底模由 scripts/build-config.ts 生成，settings 与底模同源，不存在清单漂移）。
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const SETTINGS_PATH = join(ROOT, "config/sing-box/settings.yaml");
const GENERATED_DIR = join(ROOT, "config/rules/generated");
const CUSTOM_DIR = join(ROOT, "config/rules/custom");

const META_RULES_SING = "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo";
const META_RULES_MIHOMO = "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo";

const DNS_RULE_FIELDS = [
  "domain",
  "domain_suffix",
  "domain_keyword",
  "domain_regex",
] as const;
const DNS_SUFFIX = "-dns";

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

export interface RuleSource {
  tag: string;
  source: string;
}

export interface BuildResult {
  client: Client;
  path: string;
  total: number;
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

/** 外部原生 .srs：底模直接远程引用，不经本地编译。 */
export const isExternalUrl = (source: string): boolean => /^https?:\/\//.test(source);

/**
 * `custom/` 下存在但没被 settings 引用的列表。
 *
 * 只把文件放进 custom/ 不会产出任何规则：settings.yaml 的 rules 是唯一入口。
 * 这是最容易踩的坑（加完文件以为 CI 会自己发现），所以显式提醒而不是静默忽略。
 */
export function orphanCustomLists(items: RuleSource[]): string[] {
  const referenced = new Set(items.map((i) => basename(i.source)));
  let entries: string[] = [];
  try {
    entries = readdirSync(CUSTOM_DIR);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith(".yaml") || name.endsWith(".yml") || name.endsWith(".list"))
    .filter((name) => !referenced.has(name))
    .map((name) => `config/rules/custom/${name}`)
    .sort();
}

/** 读取 settings.yaml 的 rules：只取编译需要的 tag 与来源。 */
export function loadRules(path = SETTINGS_PATH): RuleSource[] {
  const parsed = Bun.YAML.parse(readFileSync(path, "utf8")) as { rules?: unknown };
  if (!Array.isArray(parsed?.rules)) {
    throw new Error(`settings.yaml 缺少 rules 列表: ${path}`);
  }
  return parsed.rules.map((value) => {
    const r = value as { name?: unknown; source?: unknown };
    if (typeof r?.name !== "string" || !r.name) throw new Error(`settings.yaml 有规则缺少 name`);
    if (typeof r.source !== "string" || !r.source) throw new Error(`规则 ${r.name} 缺少 source`);
    return { tag: r.name, source: r.source };
  });
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
  const parsed = Bun.YAML.parse(content) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("rules YAML 顶层必须是对象（rules: [...]）");
  }
  const { rules } = parsed as { rules?: unknown };
  if (!Array.isArray(rules)) {
    throw new Error("rules YAML 缺少 rules: 列表（或形态不是数组）");
  }
  const ast: RuleAST = {};
  const add = (key: keyof RuleAST, val: unknown): void => {
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
          if (node === null || typeof node !== "object" || Array.isArray(node) || !("mode" in node) || !Array.isArray(node.rules)) {
            throw new Error(`logical 条目必须包含 mode 与 rules 数组: ${JSON.stringify(l)}`);
          }
          (ast.logical ??= []).push(normalizeLogical(node));
        }
        continue;
      }
      if (!FIELD_ORDER.includes(key as keyof RuleAST) && key !== "ip_asn") {
        throw new Error(
          `未知的规则字段: ${rawKey}（可用: ${[...FIELD_ORDER, "ip_asn", "logical"].join(", ")}）`,
        );
      }
      for (const val of scalarList(rawKey, rawValues)) {
        if (key === "port" || key === "source_port") {
          const num = Number(val);
          if (!Number.isFinite(num)) throw new Error(`字段 ${rawKey} 必须是数字: ${JSON.stringify(val)}`);
          add(key, num);
        } else if (key === "port_range" || key === "source_port_range") {
          add(key, String(val).replace("-", ":"));
        } else {
          add(key, String(val));
        }
      }
    }
  }
  return ast;
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

/**
 * 校验 logical 子树：键名归一化，叶节点必须是白名单内的单字段标量。
 * 多字段与数组叶子未被任何规则使用，且端上方言展开语义复杂，明确拒绝而非静默畸形输出。
 */
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
    if (!FIELD_ORDER.includes(k as keyof RuleAST)) throw new Error(`logical 未知字段: ${keys[0]}`);
    const vals = scalarList(keys[0], child[keys[0]]);
    if (vals.length !== 1) throw new Error(`logical 叶节点值必须是单个标量: ${JSON.stringify(child)}`);
    return { [k]: vals[0] };
  });
  return { mode: node.mode, rules };
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
  // 叶子全为域名字段的逻辑树在 DNS 阶段同样按查询名可判定，保留；混合树无法部分重写
  for (const l of ast.logical ?? []) {
    if (dnsOnlyLogical(l)) rules.push(normalizeSingboxLogical(l));
  }
  return `${JSON.stringify({ version: 3, rules }, null, 2)}\n`;
}

/** 逻辑树所有叶字段都属于 DNS 可判定字段（域名类）时为真。 */
function dnsOnlyLogical(node: Record<string, unknown>): boolean {
  if (Array.isArray(node.rules)) {
    return (node.rules as Record<string, unknown>[]).every(dnsOnlyLogical);
  }
  return Object.keys(node).every((k) => (DNS_RULE_FIELDS as readonly string[]).includes(k));
}

type EmitLine = [field: keyof RuleAST, format: (v: string | number) => string];

/** Mihomo / Loon 的字段展开表：同一套顺序，只是行的拼写不同。 */
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

const PLAIN_LINES: EmitLine[] = CLASH_LINES.map(
  ([field, format]): EmitLine =>
    field === "ip_cidr"
      ? [field, (v) => `${String(v).includes(":") ? "IP-CIDR6" : "IP-CIDR"},${v}`]
      : field === "port" || field === "port_range"
        ? [field, (v) => `DEST-PORT,${String(v).replace(":", "-")}`]
        : field === "network"
          ? [field, (v) => `PROTOCOL,${String(v).toUpperCase()}`]
          : [field, format],
);

function emitLines(ast: RuleAST, table: EmitLine[]): string[] {
  const out: string[] = [];
  for (const [field, format] of table) {
    for (const v of ast[field] ?? []) out.push(format(v as string | number));
  }
  for (const l of ast.logical ?? []) out.push(formatLogicalRule(l));
  return out;
}

export function emitClash(ast: RuleAST): string {
  const payload = emitLines(ast, CLASH_LINES);
  return payload.length > 0
    ? `payload:\n${payload.map((line) => `  - '${line}'`).join("\n")}\n`
    : "payload: []\n";
}

/** Loon / Surge 文本产物：DEST-PORT 拼写、连字符端口范围、IPv6 用 IP-CIDR6。 */
export function emitPlain(ast: RuleAST): string {
  return `${emitLines(ast, PLAIN_LINES).join("\n")}\n`;
}

export const CLIENT_EMITTERS: Record<Client, (ast: RuleAST) => string> = {
  singbox: emitSingbox,
  clash: emitClash,
  plain: emitPlain,
};

// ---------------------------------------------------------------- 构建

export function dnsRulesetName(name: string): string {
  return name + DNS_SUFFIX;
}

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

/** 本地来源相对 settings.yaml 解析，不依赖调用者 cwd。 */
function readLocalSource(source: string): string {
  const path = isAbsolute(source) ? source : resolve(dirname(SETTINGS_PATH), source);
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new Error(`规则源不存在: ${source}`);
  }
}

/** 为单个 tag 产出全部客户端产物：外部镜像下载或内部 AST 发射。 */
export function buildOne(
  item: RuleSource,
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
    results.push({ client: "singbox", path: srsPath, total: 0 });
    for (const client of ["clash", "plain"] as const) {
      const path = join(GENERATED_DIR, client, `${name}${SUFFIXES[client]}`);
      writeBytes(path, fetchBytes(ext[client]));
      results.push({ client, path, total: 0 });
    }
    if (dnsCompanion && item.source.startsWith("geosite:")) {
      // geosite 上游本就只含域名条目，-dns 伴生直接复用同一份 .srs；
      // geoip 是 IP 集合，DNS 规则无法按查询名判定，不产 -dns 伴生
      const dnsPath = join(GENERATED_DIR, "singbox", `${dnsRulesetName(name)}.srs`);
      writeBytes(dnsPath, fetchBytes(ext.singbox));
      results.push({ client: "singbox", path: dnsPath, total: 0 });
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
    results.push({ client, path, total: totalCount });
  }

  if (dnsCompanion) {
    // 每个 tag 都产出 `-dns` 伴生：设备 overlay 的运行期引用无法在构建期枚举，
    // 缺哪份都会让内核启动 FATAL。底模仍只需声明自己真正引用的伴生。
    const dnsPath = join(GENERATED_DIR, "singbox", `${dnsRulesetName(name)}.json`);
    writeText(dnsPath, emitSingboxDns(ast));
    compileSrs(binary, dnsPath, dnsPath.replace(/\.json$/, ".srs"));
    results.push({ client: "singbox", path: dnsPath, total: totalCount });
  }
  return results;
}

export interface BuildOptions {
  all?: boolean;
  tag?: string;
}

export function runBuild(options: BuildOptions): number {
  const items = loadRules();

  const orphans = orphanCustomLists(items);
  if (orphans.length > 0) {
    console.warn(
      `WARN: 以下 custom/ 列表没有在 settings.yaml 引用，不会产出任何规则：\n  ${orphans.join("\n  ")}`,
    );
  }

  const targets = options.all ? items : [findRule(items, options.tag ?? "")];

  if (options.all) rmSync(GENERATED_DIR, { recursive: true, force: true });
  const binary = ensureSingBox();

  let built = 0;
  for (const item of targets) {
    if (isExternalUrl(item.source)) {
      console.log(`external ${item.tag} <- ${item.source}（底模直接引用，不本地构建）`);
      built++;
      continue;
    }
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

export function findRule(items: RuleSource[], target: string): RuleSource {
  const needle = target.toLowerCase();
  const hit = items.find(
    (i) => i.tag.toLowerCase() === needle || outputName(i.tag).toLowerCase() === needle,
  );
  if (!hit) throw new Error(`settings.yaml 里没有这个规则: ${target}`);
  return hit;
}

// ---------------------------------------------------------------- CLI

function usage(): string {
  return [
    "rules-compile — settings.yaml 的规则来源 → 各端产物",
    "",
    "用法:",
    "  bun scripts/rules-compile.ts build --all    全量构建",
    "  bun scripts/rules-compile.ts build <name>   只构建单条规则",
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

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  if (command !== "build") {
    console.error(usage());
    process.exit(2);
  }
  process.exit(cmdBuild(rest));
}
