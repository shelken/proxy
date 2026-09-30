// 内核层：TUN 路由排除与 DNS 劫持。需要特权，只在沙箱 VM 内运行。
//
// 观测面是内核自身：路由表查询结果与客户端实际收到的 DNS 应答。
// 三个行为各自带一条反向对照，缺掉被测配置时断言必须失败。

import { describe, expect, test, afterAll } from "bun:test";
import { createSocket } from "node:dgram";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SING_BOX, WORK } from "./lib/sandbox.ts";

const template = JSON.parse(
  await readFile(new URL("../template.json", import.meta.url), "utf8"),
);

const ROOT = await mkdtemp(join(tmpdir(), "sb-kernel-routing-"));

function run(cmd) {
  const proc = Bun.spawnSync(cmd);
  return proc.stdout.toString();
}

async function start(config, dir) {
  await mkdir(dir, { recursive: true });
  const path = join(dir, "config.json");
  await writeFile(path, JSON.stringify(config));
  const proc = Bun.spawn(["sudo", "-n", SING_BOX, "run", "-D", WORK, "-c", path], {
    stdout: "pipe",
    stderr: "pipe",
  });
  let log = "";
  const drain = async (stream) => {
    for await (const chunk of stream) log += new TextDecoder().decode(chunk);
  };
  const drains = Promise.all([drain(proc.stdout), drain(proc.stderr)]);
  const stop = async () => {
    if (proc.exitCode === null) proc.kill("SIGTERM");
    await proc.exited;
    await drains;
    // sing-box 退出后才删 auto_route 装的路由；不等设备消失，下一个 TUN
    // 内核会在 `add route 0: file exists` 上启动失败
    for (let i = 0; i < 100; i++) {
      if (Bun.spawnSync(["ip", "link", "show", "tun0"]).exitCode !== 0) return;
      await Bun.sleep(50);
    }
    throw new Error("tun0 未在预期时间内消失");
  };
  return { waitFor: async (pattern, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (pattern.test(log)) return log;
      if (proc.exitCode !== null) throw new Error(`内核启动失败:\n${log}`);
      await Bun.sleep(50);
    }
    throw new Error(`等待 /${pattern}/ 超时:\n${log}`);
  }, log: () => log, stop, exitCode: () => proc.exitCode };
}

function dnsQuery(name, type, host, port = 53) {
  return new Promise((resolve, reject) => {
    const sock = createSocket("udp4");
    const header = Buffer.alloc(12);
    header.writeUInt16BE(123);
    header.writeUInt16BE(0x100, 2);
    header.writeUInt16BE(1, 4);
    const question = Buffer.concat([
      ...name.split(".").map(l => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])),
      Buffer.from([0, type >> 8, type & 255, 0, 1]),
    ]);
    const timer = setTimeout(() => { sock.close(); reject(new Error(`DNS 超时 ${name}@${host}`)); }, 2000);
    sock.on("message", packet => { clearTimeout(timer); sock.close(); resolve(packet); });
    sock.send(Buffer.concat([header, question]), port, host);
  });
}

// 模板 TUN 入站原样使用；auto_route 会改写路由表，测试结束后由内核停止复原。
function tunsConfig(extraRules = []) {
  const tun = structuredClone(template.inbounds.find(i => i.type === "tun"));
  const servers = structuredClone(template.dns.servers);
  for (const server of servers) {
    if (server.type === "udp") { server.server = "127.0.0.1"; server.server_port = 15354; }
    if (server.type === "https") { server.server = "127.0.0.1"; server.server_port = 15354; server.tls = { enabled: false }; }
  }
  return {
    log: { level: "debug" },
    inbounds: [tun],
    outbounds: [
      { type: "direct", tag: "direct" },
      { type: "socks", tag: template.dns.servers.find(s => s.tag === "dns-proxy").detour, server: "127.0.0.1", server_port: 15355 },
    ],
    dns: { ...structuredClone(template.dns), servers },
    route: {
      default_domain_resolver: "dns-local-system",
      rules: [...structuredClone(template.route.rules), ...extraRules],
      final: "direct",
      rule_set: (template.route.rule_set ?? []).map(rs => ({ type: "inline", tag: rs.tag, rules: [{ domain: ["nonmatching.invalid"] }] })),
    },
  };
}

describe("TUN 路由排除与 DNS 劫持", () => {
  test("环回与有限广播不进 TUN，公网进 TUN，私网排除", async () => {
    const dir = join(ROOT, "excludes");
    await rm(dir, { recursive: true, force: true });
    const core = await start(tunsConfig(), dir);
    try {
      await core.waitFor(/sing-box started/);
      await core.waitFor(/tun0/);
      expect(run(["ip", "route", "get", "1.1.1.1"])).toContain("tun0");
      expect(run(["ip", "route", "get", "192.168.1.1"])).not.toContain("tun0");
      expect(run(["ip", "route", "get", "255.255.255.255"])).not.toContain("tun0");
      expect(run(["ip", "route", "get", "127.0.0.1"])).toContain(" lo");
    } finally {
      await core.stop();
    }
  }, 30000);

  test("无劫持规则时发往任意目的地址 53 端口的查询得不到应答", async () => {
    const dir = join(ROOT, "no-hijack");
    await rm(dir, { recursive: true, force: true });
    const config = tunsConfig();
    config.route.rules = config.route.rules.filter(
      rule => rule.action !== "hijack-dns",
    );
    const core = await start(config, dir);
    try {
      await core.waitFor(/sing-box started/);
      await core.waitFor(/tun0/);
      let answered = false;
      try { await dnsQuery("external.test", 1, "203.0.113.53"); answered = true; } catch {}
      expect(answered).toBe(false);
    } finally {
      await core.stop();
    }
  }, 30000);

  test("保留劫持规则后同一查询被内核 DNS 接管", async () => {
    const dir = join(ROOT, "hijack");
    await rm(dir, { recursive: true, force: true });
    const core = await start(tunsConfig(), dir);
    try {
      await core.waitFor(/sing-box started/);
      await core.waitFor(/tun0/);
      const answer = await dnsQuery("external.test", 1, "203.0.113.53");
      expect(answer.readUInt16BE(2) & 15).toBe(0);
      expect(answer.readUInt16BE(6)).toBe(1);
      expect(Array.from(answer.subarray(-4)).join(".")).toMatch(/^198\.18\./);
    } finally {
      await core.stop();
    }
  }, 30000);

  test("DNS 服务端 detour 指向空 direct 出站时内核拒绝启动", async () => {
    const dir = join(ROOT, "empty-detour");
    await rm(dir, { recursive: true, force: true });
    const config = tunsConfig();
    const udp = config.dns.servers.find(s => s.type === "udp");
    udp.detour = "direct";
    await expect((async () => {
      const core = await start(config, dir);
      try { await core.waitFor(/sing-box started/, 4000); } finally { await core.stop(); }
    })()).rejects.toThrow(/detour to an empty direct outbound makes no sense/);
  }, 30000);
});

afterAll(async () => { await rm(ROOT, { recursive: true, force: true }); });
