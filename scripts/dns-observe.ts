/**
 * DNS 系统性观测（沙箱侧）
 *
 * 在隔离网络命名空间的临时容器内起服务端并采样 DNS 路径与真实出口区域。
 */

import { existsSync, readFileSync } from "node:fs";
import { bootstrap } from "./sandbox-loop.ts";
import { SANDBOX_WORK, parseEnv, withSandbox } from "./sandbox.ts";

const WORK = SANDBOX_WORK;
const ROUNDS = 5;

const DOMAINS: Record<string, string[]> = {
  intl: ["google.com", "github.com", "youtube.com", "cloudflare.com", "openai.com"],
  cn: ["baidu.com", "qq.com", "bilibili.com", "taobao.com", "jd.com"],
  lan: ["router.lan", "nas.local", "printer.home.arpa"],
};

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

  await withSandbox(async (box) => {
    console.log(`[OBS] 真实数据装配（订阅 ${subs.length}，私有节点 ${nodes.length}）...`);
    bootstrap(box, { nodes, subs });

    const check = box.exec(`sing-box check -D ${WORK} -c ${WORK}/config.json`);
    if (check.code !== 0) throw new Error(`配置校验失败: ${check.err || check.out}`);

    const sbProc = box.spawn(["sing-box", "run", "-D", WORK, "-c", `${WORK}/config.json`], WORK);
    let logs = "";
    const pump = async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        logs += new TextDecoder().decode(value);
      }
    };
    void pump(sbProc.stdout);
    void pump(sbProc.stderr);

    const stopKernel = () => {
      box.exec("pkill -9 -x sing-box || true");
      sbProc.kill();
    };

    try {
      const t0 = Date.now();
      while (!logs.includes("sing-box started") && Date.now() - t0 < 8_000) await Bun.sleep(100);
      if (!logs.includes("sing-box started")) {
        console.error("内核启动超时:\n" + logs.slice(-2000));
        process.exit(1);
      }
      console.log("[OBS] 内核就绪，开始采样");

      const tunIn = JSON.parse(box.exec(`cat ${WORK}/config.json`).out).inbounds.find(
        (i: { type: string }) => i.type === "tun",
      );
      const tunAddrs: string[] = Array.isArray(tunIn?.address)
        ? tunIn.address
        : tunIn?.address
          ? [tunIn.address]
          : [];
      const tunAddr = tunAddrs.find((a) => /^(172\.|10\.|192\.168\.|198\.51\.100\.)/.test(a));
      if (!tunAddr) throw new Error("未找到 TUN 地址");
      const dnsAddr = tunAddr.split("/")[0].replace(/\.1$/, ".2");

      interface Sample {
        group: string;
        domain: string;
        round: number;
        ok: boolean;
        ms: number;
        answer: string;
        path: string;
      }
      const samples: Sample[] = [];
      for (let round = 1; round <= ROUNDS; round++) {
        for (const [group, domains] of Object.entries(DOMAINS)) {
          for (const domain of domains) {
            const r = box.exec(
              `dig +time=2 +tries=1 +noall +answer +stats ${domain} @${dnsAddr} 2>&1`,
            );
            const ms = Number(/Query time:\s*(\d+)/.exec(r.out)?.[1] ?? -1);
            const ok = r.code === 0 && /MSG SIZE\s+rcvd:/.test(r.out);
            const status = ok ? "NOERROR" : "TIMEOUT";
            const answerBlock = r.out
              .split("\n")
              .filter((l) => l && !l.startsWith(";;"))
              .join("\n");
            const ips = [...answerBlock.matchAll(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/g)].map(
              (m) => m[1],
            );
            const answer = ips.join(",");
            const path = ips.some((ip) => ip.startsWith("198.18.") || ip.startsWith("198.19."))
              ? "fakeip"
              : ips.length > 0
                ? "real-ip"
                : status === "NXDOMAIN"
                  ? "nxdomain"
                  : "no-answer";
            samples.push({
              group,
              domain,
              round,
              ok: status !== "TIMEOUT" && r.code === 0,
              ms,
              answer: answer || status,
              path,
            });
          }
        }
      }

      const exits: string[] = [];
      for (let i = 0; i < 3; i++) {
        const r = box.exec(
          `bun -e 'try{const r=await fetch("https://www.cloudflare.com/cdn-cgi/trace",{proxy:"http://127.0.0.1:2080",signal:AbortSignal.timeout(15000)});console.log(/loc=(\\w+)/.exec(await r.text())?.[1]??"?")}catch(e){console.log("ERR")}'`,
        );
        exits.push(r.out.trim());
      }

      const dnsLines = logs.split("\n").filter((l) => /dns: lookup domain/i.test(l));
      const dnsLogSample = dnsLines.slice(0, 6).map((l) => l.slice(0, 160));
      const regionHits = [
        ...new Set(
          logs.match(/(港|HK|Hong|日本|东京|JP|Japan|新加坡|狮城|SG|Singapore|selfhost|vps)[\w-]*/g) ??
            [],
        ),
      ].slice(0, 12);

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
        const lat = ok
          .map((x) => x.ms)
          .filter((m) => m >= 0)
          .sort((a, b) => a - b);
        const paths = Object.fromEntries(
          [...new Set(s.map((x) => x.path))].map((p) => [
            p,
            s.filter((x) => x.path === p).length,
          ]),
        );
        return {
          queries: s.length,
          success_rate: +(ok.length / s.length).toFixed(3),
          p50_ms: percentile(lat, 50),
          p95_ms: percentile(lat, 95),
          paths,
        };
      };

      const report = {
        rounds: ROUNDS,
        dns_upstreams: {
          intl_doh_via: "dns-auto(urltest 四正则)",
          cn: "223.5.5.5 直连",
          lan: "系统上游(禁乐观缓存)",
        },
        groups: Object.fromEntries(Object.keys(DOMAINS).map((g) => [g, agg(g)])),
        egress_regions: exits,
        log_stats: {
          dns_lookup_lines: dnsLines.length,
          dns_log_sample: dnsLogSample,
          dns_auto_nodes_seen: regionHits,
        },
        samples,
      };

      console.log("\n===== DNS 观测报告 =====");
      for (const [g, a] of Object.entries(report.groups) as [string, GroupAgg][]) {
        console.log(
          `${g.padEnd(5)} 成功率 ${(a.success_rate * 100).toFixed(1)}%  p50 ${a.p50_ms}ms  p95 ${a.p95_ms}ms  路径 ${JSON.stringify(a.paths)}`,
        );
      }
      console.log(`出口区域: ${exits.join(", ")}`);
      console.log(`日志: DNS lookup 行 ${dnsLines.length}`);
      console.log(`dns-auto 节点样本: ${regionHits.join(", ") || "(无)"}`);
      await Bun.write("dns-observe-report.json", JSON.stringify(report, null, 2));
      console.log("完整样本 → dns-observe-report.json");
    } finally {
      stopKernel();
    }
  }, "proxy-dns-observe");
}

main().catch((e: unknown) => {
  console.error(String(e));
  process.exit(1);
});
