#!/usr/bin/env bun
/**
 * 端点核心：单 URL 契约（`sub` / `node` / `dns` / `zone`）→ 完整 sing-box 配置。
 *
 * 契约来自 Issue #8／#13：零上传、零会话、零留存。底模随仓库提供，协议解析交给
 * sublink-worker 容器，最终装配（底模 + 节点 + 9 个策略组）由本文件完成——容器实测
 * 表明 sublink 的构建器会无条件覆写 route.rule_set 与 route.final、且不创建本仓库需要的
 * 策略组，所以它只能当解析后端用。
 *
 * 本文件不解析任何代理协议；仓库内不保留手写协议解析代码。
 * 后续部署（Docker / Worker）只需在 HTTP 外壳里调用 buildConfig 并回写 JSON。
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

/** 出站里非实体节点的类型：解析后端返回的分组与内置出站，装配时一律丢弃。 */
export const NON_NODE_TYPES = new Set([
  "selector",
  "urltest",
  "direct",
  "block",
  "dns",
]);

/** 底模 route.rules 引用的出站标签，节点名撞上时必须让位。 */
export const RESERVED_TAGS = [
  "direct",
  "proxy",
  "openai",
  "gemini",
  "appleai",
  "dev",
  "ptcg",
  "adultnsfw",
  "japansite",
  "opencode",
];

/** 主分组之外的分流分组：默认跟随主分组，成员里排上全部节点。 */
export const POLICY_GROUPS = RESERVED_TAGS.filter(
  (tag) => tag !== "direct" && tag !== "proxy",
);

export function findSingBox() {
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

function loadTemplate() {
  return JSON.parse(readFileSync(TEMPLATE_PATH, "utf-8"));
}

async function isSublinkReady() {
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
export async function ensureSublink() {
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
 *
 * 只带 `config`，不带任何预先登记的配置 ID：底模由本仓库装配，解析后端不参与、也不上传。
 */
export async function parseViaSublink(source) {
  await ensureSublink();
  const url = new URL(`${SUBLINK_URL}/singbox`);
  url.searchParams.set("config", source);

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(
      `解析后端返回 HTTP ${res.status}：${(await res.text()).trim()}`,
    );
  }
  const payload = await res.json();
  return (payload.outbounds ?? []).filter(
    (outbound) => !NON_NODE_TYPES.has(outbound.type),
  );
}

/** 节点标签唯一化：让开保留标签与彼此重名，名字只影响显示。 */
function assignTags(nodes) {
  const taken = new Set(RESERVED_TAGS);
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
 *
 * `deps.parse` 与 `deps.template` 可注入，便于不依赖 Docker 的单元测试。
 */
export async function buildConfig(input, deps = {}) {
  const parse = deps.parse ?? parseViaSublink;
  const template = structuredClone(deps.template ?? loadTemplate());
  const { source, dns, zone } = input;

  const nodes = await parse(source);
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

  return {
    ...template,
    outbounds: [
      { type: "direct", tag: "direct" },
      ...nodes,
      {
        type: "selector",
        tag: "proxy",
        outbounds: tags,
        default: tags[0],
      },
      ...POLICY_GROUPS.map((tag) => ({
        type: "selector",
        tag,
        outbounds: ["proxy", ...tags],
        default: "proxy",
      })),
    ],
  };
}

/** HTTP 外壳：把单 URL 契约直接暴露成可 GET 的端点，客户端拿到的就是本函数的响应体。 */
export async function serveEndpoint({
  port = 8080,
  hostname = "127.0.0.1",
  deps = {},
} = {}) {
  const fail = (status, message) =>
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

      const source = [sub, ...url.searchParams.getAll("node")]
        .filter((line) => line && line.trim())
        .join("\n");
      try {
        const config = await buildConfig(
          {
            source,
            dns: url.searchParams.get("dns") ?? undefined,
            zone: url.searchParams.get("zone") ?? undefined,
          },
          deps,
        );
        return new Response(JSON.stringify(config, null, 2) + "\n", {
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      } catch (error) {
        return fail(502, error.message);
      }
    },
  });

  console.log(
    `端点已监听 http://${hostname}:${server.port}/darwin?sub=…&node=…&dns=…&zone=…`,
  );
  return server;
}

/** GET 只带得动有限长度：超长且不含订阅 URL 时提前报错，不留给后端一个误导性状态码。 */
function resolveSource(sourceArg, nodeLinks) {
  const filePath = resolve(process.cwd(), sourceArg);
  const lines = existsSync(filePath)
    ? readFileSync(filePath, "utf-8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
    : [sourceArg.trim()];
  lines.push(...nodeLinks);

  const value = lines.join("\n");
  const isUrl = lines.some(
    (line) => line.startsWith("http://") || line.startsWith("https://"),
  );
  if (Buffer.byteLength(value, "utf-8") > 6000 && !isUrl) {
    throw new Error(
      "订阅内容过长且不含订阅 URL：sublink 的 /singbox 只接受 GET，请改传订阅 URL",
    );
  }
  return value;
}

function parseArgs(argv) {
  const options = {
    source: undefined,
    output: undefined,
    dns: undefined,
    zone: undefined,
    nodes: [],
    serve: false,
    port: undefined,
    host: undefined,
  };
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--node") options.nodes.push(argv[++i]);
    else if (arg === "--dns") options.dns = argv[++i];
    else if (arg === "--zone") options.zone = argv[++i];
    else if (arg === "--serve") options.serve = true;
    else if (arg === "--port") options.port = Number(argv[++i]);
    else if (arg === "--host") options.host = argv[++i];
    else positionals.push(arg);
  }
  [options.source, options.output] = positionals;
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.serve) {
    await serveEndpoint({ port: options.port ?? 8080, hostname: options.host ?? "127.0.0.1" });
    return;
  }

  if (!options.source) {
    console.error(
      [
        "用法（本地校验）：just verify-endpoint <订阅URL或文件> [输出路径=/tmp/singbox.json] [--node <节点链接>]... [--dns <内网DNS>] [--zone <内网域名后缀>]",
        "用法（起端点）：  just serve [端口] [绑定地址]",
      ].join("\n"),
    );
    process.exit(1);
  }
  const outputPath = resolve(process.cwd(), options.output ?? "/tmp/singbox.json");
  const source = resolveSource(options.source, options.nodes);

  const config = await buildConfig({ source, dns: options.dns, zone: options.zone });
  const nodeCount = config.outbounds.filter(
    (outbound) => !NON_NODE_TYPES.has(outbound.type),
  ).length;
  console.log(`[sublink] 实体节点 ${nodeCount}`);

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

  const check = Bun.spawnSync([findSingBox(), "check", "-c", outputPath]);
  if (check.exitCode !== 0) {
    process.stderr.write(check.stderr);
    process.exit(1);
  }
  console.log(`[sing-box] sing-box check 通过（规则集 ${config.route.rule_set.length}）`);
  console.log(`输出路径: ${outputPath}`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  });
}
