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

// 惰性求值：单二进制场景（bun compile）下模块加载时仓库文件不存在，
// 底模来源由调用方注入（sb-sync 传远程/内嵌底模），仓库文件只是兜底
let injectedTemplate: SingBoxTemplate | null = null;
let cachedReservedTags: string[] | null = null;

/**
 * 注入底模供保留标签计算使用（sb-sync 编译态必经路径）。
 * 同时重置缓存，保证换底模后标签集随之更新。
 */
export function setReservedTagsSource(template: SingBoxTemplate): void {
  injectedTemplate = template;
  cachedReservedTags = null;
}

/** 底模 route.rules 引用的出站标签，节点名撞上时必须让位。 */
export function getReservedTags(): string[] {
  cachedReservedTags ??= ((injectedTemplate ?? loadTemplate()).outbounds ?? []).map((o) => o.tag);
  return cachedReservedTags;
}

/** 主分组之外的分流分组：默认跟随主分组，成员里排上全部节点。不含 urltest 组与主代理组。 */
export function getPolicyGroups(): string[] {
  const tpl = injectedTemplate ?? loadTemplate();
  const policyTypes = new Set(["selector"]);
  return (tpl.outbounds ?? [])
    .filter((o) => policyTypes.has(o.type) && o.tag !== "proxy")
    .map((o) => o.tag);
}

export function parseHysteria2(raw: string): OutboundNode {
  const u = new URL(raw);
  const tag = decodeURIComponent(u.hash ? u.hash.slice(1) : "selfhost");
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
  const taken = new Set<string>(getReservedTags());
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
    (o) => o.type === "selector" || o.type === "urltest",
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
      ...sel,
      outbounds: combined,
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
