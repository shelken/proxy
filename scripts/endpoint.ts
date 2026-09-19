#!/usr/bin/env bun
/**
 * 端点核心：单参数契约（base64 编码的 `|` 分隔源列表）→ 完整 sing-box 配置。
 *
 * 源列表支持四种形态，任意混合，`|` 分隔，顺序即优先级：
 *   1. https://…        机场订阅（响应体为 base64 编码的 URI 列表）
 *   2. hy2:// hysteria2://  Hysteria2 私有节点
 *   3. anytls://        AnyTLS 私有节点
 *   4. ss://            Shadowsocks（SIP002 / legacy）
 *
 * 零上传、零会话、零留存：订阅抓取与 URI 解析全部本地完成，不依赖任何转换服务。
 * 无法识别的输入行直接报错（fail-fast），绝不静默丢弃。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

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
  /** `|` 分隔的源列表（未编码原文）：机场订阅 URL / hy2 URI / anytls URI。 */
  sources?: string;
  localConfigPath?: string;
}
export interface BuildDeps {
  /** 订阅抓取注入点（测试用），默认 fetchRemoteSubscription。 */
  fetchSubscription?: (url: string) => Promise<string>;
  template?: SingBoxTemplate;
}

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

/** AnyTLS URI → sing-box 出站（字段语义按官方 anytls.md）。 */
export function parseAnytls(raw: string): OutboundNode {
  const u = new URL(raw);
  const tag = decodeURIComponent(u.hash ? u.hash.slice(1) : "") || `AnyTLS ${u.hostname}:${u.port || 443}`;
  const password = decodeURIComponent(u.username || u.password || "");
  if (!password) throw new Error(`anytls URI 缺少密码：${raw}`);

  const tls: Record<string, unknown> = { enabled: true };
  const sni = u.searchParams.get("sni");
  if (sni) tls.server_name = sni;
  const insecure = u.searchParams.get("insecure");
  if (insecure !== null) tls.insecure = insecure === "1";
  const alpn = u.searchParams.get("alpn");
  if (alpn) tls.alpn = alpn.split(",").map((s) => s.trim()).filter(Boolean);
  const fingerprint = u.searchParams.get("fp");
  if (fingerprint) tls.utls = { enabled: true, fingerprint };

  const outbound: OutboundNode = {
    type: "anytls",
    tag,
    server: u.hostname,
    server_port: u.port ? parseInt(u.port, 10) : 443,
    password,
    tls,
  };
  for (const [src, dst] of [
    ["idle-session-check-interval", "idle_session_check_interval"],
    ["idle-session-timeout", "idle_session_timeout"],
    ["min-idle-session", "min_idle_session"],
  ] as const) {
    const value = u.searchParams.get(src);
    if (value !== null) outbound[dst] = value;
  }
  return outbound;
}

/**
 * Shadowsocks URI（SIP002 及 legacy base64 整段格式）→ sing-box 出站。
 * 支持两种形态：
 *   ss://base64(method:password)@host:port#tag
 *   ss://base64(method:password@host:port)#tag   （legacy，整段 base64）
 */
export function parseShadowsocks(raw: string): OutboundNode {
  const hashIndex = raw.indexOf("#");
  const tag = hashIndex >= 0 ? decodeURIComponent(raw.slice(hashIndex + 1)) : "Shadowsocks";
  let mainPart = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw.slice(5);
  mainPart = mainPart.slice(5);

  // 去掉 plugin 等查询参数（暂不支持插件字段，保留主字段解析）
  const queryIndex = mainPart.indexOf("?");
  if (queryIndex >= 0) mainPart = mainPart.slice(0, queryIndex);

  const decodeB64 = (s: string) =>
    Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");

  let method: string;
  let password: string;
  let hostPart: string;

  const at = mainPart.lastIndexOf("@");
  if (at >= 0) {
    // SIP002：userinfo 是 base64(method:password) 或明文 method:password
    const userinfo = mainPart.slice(0, at);
    hostPart = mainPart.slice(at + 1);
    let decoded = userinfo;
    try {
      const probe = decodeB64(userinfo);
      if (probe.includes(":")) decoded = probe;
    } catch {}
    const sep = decoded.indexOf(":");
    method = decoded.slice(0, sep);
    password = decoded.slice(sep + 1);
  } else {
    // legacy：整段 base64 = method:password@host:port
    const decoded = decodeB64(mainPart);
    const at2 = decoded.lastIndexOf("@");
    if (at2 < 0) throw new Error("无法解析 ss URI：既无 @ 分隔也不是合法 legacy 格式");
    const cred = decoded.slice(0, at2);
    hostPart = decoded.slice(at2 + 1);
    const sep = cred.indexOf(":");
    method = cred.slice(0, sep);
    password = cred.slice(sep + 1);
  }

  let server: string;
  let serverPort: number;
  if (hostPart.startsWith("[")) {
    // IPv6：[::1]:8388
    const m = hostPart.match(/^\[([^\]]+)\]:(\d+)$/);
    if (!m) throw new Error(`无法解析 ss 服务器地址：${hostPart}`);
    server = m[1];
    serverPort = parseInt(m[2], 10);
  } else {
    const sep = hostPart.lastIndexOf(":");
    if (sep < 0) throw new Error(`无法解析 ss 服务器地址：${hostPart}`);
    server = hostPart.slice(0, sep);
    serverPort = parseInt(hostPart.slice(sep + 1), 10);
  }
  if (!method || !password || !server || Number.isNaN(serverPort)) {
    throw new Error("ss URI 字段不完整（method/password/server/port）");
  }

  return {
    type: "shadowsocks",
    tag,
    server,
    server_port: serverPort,
    method,
    password,
  };
}

export function parseNodeUri(uri: string): OutboundNode {
  const trimmed = uri.trim();
  if (trimmed.startsWith("hysteria2://") || trimmed.startsWith("hy2://")) {
    return parseHysteria2(trimmed);
  }
  if (trimmed.startsWith("anytls://")) {
    return parseAnytls(trimmed);
  }
  if (trimmed.startsWith("ss://")) {
    return parseShadowsocks(trimmed);
  }
  throw new Error(`不支持的节点协议：${trimmed.split("://")[0] || trimmed}（只支持 ss/hysteria2/hy2/anytls）`);
}

export function findSingBox(): string {
  if (process.env.SING_BOX) return process.env.SING_BOX;
  const which = Bun.which("sing-box");
  if (which) return which;
  return "sing-box";
}

/** 抓取机场订阅原文（通常为 base64 编码的 URI 列表）。 */
export async function fetchRemoteSubscription(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    throw new Error(`订阅返回 HTTP ${res.status}：${url}`);
  }
  return res.text();
}

/** base64 → URI 列表 → 节点数组；任何无法解析的行都带行号报错。 */
export function parseSubscriptionBody(body: string): OutboundNode[] {
  let decoded = body.trim();
  if (!decoded.includes("://")) {
    try {
      decoded = Buffer.from(decoded.replace(/\s+/g, ""), "base64").toString("utf-8");
    } catch {
      throw new Error("订阅内容 base64 解码失败");
    }
  }
  const lines = decoded.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) {
    throw new Error("订阅内容为空");
  }
  return lines.map((line, i) => {
    try {
      return parseNodeUri(line);
    } catch (e) {
      throw new Error(`订阅第 ${i + 1} 行解析失败：${(e as Error).message}`);
    }
  });
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
 * 深度合并本地专有配置 (local.json)
 * - dns.servers: 覆盖同 tag 服务，或追加新服务
 * - route.rules: 本地专有规则置顶 (unshift)，确保优先命中
 * - outbounds: 合并或追加出站
 */
export function mergeLocalConfig(
  template: SingBoxTemplate,
  local: Record<string, unknown>,
): void {
  if (!local || typeof local !== "object") return;

  if (local.dns && typeof local.dns === "object") {
    const localDns = local.dns as {
      servers?: Array<{ tag: string; [key: string]: unknown }>;
      rules?: Array<Record<string, unknown>>;
    };
    if (Array.isArray(localDns.servers) && template.dns?.servers) {
      for (const server of localDns.servers) {
        if (!server?.tag) continue;
        const idx = template.dns.servers.findIndex((s) => s.tag === server.tag);
        if (idx >= 0) {
          template.dns.servers[idx] = { ...template.dns.servers[idx], ...server };
        } else {
          template.dns.servers.unshift(server);
        }
      }
    }
    if (Array.isArray(localDns.rules) && template.dns?.rules) {
      template.dns.rules.unshift(...localDns.rules);
    }
  }

  if (local.route && typeof local.route === "object") {
    const localRoute = local.route as {
      rules?: Array<Record<string, unknown>>;
    };
    if (Array.isArray(localRoute.rules) && template.route?.rules) {
      template.route.rules.unshift(...localRoute.rules);
    }
  }

  if (Array.isArray(local.outbounds) && Array.isArray(template.outbounds)) {
    template.outbounds.push(...local.outbounds);
  }
}

/**
 * 源列表契约的组装函数：后续 HTTP 外壳直接调用它。
 */
export async function buildConfig(
  input: BuildConfigInput,
  deps: BuildDeps = {},
): Promise<SingBoxTemplate> {
  const fetchSubscription = deps.fetchSubscription ?? fetchRemoteSubscription;
  const template = structuredClone(deps.template ?? loadTemplate());
  const { sources, localConfigPath } = input;

  // 合并本地专有配置（若存在）
  const localPath = localConfigPath ?? resolve(ROOT_DIR, "config/sing-box/local.json");
  if (existsSync(localPath)) {
    try {
      const localData = JSON.parse(readFileSync(localPath, "utf-8")) as Record<string, unknown>;
      mergeLocalConfig(template, localData);
    } catch (e) {
      console.warn(`[sing-box] 警告: 读取本地专有配置 ${localPath} 失败: ${(e as Error).message}`);
    }
  }

  // 逐源解析：URI 形态=私有节点（保序前插），http(s) 形态=机场订阅（原序追加）
  const privateNodes: OutboundNode[] = [];
  const airportNodes: OutboundNode[] = [];
  for (const source of (sources ?? "").split("|").map((s) => s.trim()).filter(Boolean)) {
    if (source.startsWith("http://") || source.startsWith("https://")) {
      airportNodes.push(...parseSubscriptionBody(await fetchSubscription(source)));
    } else {
      privateNodes.push(parseNodeUri(source));
    }
  }

  const nodes = [...privateNodes, ...airportNodes];
  if (nodes.length === 0) {
    throw new Error("未解析出任何节点：请检查源列表内容");
  }
  assignTags(nodes);
  const tags = nodes.map((node) => node.tag);

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
      // 源列表：优先 s 参数（base64(|分隔原文)），缺省回退服务端 .env
      const encoded = url.searchParams.get("s");
      let sources = encoded ? Buffer.from(encoded, "base64").toString("utf-8") : undefined;
      if (!sources) {
        sources = resolveEnvSources();
        if (!sources) return fail(400, "缺少 s 参数，且服务端未配置 .env");
      }
      try {
        const config = await buildConfig({ sources }, deps);
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
    `端点已监听 http://${hostname}:${server.port}/darwin?s=<base64(源列表)>`,
  );
  return server;
}

/** 服务端默认源：SUB_URL 与 NODE_URI 环境变量，或仓库 .env 文件。 */
function resolveEnvSources(): string | undefined {
  const parts: string[] = [];
  if (process.env.NODE_URI) parts.push(process.env.NODE_URI);
  if (process.env.SUB_URL) parts.push(process.env.SUB_URL);
  if (parts.length > 0) return parts.join("|");
  const envPath = resolve(ROOT_DIR, ".env");
  if (!existsSync(envPath)) return undefined;
  const env = parseEnvContent(readFileSync(envPath, "utf-8"));
  if (env.NODE_URI) parts.push(env.NODE_URI);
  if (env.SUB_URL) parts.push(env.SUB_URL);
  return parts.length > 0 ? parts.join("|") : undefined;
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
  sources?: string;
}

/** 解析 CLI 源参数：直接源列表 / .env 文件 / 环境变量。 */
function resolveSource(sourceArg: string): ResolvedSource {
  const filePath = resolve(process.cwd(), sourceArg);
  if (existsSync(filePath)) {
    const content = readFileSync(filePath, "utf-8");
    if (sourceArg.endsWith(".env") || content.includes("SUB_URL=") || content.includes("NODE_URI=")) {
      const env = parseEnvContent(content);
      const parts: string[] = [];
      if (env.NODE_URI) parts.push(env.NODE_URI);
      if (env.SUB_URL) parts.push(env.SUB_URL);
      return { sources: parts.join("|") || undefined };
    }
    // 纯文本：每行一个源
    return { sources: content.split("\n").map((l) => l.trim()).filter(Boolean).join("|") };
  }
  return { sources: sourceArg };
}

interface ParsedCliOptions {
  source?: string;
  output?: string;
  localConfigPath?: string;
  serve: boolean;
  port?: number;
  host?: string;
}

function parseArgs(argv: string[]): ParsedCliOptions {
  const options: ParsedCliOptions = {
    source: undefined,
    output: undefined,
    serve: false,
    port: undefined,
    host: undefined,
  };
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--local") options.localConfigPath = argv[++i];
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

  let resolved: ResolvedSource;
  if (options.source) {
    resolved = resolveSource(options.source);
  } else {
    const envSources = resolveEnvSources();
    if (!envSources) {
      console.error(
        [
          "用法（本地校验）：just verify-endpoint [源列表|.env|订阅URL] [输出路径=/tmp/singbox.json]",
          "源列表格式：      URL|hy2://…|anytls://… （| 分隔，可混合）",
          "用法（起端点）：  just serve [端口] [绑定地址]",
        ].join("\n"),
      );
      process.exit(1);
    }
    resolved = { sources: envSources };
  }
  const outputPath = resolve(process.cwd(), options.output ?? "/tmp/singbox.json");
  const config = await buildConfig({
    sources: resolved.sources,
    localConfigPath: options.localConfigPath,
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
