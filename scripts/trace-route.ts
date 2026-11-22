/**
 * 全链路路由追踪器（沙箱侧）
 *
 * 在隔离网络命名空间的临时容器内起服务端并获取真实装配配置（ADR-0003），
 * 再驱动同版本 sing-box 内核完成 DNS 与 HTTP 探测。
 */

import { existsSync, readFileSync } from "node:fs";
import { bootstrap } from "./sandbox-loop.ts";
import { SANDBOX_WORK, parseEnv, withSandbox } from "./sandbox.ts";

const domain: string = process.argv[2] || "google.com";
const WORK = SANDBOX_WORK;

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

async function main(): Promise<void> {
  console.log(`\n🔍 [TRACE] 开始全链路探测: ${domain}`);

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

  await withSandbox(async (box) => {
    console.log(
      `[TRACE] 起临时服务端装配（订阅 ${subs.length} 个，私有节点 ${nodes.length} 个）...`,
    );
    bootstrap(box, { nodes, subs });

    const configSync = box.exec(`cat ${WORK}/config.json`);
    if (configSync.code !== 0) {
      throw new Error(`读取沙箱配置失败: ${configSync.err}`);
    }
    const config = JSON.parse(configSync.out) as SingBoxConfig;

    const forcedUdp = process.env.TRACE_DNS_UDP;
    if (forcedUdp) {
      config.dns = config.dns ?? {};
      config.dns.servers = (config.dns.servers ?? []).map((s: Record<string, unknown>) =>
        s.type === "local" ? { type: "udp", tag: s.tag, server: forcedUdp } : s,
      );
      console.log(`[TRACE] 注意: type:local 已按 TRACE_DNS_UDP 降级为 udp ${forcedUdp}`);
    }

    const push = box.exec(`cat > ${WORK}/config.json`, JSON.stringify(config, null, 2));
    if (push.code !== 0) {
      throw new Error(`同步 config.json 失败: ${push.err}`);
    }
    const check = box.exec(`sing-box check -D ${WORK} -c ${WORK}/config.json`);
    if (check.code !== 0) {
      console.error(`❌ [TRACE] 配置校验失败:\n${check.err || check.out}`);
      process.exit(1);
    }
    const ruleSetCount = config.route.rule_set.length;
    console.log(`[TRACE] 配置校验通过 (单文件自包含，${ruleSetCount} 份规则集均为纯本地秒级加载)`);

    const sbProc = box.spawn(["sing-box", "run", "-D", WORK, "-c", `${WORK}/config.json`], WORK);
    let logs = "";
    const collectLogs = async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        logs += new TextDecoder().decode(value);
      }
    };
    void collectLogs(sbProc.stdout);
    void collectLogs(sbProc.stderr);

    const stopKernel = () => {
      box.exec("pkill -9 -x sing-box || true");
      sbProc.kill();
    };

    try {
      const deadline = Date.now() + 8000;
      while (!logs.includes("sing-box started") && Date.now() < deadline) {
        await Bun.sleep(100);
      }
      if (!logs.includes("sing-box started")) {
        console.error("❌ [TRACE] 内核启动超时。日志输出:\n" + logs);
        process.exit(1);
      }
      console.log(`[TRACE] 内核已就绪，开始触发对 ${domain} 的 DNS 与 HTTPS 探测...`);

      const tunInbound = config.inbounds?.find(
        (i): i is { type: string; address?: string[] } =>
          typeof i === "object" && i !== null && "type" in i && i.type === "tun",
      );
      const tunAddr = Array.isArray(tunInbound?.address)
        ? tunInbound.address.find((a) => typeof a === "string" && /^(172\.|10\.|192\.168\.)/.test(a))
        : undefined;
      if (tunAddr) {
        const dnsAddr = tunAddr.split("/")[0].replace(/\.1$/, ".2");
        box.exec(`dig +short +time=3 +tries=1 ${domain} @${dnsAddr} > /dev/null 2>&1 || true`);
      }

      const probeStart = Date.now();
      const probe = box.exec(`
        bun -e '
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

      await Bun.sleep(400);
      stopKernel();
      console.log("=== SING-BOX RAW LOGS ===\n" + logs + "\n=========================");

      let sniffProtocol = "HTTP";
      let matchedRule = "未命中特定规则 (走 route.final 兜底)";
      let policyGroup = "proxy";
      let leafNode = "未知节点";
      let dnsExchangeMs = "";
      let dnsAnswer = "";
      let dnsPath = "未观察到内核解析 (可能客户端直发或命中缓存)";

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
        const exchange = line.match(
          new RegExp(`dns:\\s+exchange\\s+${domain.replace(/\./g, "\\.")}\\.?\\s+IN`, "i"),
        );
        if (exchange) {
          const ms =
            line.match(/\]\s*\[.*?\s(\d+(?:\.\d+)?m?s)\]/) ??
            line.match(/\s(\d+m?s)\]\s*dns: exchange/);
          dnsExchangeMs = ms?.[1] ?? "";
        }
        const answered = line.match(
          new RegExp(
            `exchanged\\s+A\\s+${domain.replace(/\./g, "\\.")}\\.?\\s+\\d+\\s+IN\\s+A\\s+(\\S+)`,
            "i",
          ),
        );
        if (answered?.[1]) dnsAnswer = answered[1];
      }
      if (dnsAnswer) {
        const isPrivateIp =
          /^10\./.test(dnsAnswer) ||
          /^192\.168\./.test(dnsAnswer) ||
          /^172\.(1[6-9]|2\d|3[01])\./.test(dnsAnswer);
        dnsPath = isPrivateIp
          ? "内网答案 (命中本地/内网 DNS 规则)"
          : "公网答案 (走 final 上游, 经代理隧道)";
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
    } finally {
      stopKernel();
    }
  }, "proxy-trace");
}

main().catch((err: unknown) => {
  console.error("Trace 执行出错:", err);
  process.exit(1);
});
