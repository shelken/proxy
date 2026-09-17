// 决策层：验证路由规则真的把连接交给了预期的出站。需要特权（TUN）。
//
// 观测面是 debug 日志里的 outbound/<type>[<tag>] 行。每个用例先 clear()
// 再发一次请求，然后统计各出站命中次数。

import { describe, expect, test, beforeAll, afterAll, beforeEach, setDefaultTimeout } from "bun:test";
import { startSandbox, startDnsFixture, WORK } from "./lib/sandbox.js";

// 这两个夹具的启动、sing-box 的启动、以及每次 fetch 后的等待
// 合起来超过 bun test 默认的 5 秒 hook 上限。
setDefaultTimeout(30_000);

const PUBLIC = `${WORK}/public.json`;
const OVERLAY = `${WORK}/tests/overlay.json`;

let sb;
let fixtures = [];

beforeAll(async () => {
  fixtures = [
    await startDnsFixture({ port: 15353, logPath: "/tmp/fx-a.log" }),
    await startDnsFixture({ port: 15354, logPath: "/tmp/fx-b.log" }),
  ];
  sb = startSandbox({ publicConfig: PUBLIC, overlay: OVERLAY });
  await sb.waitFor("sing-box started");
});

afterAll(async () => {
  await sb?.stop();
  for (const f of fixtures) await f.stop();
});

beforeEach(() => {
  sb.clear();
});

/** 经 mixed 入站发一次请求并等它落到某个出站。夹具回的是 192.0.2.x，不可路由，必然失败。
 *
 * 必须走显式代理而不是直连：直连会走 getaddrinfo，命中 Ubuntu 的
 * systemd-resolved（127.0.0.53），查询不进 TUN，测试会挂在域名解析上。
 * 经 mixed-in 进 sing-box 时由 sniff 从 Host 头拿到域名，被测的正是路由决策。
 */
async function request(url) {
  try {
    await fetch(url, {
      proxy: "http://127.0.0.1:2080",
      signal: AbortSignal.timeout(4_000),
    });
  } catch {
    // 断言的是路由决策，不是可达性。
  }
  await Bun.sleep(300);
}

describe("route decisions", () => {
  test("an internal domain goes direct", async () => {
    await request("http://foo.zone.test/");
    expect(sb.outboundHits("direct")).toBeGreaterThan(0);
    expect(sb.outboundHits("proxy")).toBe(0);
  });

  test("an unlisted domain falls through to the final outbound", async () => {
    // example.cn 只被 dns.rules 的 ChinaMax 引用，route.rules 不引用它，
    // 因此路由层落到 route.final。这个用例同时证明日志确实在记录决策。
    await request("http://example.cn/");
    expect(sb.outboundHits("proxy")).toBeGreaterThan(0);
  });
});
