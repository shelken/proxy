// 沙箱闭环：驱动服务端真实产物，断言规则集装载与路由裁决。
//
// 被测对象是「服务端响应的那份配置」，不是等价实现（ADR-0003）。
// 配置由 `just sandbox-loop`（宿主机侧）准备好；本文件只在 VM 内断言。
// 观断面是内核 debug 日志：sing-box 每次路由决策打一行
//   router: match[N] rule_set=<tag> => route(<outbound>)

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { createSocket, type Socket } from "node:dgram";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { startSandbox, type SandboxHandle } from "./lib/sandbox.ts";

const SB = "/opt/proxy-test/bin/sing-box";
const WORK = "/work/sing-box";
const CONFIG = `${WORK}/config.json`;

/**
 * 合成 DNS 上游的绑定端口。避开 15353/15354（dns-behavior.test.js）与 15355
 * （kernel-routing.test.js 的 socks 目的端口）。
 */
const UPSTREAM_PORT = 15356;

/** 固定 A 记录，取自 TEST-NET-3（RFC 5737，保留给文档与测试）。断言的是路由
 *  裁决而非解析结果，具体取值无关紧要。 */
const UPSTREAM_IP = Buffer.from([203, 0, 113, 7]);

/**
 * 应答任意 A 查询，AAAA 返回空。`resolve` 用 `strategy: ipv4_only`，只查 A。
 */
function buildResponse(query: Buffer): Buffer {
  let end = 12;
  while (query[end] !== 0) end += query[end] + 1;
  end += 1;
  const qtype = query.readUInt16BE(end);
  const question = query.subarray(12, end + 4);
  const header = Buffer.alloc(12);
  query.copy(header, 0, 0, 2);
  header.writeUInt16BE(0x8180, 2); // QR=1 RD=1 RA=1
  header.writeUInt16BE(1, 4); // QDCOUNT
  const answering = qtype === 1;
  header.writeUInt16BE(answering ? 1 : 0, 6);
  const parts = [header, question];
  if (answering) {
    const rr = Buffer.alloc(16);
    rr.writeUInt16BE(0xc00c, 0); // 压缩指针 → 问题里的 QNAME
    rr.writeUInt16BE(1, 2); // TYPE A
    rr.writeUInt16BE(1, 4); // CLASS IN
    rr.writeUInt32BE(60, 6); // TTL
    rr.writeUInt16BE(4, 10); // RDLENGTH
    UPSTREAM_IP.copy(rr, 12);
    parts.push(rr);
  }
  return Buffer.concat(parts);
}

/**
 * 把远程 DNS server 全部指向合成上游，并去掉 detour 与 TLS。
 *
 * 只改「沙箱零外网」带来的传输差异，不动 `dns.rules` 与 `route.rules`——
 * 被断言的语义是路由裁决。改完夹具域名无需真实存在，测试也不再随第三方
 * 域名下线而假红：那类失败与规则回归在日志里长得一样，是最坏的假红。
 */
function useLocalUpstream(config: Record<string, any>): void {
  for (const server of config.dns?.servers ?? []) {
    if (server.type !== "udp" && server.type !== "https") continue;
    delete server.tls;
    delete server.detour;
    server.type = "udp";
    server.server = "127.0.0.1";
    server.server_port = UPSTREAM_PORT;
  }
}

/**
 * 命中用例：域名/地址取自仓库内自定义清单并固化，上游清单内容持续变动不作 fixture。
 *
 * 只收「独占一条 route 规则」的规则集——内核日志对多集合规则打的是整组标签
 * （`rule_set=[A B C]`），归属不到具体规则集。共用规则的集合见下方 SHARED_RULE_SETS。
 *
 * `outbound` 是断言层级的下界——域名 → 规则集 → 出站，不追到具体节点：
 * 节点是假 URI，被测对象是裁决结果而非代理连通性（ADR-0003）。
 *
 * 域名只需命中规则集，**不依赖真实 DNS**：`beforeAll` 把远程 DNS server 全部
 * 指向 VM 内的合成上游（应答 TEST-NET-3 地址）。此前夹具直接依赖公网解析，
 * 1024proxy.net / s.dsqcjk.com / pokemontcgpocket.com 下线后让三条断言长期假红，
 * 而「夹具失效」与「规则回归」在日志里都是「取不到裁决行」，无法区分——
 * 这是最坏的假红，掩盖真回归。合成上游从根上消除该外部依赖。
 * 域名仍须命中对应规则集：这是断言的真实约束，取自仓库自有清单。
 */
const HITS: { value: string; ruleSet: string; outbound: string }[] = [
  { value: "1024proxy.net", ruleSet: "1024proxy", outbound: "1024proxy" },
  { value: "api.anthropic.com", ruleSet: "Anthropic", outbound: "anthropic" },
  { value: "s.dsqcjk.com", ruleSet: "Adult", outbound: "adultnsfw" },
  { value: "guzzoni.apple.com", ruleSet: "Apple-AI", outbound: "appleai" },
  { value: "ai.google.dev", ruleSet: "Gemini", outbound: "gemini" },
  { value: "dmm.co.jp", ruleSet: "Japan", outbound: "japansite" },
  { value: "api.openai.com", ruleSet: "OpenAI", outbound: "openai" },
  { value: "brew.sh", ruleSet: "dev", outbound: "dev" },
  { value: "api.x.ai", ruleSet: "grok", outbound: "grok" },
  { value: "opencode.ai", ruleSet: "opencode", outbound: "opencode" },
  { value: "pokemontcgpocket.com", ruleSet: "ptcg", outbound: "ptcg" },
  { value: "z.ai", ruleSet: "zai", outbound: "zai" },
];

/**
 * 这些规则集不独占路由规则，内核日志只打出整组标签，无法归属到具体规则集：
 * - MyDirect / cftunnel / geoip-cn 与 ChinaMax / Lan 同属 route 规则（=> direct）
 * - MyProxy 与 Facebook / Instagram / Telegram 等同属 route 规则（=> proxy）
 * - MyReject / Advertising 与 Hijacking / Privacy 同属 => reject 规则
 * - ChinaMax-dns 只在 dns.rules 里，观测面是解析结果而非路由
 * 改由内核自带的离线匹配器逐个验证（同一份 .srs 产物、同一套匹配引擎）。
 */
const SHARED_RULE_SETS = [
  { value: "kelee.one", ruleSet: "MyDirect" },
  { value: "poe.com", ruleSet: "MyProxy" },
  { value: "loggw-ex.alipay.com", ruleSet: "MyReject" },
  { value: "doubleclick.net", ruleSet: "Advertising" },
  { value: "198.41.192.1", ruleSet: "cftunnel" },
  { value: "114.114.114.114", ruleSet: "geoip-cn" },
  { value: "taobao.com", ruleSet: "ChinaMax-dns" },
];

function sh(cmd: string): { code: number | null; out: string } {
  const p = Bun.spawnSync(["sh", "-c", cmd]);
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
}

let sb: SandboxHandle | undefined;
let upstream: Socket | undefined;

/** 改写后的配置路径：夹具域名走合成上游，不依赖任何真实域名存活。 */
const CONFIG_WITH_UPSTREAM = `${WORK}/loop-config.json`;

beforeAll(() => {
  if (!existsSync(CONFIG)) {
    throw new Error(
      `未找到 ${CONFIG}。先运行 just sandbox-loop（宿主机侧）准备闭环配置。`,
    );
  }

  upstream = createSocket("udp4");
  upstream.on("message", (packet, peer) => {
    upstream!.send(buildResponse(packet), peer.port, peer.address);
  });
  upstream.bind(UPSTREAM_PORT, "127.0.0.1");

  const config = JSON.parse(readFileSync(CONFIG, "utf8"));
  useLocalUpstream(config);
  writeFileSync(CONFIG_WITH_UPSTREAM, JSON.stringify(config));

  sb = startSandbox({ configPath: CONFIG_WITH_UPSTREAM });
});

afterAll(async () => {
  await sb?.stop();
  upstream?.close();
});

/**
 * 经 mixed 入站注入一个请求，并等到该目的地的裁决行落到日志里。
 *
 * 必须异步：日志由后台 drain 循环从管道灌入 output，同步阻塞（spawnSync）期间
 * 事件循环不转，读到的日志会缺掉刚产生的那几行——表现为「裁决行不存在」的假失败。
 *
 * 等待的是真实信号（日志里出现该目的地的嗅探行），不是固定时长：嗅探行一出现就
 * 说明这条连接已进入路由阶段，紧随其后的裁决行必然已在同一次输出刷新里。
 *
 * 请求打不通是预期内的（节点假 URI，合成上游回 TEST-NET-3 不可路由地址），
 * 裁决发生在拨号之前，故不看 curl 的成败。
 *
 * 先等日志再收尾：日志由后台 drain 灌入，且嗅探行出现时裁决行已在同一次刷新里。
 * 若先 `await proc.exited`，每个用例都要白等满 curl 的连接超时——目标地址不可路由
 * 时那接近 --max-time，30 个用例会累积成分钟级。
 */
async function probe(value: string): Promise<void> {
  // 直接 spawn curl（不经 sh）让 kill 作用到 curl 本身，否则只杀外壳、留下孤儿
  const proc = Bun.spawn([
    "curl", "-s", "-k", "-x", "http://127.0.0.1:2080", "-o", "/dev/null",
    "--max-time", "10", `https://${value}/`,
  ]);
  try {
    await sb!.waitFor(
      new RegExp(`router: sniffed protocol: \\w+, domain: ${value.replace(/\./g, "\\.")}`),
    );
  } finally {
    // 裁决已落日志，连接的成与败都不再影响断言
    proc.kill();
  }
  await proc.exited;
}

/**
 * 取该目的地对应的裁决行。
 *
 * 先定位嗅探行确认请求确实进了内核——否则「没有裁决行」既可能是规则没命中，
 * 也可能是请求根本没发出，两者必须能区分。纯 IP 目的地不会有嗅探行。
 */
function decision(log: string, value: string): string | undefined {
  const lines = log.split("\n");
  const sniff = lines.findIndex(
    (l) => l.includes("router: sniffed protocol") && l.includes(value),
  );
  const from = sniff === -1 ? 0 : sniff;
  return lines
    .slice(from)
    .find((l) => l.includes("router: match") && l.includes("=> route("));
}

describe("规则集装载", () => {
  test("底模引用的每个规则集产物齐备且内核已完成装载", async () => {
    // 装载失败会让内核 FATAL 退出，waitFor 通过即验证了「全部读入」
    await sb!.waitFor("sing-box started");

    const template = JSON.parse(
      readFileSync(resolve(import.meta.dir, "../template.json"), "utf-8"),
    ) as { route: { rule_set: { tag: string }[] } };

    // 逐个确认文件存在：区分「内核没读」与「产物根本没生成」。
    // 不比对数量：数量由底模决定，写死只在加规则集时制造假失败。
    const missing = template.route.rule_set
      .map((rs) => rs.tag)
      .filter((tag) => !existsSync(`${WORK}/rules/${tag}.srs`));
    expect(missing).toEqual([]);
  });

  test("产物损坏能被检出", () => {
    // 截断一个产物，内核必须拒绝而不是静默按空规则集处理
    const r = sh(`
      cp ${WORK}/rules/OpenAI.srs /tmp/openai.bak
      head -c 16 /tmp/openai.bak > ${WORK}/rules/OpenAI.srs
      ${SB} check -c ${CONFIG} >/dev/null 2>&1; echo "exit=$?"
      cp /tmp/openai.bak ${WORK}/rules/OpenAI.srs
    `);
    expect(r.out).toContain("exit=1");
  });
});

describe("路由裁决命中", () => {
  for (const { value, ruleSet, outbound } of HITS) {
    test(`${value} => ${ruleSet} => ${outbound}`, async () => {
      await probe(value);
      const line = decision(sb!.log(), value);
      expect(line).toBeDefined();
      expect(line).toContain(`rule_set=${ruleSet}`);
      expect(line?.toLowerCase()).toContain(`route(${outbound.toLowerCase()})`);
    });
  }
});

describe("共享规则集与 DNS 伴生集", () => {
  for (const { value, ruleSet } of SHARED_RULE_SETS) {
    test(`${value} 命中 ${ruleSet}`, () => {
      // 命中信息走 stderr（stdout 恒空、退出码恒 0），故按输出非空判定
      const r = sh(
        `${SB} rule-set match -f binary ${WORK}/rules/${ruleSet}.srs ${value} 2>&1 1>/dev/null`,
      );
      expect(r.out.trim()).not.toBe("");
    });
  }

  test("未命中时不报匹配", () => {
    // 反向对照：匹配器不是恒真，否则上面三条断言无意义
    const r = sh(
      `${SB} rule-set match -f binary ${WORK}/rules/OpenAI.srs brew.sh 2>&1 1>/dev/null`,
    );
    expect(r.out.trim()).toBe("");
  });
});
