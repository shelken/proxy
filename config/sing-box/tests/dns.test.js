// 决策层：验证 DNS 规则真的把查询送给了预期的上游。需要特权（TUN）。
//
// sing-box 不暴露「这次查询走了哪个上游」，所以用两个分别监听 15353 与
// 15354 的夹具各自记录域名，用互斥断言确定上游选择。
//
// 触发方式必须绕开 getaddrinfo：Ubuntu 的 systemd-resolved 占着
// 127.0.0.53，发往本地接口的查询不进 TUN。

import { describe, expect, test, beforeAll, afterAll, beforeEach, setDefaultTimeout } from "bun:test";
import { startSandbox, startDnsFixture, WORK } from "./lib/sandbox.js";

// 夹具启动、sing-box 启动与每次查询后的等待合起来超过默认的 5 秒 hook 上限。
setDefaultTimeout(30_000);

const PUBLIC = `${WORK}/public.json`;
const OVERLAY = `${WORK}/tests/overlay.json`;

const FX_A = { port: 15353, logPath: "/tmp/fx-a.log" };
const FX_B = { port: 15354, logPath: "/tmp/fx-b.log" };

let sb;
let a;
let b;

beforeAll(async () => {
  a = await startDnsFixture(FX_A);
  b = await startDnsFixture(FX_B);
  sb = startSandbox({ publicConfig: PUBLIC, overlay: OVERLAY });
  await sb.waitFor("sing-box started", 20_000);
});

afterAll(async () => {
  await sb?.stop();
  await a?.stop();
  await b?.stop();
});

beforeEach(async () => {
  await Bun.write(FX_A.logPath, "");
  await Bun.write(FX_B.logPath, "");
});

/** 构造一个 A 查询报文。 */
function buildQuery(name) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(Math.floor(Math.random() * 65535), 0); // ID
  header.writeUInt16BE(0x0100, 2); // 标准查询，RD
  header.writeUInt16BE(1, 4); // QDCOUNT

  const labels = name.split(".").flatMap((label) => [
    Buffer.from([label.length]),
    Buffer.from(label, "ascii"),
  ]);
  const question = Buffer.concat([...labels, Buffer.from([0])]);

  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(1, 0); // TYPE A
  tail.writeUInt16BE(1, 2); // CLASS IN

  return Buffer.concat([header, question, tail]);
}

// 必须发给 TUN 派生的 DNS 地址，不能发给 223.5.5.5 这类公网地址。
//
// dns_address 未设时，sing-box 取 address 首个 IPv4 的下一个地址：
// 172.19.0.1/30 → 172.19.0.2，并发往该地址的连接自动劫持进 DNS 模块。
// 发给公网 :53 的包只会被当成普通 UDP 路由出去（日志里是
// "outbound/direct[proxy]: outbound packet connection"），不经过 DNS 模块。
const DNS_TRIGGER = "172.19.0.2";

/** 向 TUN 的 DNS 地址发一次查询，等夹具记下来。 */
async function query(name) {
  const socket = await Bun.udpSocket({
    connect: { hostname: DNS_TRIGGER, port: 53 },
  });
  socket.send(buildQuery(name));
  await Bun.sleep(1_200);
  socket.close();
}

describe("dns routing", () => {
  test("an internal domain goes to the internal upstream", async () => {
    await query("zone.test");
    expect(await a.waitForQuery("zone.test")).toContain("zone.test");
    expect(await b.queried()).not.toContain("zone.test");
  });

  test("a .cn domain goes to the domestic upstream", async () => {
    await query("example.cn");
    expect(await b.waitForQuery("example.cn")).toContain("example.cn");
    expect(await a.queried()).not.toContain("example.cn");
  });

  test("an unlisted domain falls through to the final upstream", async () => {
    await query("example.org");
    expect(await b.waitForQuery("example.org")).toContain("example.org");
    expect(await a.queried()).not.toContain("example.org");
  });
});
