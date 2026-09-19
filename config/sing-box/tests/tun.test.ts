// 内核层：TUN 设备与路由表必须按预期安装。需要特权。

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { startSandbox, type SandboxHandle } from "./lib/sandbox.ts";

let sb: SandboxHandle | undefined;

beforeAll(async () => {
  sb = startSandbox();
  await sb.waitFor("sing-box started");
  await sb.waitFor("tun0");
});

afterAll(async () => {
  await sb?.stop();
});

function run(cmd: string[]): string {
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
    expect(run(["ip", "route", "get", "192.168.1.1"])).not.toContain("tun0");
  });

  test("tailscale CGNAT range is excluded from the tun", () => {
    expect(run(["ip", "route", "get", "100.64.0.1"])).not.toContain("tun0");
  });

  test("mixed inbound on 127.0.0.1:2080 is listening and accepts connections", async () => {
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    Bun.connect({
      hostname: "127.0.0.1",
      port: 2080,
      socket: {
        data(_sock, _data) {},
        open(sock) {
          resolve(sock);
          sock.end();
        },
        error(_sock, error) {
          reject(error);
        },
        connectError(_sock, error) {
          reject(error);
        },
      },
    });
    const socket = await promise;
    expect(socket).toBeDefined();
  });
});
