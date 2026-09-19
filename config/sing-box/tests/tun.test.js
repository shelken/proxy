// 内核层：TUN 设备与路由表必须按预期安装。需要特权。
//
// 不断言 ICMP：部分内网主机不响应 ping 但 TCP 正常，用 ping 会得到假失败。

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { startSandbox, WORK } from "./lib/sandbox.js";

const PUBLIC = `${WORK}/public.json`;
const OVERLAY = `${WORK}/tests/overlay.json`;

let sb;

beforeAll(async () => {
  sb = startSandbox();
  await sb.waitFor("sing-box started");
  await sb.waitFor("tun0");
});

afterAll(async () => {
  await sb?.stop();
});

function run(cmd) {
  const proc = Bun.spawnSync(cmd);
  return proc.stdout.toString();
}

describe("tun interface", () => {
  test("tun0 exists and is up", () => {
    const out = run(["ip", "-br", "link", "show", "tun0"]);
    expect(out).toContain("tun0");
    expect(out).toContain("UP");
  });

  test("public traffic is routed into the tun", () => {
    expect(run(["ip", "route", "get", "1.1.1.1"])).toContain("tun0");
  });

  test("private LAN ranges are excluded from the tun", () => {
    // route_exclude_address 含 192.168.0.0/16，这段必须留在物理口，
    // 否则内网地址即便解析出真 IP 也无法连通。
    expect(run(["ip", "route", "get", "192.168.1.1"])).not.toContain("tun0");
  });

  test("tailscale CGNAT range is excluded from the tun", () => {
    expect(run(["ip", "route", "get", "100.64.0.1"])).not.toContain("tun0");
  });

  test("mixed inbound on 127.0.0.1:2080 is listening and accepts connections", async () => {
    const socket = await new Promise((resolve, reject) => {
      Bun.connect({
        hostname: "127.0.0.1",
        port: 2080,
        socket: {
          data(sock, data) {},
          open(sock) {
            resolve(sock);
            sock.end();
          },
          error(sock, error) {
            reject(error);
          },
          connectError(sock, error) {
            reject(error);
          },
        },
      });
    });
    expect(socket).toBeDefined();
  });
});
