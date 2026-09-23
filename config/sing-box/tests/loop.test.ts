// 沙箱闭环：驱动服务端真实产物，断言规则集装载与路由裁决。
//
// 被测对象是「服务端响应的那份配置」，不是等价实现（ADR-0003）。
// 配置由 `just sandbox-loop`（宿主机侧）准备好；本文件只在 VM 内断言。
// 观断面是内核 debug 日志：sing-box 每次路由决策打一行
//   router: match[N] rule_set=<tag> => route(<outbound>)

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { startSandbox, type SandboxHandle } from "./lib/sandbox.ts";

const SB = "/opt/proxy-test/bin/sing-box";
const WORK = "/work/sing-box";
const CONFIG = `${WORK}/config.json`;

/**
 * 命中用例：域名/地址取自仓库内自定义清单并固化，上游清单内容持续变动不作 fixture。
 *
 * 只收「独占一条 route 规则」的规则集——内核日志对多集合规则打的是整组标签
 * （`rule_set=[A B C]`），归属不到具体规则集。共用规则的集合见下方 SHARED_RULE_SETS。
 *
 * `outbound` 是断言层级的下界——域名 → 规则集 → 出站，不追到具体节点：
 * 节点是假 URI，被测对象是裁决结果而非代理连通性（ADR-0003）。
 */
const HITS: { value: string; ruleSet: string; outbound: string }[] = [
  { value: "1024proxy.net", ruleSet: "1024", outbound: "1024" },
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

beforeAll(() => {
  if (!existsSync(CONFIG)) {
    throw new Error(
      `未找到 ${CONFIG}。先运行 just sandbox-loop（宿主机侧）准备闭环配置。`,
    );
  }
  sb = startSandbox();
});

afterAll(async () => {
  await sb?.stop();
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
 * 请求打不通是预期内的（节点是假 URI），裁决发生在拨号之前，故不看 curl 的成败。
 */
async function probe(value: string): Promise<void> {
  const proc = Bun.spawn([
    "sh", "-c",
    `curl -s -k -x http://127.0.0.1:2080 -o /dev/null --max-time 4 "https://${value}/" 2>/dev/null || true`,
  ]);
  await proc.exited;
  await sb!.waitFor(new RegExp(`router: sniffed protocol: \\w+, domain: ${value.replace(/\./g, "\\.")}`));
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
  test("底模引用的 32 个规则集产物齐备且内核已完成装载", async () => {
    // 装载失败会让内核 FATAL 退出，waitFor 通过即验证了「全部读入」
    await sb!.waitFor("sing-box started");

    const template = JSON.parse(
      readFileSync(resolve(import.meta.dir, "../template.json"), "utf-8"),
    ) as { route: { rule_set: { tag: string }[] } };
    expect(template.route.rule_set).toHaveLength(32);

    // 逐个确认文件存在：区分「内核没读」与「产物根本没生成」
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
