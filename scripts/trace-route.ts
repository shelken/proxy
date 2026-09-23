/**
 * 全链路路由追踪器
 *
 * 配置来源是**服务端真实产物**：起临时服务端 → 经 encode + /sub 取回它实际响应的
 * 配置 → 驱动内核追踪。不再是本地等价实现（ADR-0003）。
 *
 * 特性：
 * 1. 零远程下载：规则集本地编译产物路径由引导重写，内核秒级就绪。
 * 2. 真实节点注入：从 .env 读取订阅与私有节点，经完整加密链路交给服务端装配。
 * 3. 完整决策链：嗅探 → 规则 → 策略组 → 物理出口，全程不污染宿主网络。
 */

import { existsSync, readFileSync } from "node:fs";
import { bootstrap } from "./sandbox-loop.ts";

const domain: string = process.argv[2] || "google.com";
const VM_NAME = "proxy-test";

interface SingBoxRuleSet {
  type: string;
  tag: string;
  format?: string;
  path?: string;
  [key: string]: unknown;
}

interface SingBoxConfig {
  log?: { level?: string };
  route: {
    rule_set: SingBoxRuleSet[];
    rules?: Record<string, unknown>[];
    default_http_client?: unknown;
    [key: string]: unknown;
  };
  outbounds?: Array<{ server?: string; [key: string]: unknown }>;
  dns?: {
    servers?: Array<{ type?: string; inet4_range?: string; [key: string]: unknown }>;
    [key: string]: unknown;
  };
  default_http_client?: unknown;
  http_clients?: unknown;
  [key: string]: unknown;
}
interface ShellResult {
  code: number | null;
  out: string;
  err: string;
}

function sh(cmd: string): ShellResult {
  const p = Bun.spawnSync([
    "limactl",
    "shell",
    "--workdir",
    "/work",
    VM_NAME,
    "sh",
    "-c",
    cmd,
  ]);
  return {
    code: p.exitCode,
    out: p.stdout.toString(),
    err: p.stderr.toString(),
  };
}

function parseEnv(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const k = trimmed.slice(0, eq).trim();
    let v = trimmed.slice(eq + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    env[k] = v;
  }
  return env;
}

async function main(): Promise<void> {
  console.log(`\n🔍 [TRACE] 开始全链路探测: ${domain}`);

  // 1. 从 .env 读真实源，经完整加密链路交给服务端装配
  const envContent = existsSync(".env") ? readFileSync(".env", "utf-8") : "";
  const env = parseEnv(envContent);
  const nodes = (env.NODE_URI ?? "")
    .split("|")
    .map((s: string) => s.trim())
    .filter(Boolean);
  const subs = env.SUB_URL ? [env.SUB_URL.trim()] : [];

  if (nodes.length === 0 && subs.length === 0) {
    throw new Error("未在 .env 中找到 SUB_URL 或 NODE_URI，无法装配真实节点配置");
  }
  console.log(
    `[TRACE] 起临时服务端装配（订阅 ${subs.length} 个，私有节点 ${nodes.length} 个）...`,
  );
  bootstrap({ nodes, subs });

  // 2. 取回引导产出的配置（引导已完成 rule_set → 本地路径重写与 check）
  const configSync = sh("cat /work/sing-box/config.json");
  if (configSync.code !== 0) {
    throw new Error(`读取沙箱配置失败: ${configSync.err}`);
  }
  const config = JSON.parse(configSync.out) as SingBoxConfig;

  // 沙箱 DNS 隔离:Lima NAT 网关(192.168.5.2)的上游链会透传宿主 SFM fakeip(198.18/15)
  // 并对部分私域返回 NXDOMAIN,type:local 在 VM 内不可信。改为明确公共 UDP 上游,
  // 保证内核拨号解析(节点 server 域名)与 DNS 决策日志在沙箱内自洽。
  config.dns = config.dns ?? {};
  config.dns.servers = (config.dns.servers ?? []).map((s: Record<string, unknown>) =>
    s.type === "local" ? { type: "udp", tag: s.tag, server: "223.5.5.5" } : s,
  );

  // 3. 推回 VM 并校验
  const push = Bun.spawnSync(
    [
      "limactl",
      "shell",
      "--workdir",
      "/work",
      VM_NAME,
      "sh",
      "-c",
      "cat > /work/sing-box/config.json",
    ],
    { stdin: Buffer.from(JSON.stringify(config, null, 2)) },
  );
  if (push.exitCode !== 0) {
    throw new Error(`同步 config.json 失败: ${push.stderr.toString()}`);
  }
  const check = sh("/opt/proxy-test/bin/sing-box check -c /work/sing-box/config.json");
  if (check.code !== 0) {
    console.error(`❌ [TRACE] 配置校验失败:\n${check.err || check.out}`);
    process.exit(1);
  }
  const ruleSetCount = config.route.rule_set.length;
  console.log(`[TRACE] 配置校验通过 (单文件自包含，${ruleSetCount} 份规则集均为纯本地秒级加载)`);
  // 5. 启动内核进程（先清理旧残留，再后台捕获输出）
  sh("sudo -n pkill -9 -x sing-box || true; sleep 0.3");
  console.log(`[TRACE] 启动沙箱 sing-box 内核...`);
  const sbProc = Bun.spawn(
    [
      "limactl",
      "shell",
      "--workdir",
      "/work/sing-box",
      VM_NAME,
      "sudo",
      "-n",
      "/opt/proxy-test/bin/sing-box",
      "run",
      "-D",
      "/work/sing-box",
      "-c",
      "/work/sing-box/config.json",
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  let logs = "";
  const appendLog = (chunk: string | Uint8Array) => {
    logs += chunk.toString();
  };

  (async () => {
    const reader = sbProc.stdout.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      appendLog(new TextDecoder().decode(value));
    }
  })();
  (async () => {
    const reader = sbProc.stderr.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      appendLog(new TextDecoder().decode(value));
    }
  })();

  const cleanup = () => {
    sh("sudo -n pkill -9 -x sing-box || true");
    sbProc.kill();
  };

  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("exit", cleanup);

  // 等待内核就绪（纯本地秒级启动）
  const startWait = Date.now();
  while (!logs.includes("sing-box started") && Date.now() - startWait < 8_000) {
    await Bun.sleep(100);
  }
  if (!logs.includes("sing-box started")) {
    console.error("❌ 等待 sing-box 启动超时:\n" + logs);
    cleanup();
    process.exit(1);
  }
  console.log(`[TRACE] 内核就绪 (${Date.now() - startWait}ms)，正在注入测试流量...`);

  // 6. 注入测试请求
  // 6a. DNS 探测:向 TUN 派生 DNS 地址(auto_route 劫持入内核)发查询,逼内核留下完整 DNS 决策日志
  const tunInbound = config.inbounds?.find(
    (i): i is { type: string; address?: string[] } =>
      typeof i === "object" && i !== null && "type" in i && i.type === "tun",
  );
  const tunAddr = Array.isArray(tunInbound?.address)
    ? tunInbound.address.find((a) => typeof a === "string" && /^(172\.|10\.|192\.168\.)/.test(a))
    : undefined;
  if (tunAddr) {
    const dnsAddr = tunAddr.split("/")[0].replace(/\.1$/, ".2");
    sh(`/usr/bin/dig +short +time=3 +tries=1 ${domain} @${dnsAddr} > /dev/null 2>&1 || true`);
  }

  // 6b. HTTP 探测:经 mixed 入站走完整路由链
  const probeStart = Date.now();
  const probe = sh(`
    /opt/proxy-test/bin/bun -e '
      try {
        const res = await fetch("https://${domain}/", {
          proxy: "http://127.0.0.1:2080",
          signal: AbortSignal.timeout(15000)
        });
        console.log("STATUS:" + res.status);
      } catch (e) {
        console.log("ERR:" + e.message);
      }
    '
  `);
  const probeDuration = Date.now() - probeStart;

  // 稍等日志刷盘
  await Bun.sleep(400);
  cleanup();
  console.log("=== SING-BOX RAW LOGS ===\n" + logs + "\n=========================");
  // 7. 分析决策日志
  let sniffProtocol = "HTTP";
  let matchedRule = "未命中特定规则 (走 route.final 兜底)";
  let policyGroup = "proxy";
  let leafNode = "未知节点";
  // DNS 走线：抓内核对目标域名的解析走线（本地服务器应答 vs 经隧道转发）与最终答案
  let dnsExchangeMs = "";
  let dnsAnswer = "";
  let dnsPath = "未观察到内核解析 (可能客户端直发或命中缓存)";

  // 节点拨号失败证据：出站组因解析节点 server 域名失败而不可用（沙箱/上游污染典型症状）
  const dialFailures: string[] = [];
  for (const line of logs.split("\n")) {
    const m = line.match(/outbound\/urltest\[[^\]]+\]: outbound (\S+) unavailable: lookup ([\w.-]+):/);
    if (m && m[1] && m[2] && !dialFailures.some((f) => f.includes(m[1]))) {
      dialFailures.push(`${m[1]} (解析 ${m[2]} 失败)`);
    }
  }

  for (const line of logs.split("\n")) {
    if (line.includes("sniffed protocol:")) {
      const m = line.match(/sniffed protocol:\s*(\w+)/);
      if (m && m[1]) sniffProtocol = m[1].toUpperCase();
    }
    if (line.includes("router: match")) {
      const candidate = line.replace(/.*router:\s*/, "").trim();
      if (!candidate.includes("=> sniff")) {
        matchedRule = candidate;
        const m = matchedRule.match(/=>\s*route\((\w+)\)/);
        if (m && m[1]) policyGroup = m[1];
      }
    }
    if (line.includes("outbound/") && line.includes(domain)) {
      const m = line.match(/outbound\/\w+\[([^\]]+)\]:\s*outbound connection/);
      if (m && m[1]) {
        leafNode = m[1];
      }
    }
    // DNS 走线证据链
    const exchange = line.match(new RegExp(`dns:\\s+exchange\\s+${domain.replace(/\./g, "\\.")}\\.?\\s+IN`, "i"));
    if (exchange) {
      const ms = line.match(/\]\s*\[.*?\s(\d+(?:\.\d+)?m?s)\]/) ?? line.match(/\s(\d+m?s)\]\s*dns: exchange/);
      dnsExchangeMs = ms?.[1] ?? "";
    }
    const answered = line.match(new RegExp(`exchanged\\s+A\\s+${domain.replace(/\./g, "\\.")}\\.?\\s+\\d+\\s+IN\\s+A\\s+(\\S+)`, "i"));
    if (answered?.[1]) dnsAnswer = answered[1];
  }
  if (dnsAnswer) {
    const isPrivateIp =
      /^10\./.test(dnsAnswer) ||
      /^192\.168\./.test(dnsAnswer) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(dnsAnswer);
    dnsPath = isPrivateIp
      ? `内网答案 (命中本地/内网 DNS 规则)`
      : `公网答案 (走 final 上游, 经代理隧道)`;
  }

  const probeOutput = probe.out.trim();
  const isOk = /STATUS:\s*[234]\d{2}/.test(probeOutput);

  console.log(`\n======================================================`);
  console.log(`📊 [全链路路由诊断报告] 目标: ${domain}`);
  console.log(`======================================================`);
  console.log(`├─ DNS 走线:   ${dnsPath}${dnsExchangeMs ? ` (解析耗时 ${dnsExchangeMs})` : ""}`);
  console.log(`├─ DNS 答案:   ${dnsAnswer || "(未捕获 A 记录)"}`);
  console.log(`├─ 协议嗅探:   ${sniffProtocol}`);
  console.log(`├─ 路由匹配:   ${matchedRule}`);
  console.log(`├─ 策略分组:   ${policyGroup}`);
  console.log(`├─ 真实节点:   🎯 [${leafNode}]`);
  console.log(`├─ 探测耗时:   ${probeDuration}ms`);
  if (dialFailures.length > 0) {
    console.log(`├─ 节点解析失败: ⚠️ ${dialFailures.join("; ")} — 沙箱/上游 DNS 对节点 server 域名不可达`);
  }
  console.log(`└─ 连通状态:   ${isOk ? "✅ " + probeOutput : "⚠️ " + probeOutput}`);
  console.log(`======================================================\n`);
}

main().catch((err: unknown) => {
  console.error("Trace 执行出错:", err);
  process.exit(1);
});
