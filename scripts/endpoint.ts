#!/usr/bin/env bun
/**
 * 端点核心：单 URL 契约（`sub` / `node` / `dns` / `zone`）→ 完整 sing-box 配置。
 *
 * 契约来自 Issue #8／#13：零上传、零会话、零留存。底模随仓库提供，协议解析交给
 * sublink-worker 容器，最终装配（底模 + 节点 + 9 个策略组）由本文件完成。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";

const SUBLINK_IMAGE = "ghcr.io/7sageer/sublink-worker:latest"; // 实测运行时版本 v2.4.2
const CONTAINER_NAME = "proxy-sublink";
const SUBLINK_PORT = Number(process.env.SUBLINK_PORT ?? 8787);
const SUBLINK_URL = `http://127.0.0.1:${SUBLINK_PORT}`;
const ROOT_DIR = resolve(import.meta.dir, "..");
const TEMPLATE_PATH = resolve(ROOT_DIR, "config/sing-box/template.json");

export interface OutboundNode {
  type: string;
  tag: string;
  server?: string;
  server_port?: number;
  password?: string;
  obfs?: {
    type: string;
    password?: string;
  };
  tls?: {
    enabled: boolean;
    server_name?: string;
    insecure?: boolean;
  };
  outbounds?: string[];
  default?: string;
  [key: string]: unknown;
}

export interface SingBoxTemplate {
  inbounds?: OutboundNode[];
  dns?: {
    servers?: Array<{ tag: string; server?: string; [key: string]: unknown }>;
    rules?: Array<{ [key: string]: unknown }>;
    strategy?: string;
    [key: string]: unknown;
  };
  route?: {
    rules?: Array<{ [key: string]: unknown }>;
    rule_set?: Array<{ tag: string; rules?: unknown; [key: string]: unknown }>;
    [key: string]: unknown;
  };
  outbounds?: OutboundNode[];
  [key: string]: unknown;
}

export interface BuildConfigInput {
  source?: string;
  sub?: string;
  nodes?: Array<string | OutboundNode>;
  dns?: string;
  zone?: string;
}

export interface BuildDeps {
  parse?: (source: string) => Promise<OutboundNode[]>;
  template?: SingBoxTemplate;
}

/** 出站里非实体节点的类型：解析后端返回的分组与内置出站，装配时一律丢弃。 */
export const NON_NODE_TYPES = new Set<string>([
  "selector",
  "urltest",
  "direct",
  "block",
  "dns",
]);

function loadTemplate(): SingBoxTemplate {
  return JSON.parse(readFileSync(TEMPLATE_PATH, "utf-8")) as SingBoxTemplate;
}

/** 底模 route.rules 引用的出站标签，节点名撞上时必须让位。 */
export const RESERVED_TAGS: string[] = (loadTemplate().outbounds ?? []).map((o) => o.tag);

/** 主分组之外的分流分组：默认跟随主分组，成员里排上全部节点。 */
export const POLICY_GROUPS: string[] = RESERVED_TAGS.filter(
  (tag) => tag !== "direct" && tag !== "proxy",
);

export function parseHysteria2(raw: string): OutboundNode {
  const u = new URL(raw);
  const tag = decodeURIComponent(u.hash ? u.hash.slice(1) : "SelfHost");
  const auth = decodeURIComponent(u.username || u.password || "");
  const port = u.port ? parseInt(u.port, 10) : 443;
  const sni = u.searchParams.get("sni") || u.hostname;
  const insecure = u.searchParams.get("insecure") === "1";
  const obfsType = u.searchParams.get("obfs");
  const obfsPassword = u.searchParams.get("obfs-password");

  const outbound: OutboundNode = {
    type: "hysteria2",
    tag,
    server: u.hostname,
    server_port: port,
    password: auth,
    tls: {
      enabled: true,
      server_name: sni,
      insecure,
    },
  };
  if (obfsType) {
    outbound.obfs = {
      type: obfsType,
      password: obfsPassword || "",
    };
  }
  return outbound;
}

export function parseNodeUri(uri: unknown): OutboundNode | null {
  if (typeof uri !== "string") return null;
  const trimmed = uri.trim();
  if (trimmed.startsWith("hysteria2://") || trimmed.startsWith("hy2://")) {
    return parseHysteria2(trimmed);
  }
  return null;
}

export function findSingBox(): string {
  if (process.env.SING_BOX) return process.env.SING_BOX;
  const which = Bun.which("sing-box");
  if (which) return which;
  const installDir = `${homedir()}/.local/share/mise/installs/sing-box`;
  try {
    const versions = readdirSync(installDir).sort().reverse();
    for (const version of versions) {
      const binary = `${installDir}/${version}/sing-box`;
      if (existsSync(binary)) return binary;
    }
  } catch {}
  return "sing-box";
}

async function isSublinkReady(): Promise<boolean> {
  try {
    const res = await fetch(`${SUBLINK_URL}/`, {
      signal: AbortSignal.timeout(1000),
    });
    return res.status < 500;
  } catch {
    return false;
  }
}

/** 解析后端就绪：复用已在运行的容器，否则按固定镜像拉起并等它就绪。 */
export async function ensureSublink(): Promise<void> {
  const running = Bun.spawnSync([
    "docker",
    "ps",
    "-q",
    "-f",
    `name=^/${CONTAINER_NAME}$`,
  ]).stdout.toString().trim();

  if (running && (await isSublinkReady())) return;

  console.log(`[sublink] 启动解析后端 ${SUBLINK_IMAGE}（端口 ${SUBLINK_PORT}）`);
  Bun.spawnSync(["docker", "rm", "-f", CONTAINER_NAME]);
  const run = Bun.spawnSync([
    "docker",
    "run",
    "-d",
    "--name",
    CONTAINER_NAME,
    "-p",
    `${SUBLINK_PORT}:8787`,
    "--rm",
    SUBLINK_IMAGE,
  ]);
  if (run.exitCode !== 0) {
    throw new Error(`启动 sublink 容器失败：${run.stderr.toString().trim()}`);
  }
  for (let i = 0; i < 20; i++) {
    await Bun.sleep(500);
    if (await isSublinkReady()) return;
  }
  throw new Error("等待 sublink 容器就绪超时（10s）");
}

/**
 * 交给解析后端取出实体节点出站。
 */
export async function parseViaSublink(source: string): Promise<OutboundNode[]> {
  await ensureSublink();
  const url = new URL(`${SUBLINK_URL}/singbox`);
  url.searchParams.set("config", source);

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(
      `解析后端返回 HTTP ${res.status}：${(await res.text()).trim()}`,
    );
  }
  const payload = (await res.json()) as { outbounds?: OutboundNode[] };
  return (payload.outbounds ?? []).filter(
    (outbound) => !NON_NODE_TYPES.has(outbound.type),
  );
}

/** 节点标签唯一化：让开保留标签与彼此重名，名字只影响显示。 */
function assignTags(nodes: OutboundNode[]): void {
  const taken = new Set<string>(RESERVED_TAGS);
  nodes.forEach((node, index) => {
    const base = String(node.tag ?? "").trim() || `node-${index + 1}`;
    let tag = base;
    if (taken.has(tag)) {
      tag = `${base}-node`;
      let suffix = 2;
      while (taken.has(tag)) tag = `${base}-node-${suffix++}`;
    }
    node.tag = tag;
    taken.add(tag);
  });
}

/**
 * 单 URL 契约的组装函数：后续 HTTP 外壳直接调用它。
 */
export async function buildConfig(
  input: BuildConfigInput,
  deps: BuildDeps = {},
): Promise<SingBoxTemplate> {
  const parse = deps.parse ?? parseViaSublink;
  const template = structuredClone(deps.template ?? loadTemplate());
  const { source, sub, nodes: rawNodes = [], dns, zone } = input;

  const privateNodes: OutboundNode[] = [];
  const airportNodes: OutboundNode[] = [];

  // 1. 私有节点严格处理（严格保留顺序并固定在实体节点首部，默认作为首选）
  for (const n of rawNodes) {
    if (typeof n === "object" && n !== null) {
      privateNodes.push(n as OutboundNode);
    } else if (typeof n === "string") {
      const parsed = parseNodeUri(n);
      if (parsed) {
        privateNodes.push(parsed);
      } else {
        const parsedList = await parse(n);
        privateNodes.push(...parsedList);
      }
    }
  }

  // 2. 订阅节点处理（严格保留物理先后顺序追加）
  if (sub) {
    airportNodes.push(...(await parse(sub)));
  } else if (source) {
    const lines = source.split("\n").map((l) => l.trim()).filter(Boolean);
    const subLines: string[] = [];
    for (const line of lines) {
      const parsed = parseNodeUri(line);
      if (parsed) {
        privateNodes.push(parsed);
      } else {
        subLines.push(line);
      }
    }
    if (subLines.length > 0) {
      airportNodes.push(...(await parse(subLines.join("\n"))));
    }
  }

  const nodes = [...privateNodes, ...airportNodes];
  if (nodes.length === 0) {
    throw new Error("未解析出任何节点：请检查订阅内容或节点链接");
  }
  assignTags(nodes);
  const tags = nodes.map((node) => node.tag);

  if (dns) {
    const internal = template.dns?.servers?.find(
      (server) => server.tag === "dns-internal",
    );
    if (!internal) {
      throw new Error("底模里找不到 dns-internal 上游，无法覆盖内网 DNS");
    }
    internal.server = dns;
  }

  if (zone) {
    const zoneSet = template.route?.rule_set?.find(
      (ruleSet) => ruleSet.tag === "zone-internal",
    );
    if (!zoneSet) {
      throw new Error("底模里找不到 zone-internal 规则集，无法覆盖内网域名后缀");
    }
    zoneSet.rules = [{ domain_suffix: [zone] }];
  }

  const declaredSelectors = (template.outbounds ?? []).filter(
    (o) => o.type === "selector",
  );
  const selectorTagSet = new Set<string>(declaredSelectors.map((s) => s.tag));

  const populatedSelectors: OutboundNode[] = declaredSelectors.map((sel) => {
    const expanded: string[] = [];
    for (const item of sel.outbounds ?? []) {
      if (item === "direct" || selectorTagSet.has(item) || tags.includes(item)) {
        expanded.push(item);
      } else {
        try {
          let pat = item;
          let flags = "";
          if (pat.startsWith("(?i)")) {
            pat = pat.slice(4);
            flags = "i";
          }
          const re = new RegExp(pat, flags);
          const matched = tags.filter((t) => re.test(t));
          expanded.push(...matched);
        } catch {}
      }
    }
    const combined = [...new Set(expanded.filter((t) => t !== sel.tag))];
    return {
      type: "selector",
      tag: sel.tag,
      outbounds: combined,
      default: combined[0] ?? "direct",
    };
  });

  return {
    ...template,
    outbounds: [
      { type: "direct", tag: "direct" },
      ...nodes,
      ...populatedSelectors,
    ],
  };
}

export interface ServeOptions {
  port?: number;
  hostname?: string;
  deps?: BuildDeps;
}

/** HTTP 外壳：把单 URL 契约直接暴露成可 GET 的端点，客户端拿到的就是本函数的响应体。 */
export async function serveEndpoint({
  port = 8080,
  hostname = "127.0.0.1",
  deps = {},
}: ServeOptions = {}) {
  const fail = (status: number, message: string) =>
    new Response(JSON.stringify({ error: message }) + "\n", {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });

  const server = Bun.serve({
    port,
    hostname,
    async fetch(request) {
      const url = new URL(request.url);
      const target = url.pathname.replace(/^\/+|\/+$/g, "");
      if (target !== "darwin") {
        return fail(
          400,
          `不支持的 target：${target || "(空路径)"}（当前只实现 darwin）`,
        );
      }
      const sub = url.searchParams.get("sub");
      if (!sub) return fail(400, "缺少 sub 参数");
      const nodeLinks = url.searchParams.getAll("node").filter((n) => n && n.trim());
      try {
        const config = await buildConfig(
          {
            sub,
            nodes: nodeLinks,
            dns: url.searchParams.get("dns") ?? undefined,
            zone: url.searchParams.get("zone") ?? undefined,
          },
          deps,
        );
        return new Response(JSON.stringify(config, null, 2) + "\n", {
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return fail(502, msg);
      }
    },
  });

  console.log(
    `端点已监听 http://${hostname}:${server.port}/darwin?sub=…&node=…`,
  );
  return server;
}

function parseEnvContent(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

interface ResolvedSource {
  sub?: string;
  source?: string;
  nodes: string[];
}

/** 解析源参数，支持 .env、本地文件或直接的订阅 URL。 */
function resolveSource(sourceArg: string, nodeLinks: string[]): ResolvedSource {
  const filePath = resolve(process.cwd(), sourceArg);
  if (existsSync(filePath)) {
    const content = readFileSync(filePath, "utf-8");
    if (sourceArg.endsWith(".env") || content.includes("SUB_URL=")) {
      const env = parseEnvContent(content);
      const sub = env.SUB_URL;
      const nodes = [...nodeLinks];
      if (env.NODE_URI) nodes.unshift(env.NODE_URI);
      return { sub, nodes };
    }
    const lines = content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    lines.push(...nodeLinks);
    return { source: lines.join("\n"), nodes: [] };
  }

  const isUrl =
    sourceArg.startsWith("http://") || sourceArg.startsWith("https://");
  if (isUrl) {
    return { sub: sourceArg, nodes: nodeLinks };
  }
  return { source: [sourceArg, ...nodeLinks].join("\n"), nodes: [] };
}

interface ParsedCliOptions {
  source?: string;
  output?: string;
  sub?: string;
  dns?: string;
  zone?: string;
  nodes: string[];
  serve: boolean;
  port?: number;
  host?: string;
}

function parseArgs(argv: string[]): ParsedCliOptions {
  const options: ParsedCliOptions = {
    source: undefined,
    output: undefined,
    dns: undefined,
    zone: undefined,
    nodes: [],
    serve: false,
    port: undefined,
    host: undefined,
  };
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--node") options.nodes.push(argv[++i]);
    else if (arg === "--dns") options.dns = argv[++i];
    else if (arg === "--zone") options.zone = argv[++i];
    else if (arg === "--serve") options.serve = true;
    else if (arg === "--port") options.port = Number(argv[++i]);
    else if (arg === "--host") options.host = argv[++i];
    else if (arg === "--output" || arg === "-o") options.output = argv[++i];
    else if (arg.trim()) positionals.push(arg.trim());
  }
  if (positionals.length === 1) {
    if (positionals[0].endsWith(".json")) {
      options.output = positionals[0];
    } else {
      options.source = positionals[0];
    }
  } else if (positionals.length >= 2) {
    [options.source, options.output] = positionals;
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.serve) {
    await serveEndpoint({ port: options.port ?? 8080, hostname: options.host ?? "127.0.0.1" });
    return;
  }

  if (!options.source) {
    if (process.env.SUB_URL) {
      options.sub = process.env.SUB_URL;
      if (process.env.NODE_URI) options.nodes.unshift(process.env.NODE_URI);
    } else if (existsSync(".env")) {
      options.source = ".env";
    } else {
      console.error(
        [
          "用法（本地校验）：just verify-endpoint [订阅URL或文件] [输出路径=/tmp/singbox.json] [--node <节点链接>]...",
          "用法（起端点）：  just serve [端口] [绑定地址]",
        ].join("\n"),
      );
      process.exit(1);
    }
  }
  const outputPath = resolve(process.cwd(), options.output ?? "/tmp/singbox.json");
  const resolved = options.sub
    ? { sub: options.sub, nodes: options.nodes }
    : resolveSource(options.source!, options.nodes);
  const config = await buildConfig({
    ...resolved,
    dns: options.dns,
    zone: options.zone,
  });

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

  const check = Bun.spawnSync([findSingBox(), "check", "-c", outputPath]);
  if (check.exitCode !== 0) {
    process.stderr.write(check.stderr);
    process.exit(1);
  }
  console.log(`[sing-box] sing-box check 通过（规则集 ${(config.route?.rule_set as unknown[])?.length ?? 0}）`);
  console.log(`输出路径: ${outputPath}`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`ERROR: ${msg}`);
    process.exit(1);
  });
}
