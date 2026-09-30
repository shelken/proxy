/**
 * DNS 系统性观测（沙箱侧，#75 验收工件）
 *
 * 被测对象：真实数据闭环装配出的完整 DNS 拓扑——
 *   国内域(ChinaMax-dns) → dns-direct-cn(223.5.5.5 直连)
 *   LAN/直连域 → dns-local-system（禁乐观缓存）
 *   国际域 → dns-fakeip，真实解析 DoH 1.1.1.1 detour dns-auto（四正则跨故障域 urltest）
 *
 * 方法：对 TUN 派生 DNS 地址批量采样，用应答 IP 网段判别实际路径
 * （198.18/15 = FakeIP，国内公网 = 直连，NXDOMAIN = LAN 本地应答），
 * debug 日志统计 DoH/上游/节点命中，并经 mixed 2080 验证真实出口区域。
 * 输出 JSON + 可读报告，供验收评论引用。
 */

import { existsSync, readFileSync } from "node:fs";
import { bootstrap } from "./sandbox-loop.ts";

const VM_NAME = "proxy-test";
const SB = "/opt/proxy-test/bin/sing-box";
const ROUNDS = 5;

const DOMAINS: Record<string, string[]> = {
  intl: ["google.com", "github.com", "youtube.com", "cloudflare.com", "openai.com"],
  cn: ["baidu.com", "qq.com", "bilibili.com", "taobao.com", "jd.com"],
  lan: ["router.lan", "nas.local", "printer.home.arpa"],
};

interface ShellResult { code: number; out: string; err: string }

function sh(cmd: string): ShellResult {
  const p = Bun.spawnSync(
    ["limactl", "shell", "--workdir", "/work", VM_NAME, "sh", "-c", cmd],
  );
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

function parseEnv(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const t = line.trim();
    const eq = t.indexOf("=");
    if (!t || t.startsWith("#") || eq === -1) continue;
    env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
  }
  return env;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function main(): Promise<void> {
  const env = parseEnv(existsSync(".env") ? readFileSync(".env", "utf-8") : "");
  const nodes = (env.NODE_URI ?? "").split("|").map((s) => s.trim()).filter(Boolean);
  const subs = env.SUB_URL ? [env.SUB_URL.trim()] : [];
  if (nodes.length === 0 && subs.length === 0) {
    throw new Error("未在 .env 中找到 SUB_URL 或 NODE_URI");
  }
  console.log(`[OBS] 真实数据装配（订阅 ${subs.length}，私有节点 ${nodes.length}）...`);
  bootstrap({ nodes, subs });

  const check = sh(`${SB} check -c /work/sing-box/config.json`);
  if (check.code !== 0) throw new Error(`配置校验失败: ${check.err || check.out}`);

  sh("sudo -n pkill -9 -x sing-box || true; sleep 0.3");
  const sbProc = Bun.spawn(
    ["limactl", "shell", "--workdir", "/work/sing-box", VM_NAME,
      "sudo", "-n", SB, "run", "-D", "/work/sing-box", "-c", "/work/sing-box/config.json"],
    { stdout: "pipe", stderr: "pipe" },
  );
  let logs = "";
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      logs += new TextDecoder().decode(value);
    }
  };
  void pump(sbProc.stdout); void pump(sbProc.stderr);
  const cleanup = () => { sh("sudo -n pkill -9 -x sing-box || true"); sbProc.kill(); };
  process.on("exit", cleanup);

  const t0 = Date.now();
  while (!logs.includes("sing-box started") && Date.now() - t0 < 8_000) await Bun.sleep(100);
  if (!logs.includes("sing-box started")) {
    console.error("内核启动超时:\n" + logs.slice(-2000));
    process.exit(1);
  }
  console.log("[OBS] 内核就绪，开始采样");

  const tunIn = JSON.parse(sh("cat /work/sing-box/config.json").out)
    .inbounds.find((i: { type: string }) => i.type === "tun");
  const tunAddrs: string[] = Array.isArray(tunIn?.address)
    ? tunIn.address : tunIn?.address ? [tunIn.address] : [];
  const tunAddr = tunAddrs.find((a) => /^(172\.|10\.|192\.168\.|198\.51\.100\.)/.test(a));
  if (!tunAddr) throw new Error("未找到 TUN 地址");
  const dnsAddr = tunAddr.split("/")[0].replace(/\.1$/, ".2");

  interface Sample { group: string; domain: string; round: number; ok: boolean; ms: number; answer: string; path: string }
  const samples: Sample[] = [];
  for (let round = 1; round <= ROUNDS; round++) {
    for (const [group, domains] of Object.entries(DOMAINS)) {
      for (const domain of domains) {
        const r = sh(
          `/usr/bin/dig +time=2 +tries=1 +noall +answer +stats ${domain} @${dnsAddr} 2>&1`,
        );
        const ms = Number(/Query time:\s*(\d+)/.exec(r.out)?.[1] ?? -1);
        // +noall 滤掉了 HEADER 段,没有 status: 字样;收到服务器响应(MSG SIZE 行)即成功应答
        const ok = r.code === 0 && /MSG SIZE\s+rcvd:/.test(r.out);
        const status = ok ? "NOERROR" : "TIMEOUT";
        // 只认 answer 记录行:;; 注释行含 SERVER/WHEN 里的 IP,会污染路径判别
        const answerBlock = r.out.split("\n").filter((l) => l && !l.startsWith(";;")).join("\n");
        const ips = [...answerBlock.matchAll(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/g)].map((m) => m[1]);
        const answer = ips.join(",");
        const path = ips.some((ip) => ip.startsWith("198.18.") || ip.startsWith("198.19."))
          ? "fakeip"
          : ips.length > 0
            ? "real-ip"
            : status === "NXDOMAIN"
              ? "nxdomain"
              : "no-answer";
        samples.push({ group, domain, round, ok: status !== "TIMEOUT" && r.code === 0, ms, answer: answer || status, path });
      }
    }
  }

  // 真实出口区域：经 mixed 2080 走完整路由链（cloudflare trace 的 loc 字段）
  const exits: string[] = [];
  for (let i = 0; i < 3; i++) {
    const r = sh(
      `/opt/proxy-test/bin/bun -e 'try{const r=await fetch("https://www.cloudflare.com/cdn-cgi/trace",{proxy:"http://127.0.0.1:2080",signal:AbortSignal.timeout(15000)});console.log(/loc=(\\w+)/.exec(await r.text())?.[1]??"?")}catch(e){console.log("ERR")}'`,
    );
    exits.push(r.out.trim());
  }

  // 1.14 内核 debug 的 DNS 行只有 `dns: lookup domain X`,上游选择细节不落日志
  const dnsLines = logs.split("\n").filter((l) => /dns: lookup domain/i.test(l));
  const dnsLogSample = dnsLines.slice(0, 6).map((l) => l.slice(0, 160));
  const regionHits = [...new Set(
    (logs.match(/(港|HK|Hong|日本|东京|JP|Japan|新加坡|狮城|SG|Singapore|selfhost|vps)[\w-]*/g) ?? []),
  )].slice(0, 12);

  interface GroupAgg {
    queries: number;
    success_rate: number;
    p50_ms: number;
    p95_ms: number;
    paths: Record<string, number>;
  }

  const agg = (group: string): GroupAgg => {
    const s = samples.filter((x) => x.group === group);
    const ok = s.filter((x) => x.ok);
    const lat = ok.map((x) => x.ms).filter((m) => m >= 0).sort((a, b) => a - b);
    const paths = Object.fromEntries(
      [...new Set(s.map((x) => x.path))].map((p) => [p, s.filter((x) => x.path === p).length]),
    );
    return { queries: s.length, success_rate: +(ok.length / s.length).toFixed(3),
      p50_ms: percentile(lat, 50), p95_ms: percentile(lat, 95), paths };
  };

  const report = {
    rounds: ROUNDS,
    dns_upstreams: { intl_doh_via: "dns-auto(urltest 四正则)", cn: "223.5.5.5 直连", lan: "系统上游(禁乐观缓存)" },
    groups: Object.fromEntries(Object.keys(DOMAINS).map((g) => [g, agg(g)])),
    egress_regions: exits,
    log_stats: { dns_lookup_lines: dnsLines.length, dns_log_sample: dnsLogSample, dns_auto_nodes_seen: regionHits },
    samples,
  };

  console.log("\n===== DNS 观测报告 =====");
  for (const [g, a] of Object.entries(report.groups) as [string, GroupAgg][]) {
    console.log(`${g.padEnd(5)} 成功率 ${(a.success_rate * 100).toFixed(1)}%  p50 ${a.p50_ms}ms  p95 ${a.p95_ms}ms  路径 ${JSON.stringify(a.paths)}`);
  }
  console.log(`出口区域: ${exits.join(", ")}`);
  console.log(`日志: DNS lookup 行 ${dnsLines.length}`);
  console.log(`dns-auto 节点样本: ${regionHits.join(", ") || "(无)"}`);
  await Bun.write("dns-observe-report.json", JSON.stringify(report, null, 2));
  console.log("完整样本 → dns-observe-report.json");
  cleanup();
}

main().catch((e: unknown) => { console.error(String(e)); process.exit(1); });
