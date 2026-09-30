import { test, expect } from "bun:test";
import { createSocket } from "node:dgram";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SING_BOX } from "./lib/sandbox.ts";

const template = JSON.parse(await readFile(new URL("../template.json", import.meta.url), "utf8"));

function question(name, type) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(123);
  header.writeUInt16BE(0x100, 2);
  header.writeUInt16BE(1, 4);
  return Buffer.concat([header, ...name.split(".").map(label => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])), Buffer.from([0, type >> 8, type & 255, 0, 1])]);
}
function response(packet) {
  let end = 12;
  while (packet[end]) end += packet[end] + 1;
  end++;
  const type = packet.readUInt16BE(end);
  const header = Buffer.from(packet.subarray(0, 12));
  header.writeUInt16BE(0x8180, 2);
  const data = type === 65 ? Buffer.from([0, 1, 0, 0, 1, 0, 3, 2, 104, 50]) : null;
  header.writeUInt16BE(data ? 1 : 0, 6);
  const rr = Buffer.alloc(12);
  rr.writeUInt16BE(0xc00c); rr.writeUInt16BE(type, 2); rr.writeUInt16BE(1, 4); rr.writeUInt32BE(30, 6); rr.writeUInt16BE(data?.length ?? 0, 10);
  return Buffer.concat([header, packet.subarray(12, end + 4), ...(data ? [rr, data] : [])]);
}
function query(name, type, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const socket = createSocket("udp4");
    const timer = setTimeout(() => { socket.close(); reject(new Error("DNS response timeout")); }, timeoutMs);
    socket.once("message", packet => { clearTimeout(timer); socket.close(); resolve(packet); });
    socket.send(question(name, type), 15353, "127.0.0.1");
  });
}
async function start(config, dir) {
  const path = join(dir, "config.json");
  await writeFile(path, JSON.stringify(config));
  const proc = Bun.spawn([SING_BOX, "run", "-D", dir, "-c", path], { stdout: "pipe", stderr: "pipe" });
  let log = "";
  const drain = async stream => { for await (const chunk of stream) log += new TextDecoder().decode(chunk); };
  const drains = Promise.all([drain(proc.stdout), drain(proc.stderr)]);
  const stop = async () => { if (proc.exitCode === null) proc.kill("SIGTERM"); await proc.exited; await drains; };
  for (let i = 0; i < 150; i++) {
    if (log.includes("sing-box started")) return { stop, log: () => log };
    if (proc.exitCode !== null) break;
    await Bun.sleep(20);
  }
  await stop();
  throw new Error(`Kernel startup failed: ${log}`);
}

async function withDNS(run) {
  const dir = await mkdtemp(join(tmpdir(), "sb-dns-behavior-"));
  const processes = [];
  const relays = {};
  const udp = createSocket("udp4");
  let doh, health;
  let udpQueries = 0, dohQueries = 0;
  try {
    const cert = join(dir, "cert.pem"), key = join(dir, "key.pem");
    const openssl = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"]);
    expect(openssl.exitCode).toBe(0);
    udp.on("message", (packet, peer) => { udpQueries++; udp.send(response(packet), peer.port, peer.address); });
    await new Promise(resolve => udp.bind(15354, "127.0.0.1", resolve));
    doh = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { cert: Bun.file(cert), key: Bun.file(key) }, async fetch(req) {
      dohQueries++;
      return new Response(response(Buffer.from(await req.arrayBuffer())), { headers: { "content-type": "application/dns-message" } });
    }});
    health = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 204 }) });
    const nodes = [
      { type: "socks", tag: "selfhost-hk", server: "127.0.0.1", server_port: 15355 },
      { type: "socks", tag: "jp-backup", server: "127.0.0.1", server_port: 15356 },
    ];
    const startRelay = async tag => {
      const node = nodes.find(node => node.tag === tag);
      const relay = await start({
        log: { level: "debug" },
        inbounds: [{ type: "socks", listen: "127.0.0.1", listen_port: node.server_port }],
        outbounds: [{ type: "direct", tag: "direct" }], route: { final: "direct" },
      }, await mkdtemp(join(dir, "relay-")));
      processes.push(relay);
      relays[tag] = relay;
    };
    for (const node of nodes) await startRelay(node.tag);
    const dns = structuredClone(template.dns);
    for (const server of dns.servers) {
      if (server.type === "https") { server.server = "127.0.0.1"; server.server_port = doh.port; server.tls = { enabled: true, server_name: "localhost", certificate: await readFile(cert, "utf8") }; }
      if (server.type === "udp") { server.server = "127.0.0.1"; server.server_port = 15354; }
    }
    const detour = dns.servers.find(server => server.tag === "dns-proxy").detour;
    const group = structuredClone(template.outbounds.find(outbound => outbound.tag === detour));
    group.outbounds = [...new Set(group.outbounds.flatMap(pattern => {
      const insensitive = pattern.startsWith("(?i)");
      const regex = new RegExp(insensitive ? pattern.slice(4) : pattern, insensitive ? "i" : "");
      return nodes.filter(node => regex.test(node.tag)).map(node => node.tag);
    }))];
    group.url = health.url.href;
    const config = {
      log: { level: "debug" }, dns,
      inbounds: [{ type: "direct", tag: "dns-test", listen: "127.0.0.1", listen_port: 15353 }],
      outbounds: [{ type: "direct", tag: "direct" }, ...nodes, group],
      route: { default_domain_resolver: "dns-local-system", rules: [{ inbound: ["dns-test"], action: "hijack-dns" }], rule_set: ["Lan-dns", "MyDirect-dns", "ChinaMax-dns"].map(tag => ({ type: "inline", tag, rules: [{ domain: ["nonmatching.invalid"] }] })) },
      experimental: { cache_file: { ...template.experimental.cache_file, path: "cache.db" }, clash_api: { external_controller: "127.0.0.1:19090" } },
    };
    const startCore = async () => {
      const core = await start(config, dir);
      processes.push(core);
      return core;
    };
    await run({ config, startCore, startRelay, relays, doh, queries: () => ({ udp: udpQueries, doh: dohQueries }) });
  } finally {
    for (const process of processes) await process.stop();
    if (doh) doh.stop(true);
    if (health) health.stop(true);
    udp.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function eventuallyQuery(name, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      const packet = await query(name, 65, 300);
      if ((packet.readUInt16BE(2) & 15) === 0 && packet.readUInt16BE(6) === 1) return packet;
    } catch (error) {
      if (error.message !== "DNS response timeout") throw error;
    }
    await Bun.sleep(50);
  } while (Date.now() < deadline);
  throw new Error(`未在 ${timeoutMs}ms 内恢复 DNS 查询: ${name}`);
}

test("真实内核保留HTTPS记录、代理DNS兜底、空应答与FakeIP跨重启映射", () => withDNS(async f => {
  let core = await f.startCore();
  const https = await query("public.test", 65);
  expect(https.readUInt16BE(2) & 15).toBe(0);
  expect(https.readUInt16BE(6)).toBe(1);
  await query("public.test", 16);
  expect(f.queries()).toEqual({ doh: 2, udp: 0 });
  const before = f.queries();
  const empty = await query("internal.int.ooooo.space", 16);
  expect(empty.readUInt16BE(2) & 15).toBe(0);
  expect(empty.readUInt16BE(6)).toBe(0);
  expect(f.queries()).toEqual(before);
  const first = (await query("first.test", 1)).subarray(-4).toString("hex");
  await core.stop();
  core = await f.startCore();
  const second = (await query("second.test", 1)).subarray(-4).toString("hex");
  const restored = (await query("first.test", 1)).subarray(-4).toString("hex");
  expect(second).not.toBe(first);
  expect(restored).toBe(first);
}), 15000);

test("HK 全断仍可通过其他地区解析，运行中所选节点断开后自动恢复", () => withDNS(async f => {
  await f.relays["selfhost-hk"].stop();
  let core = await f.startCore();
  const cold = await eventuallyQuery("cold-region-failure.test", 3000);
  expect(cold.readUInt16BE(2) & 15).toBe(0);
  expect(cold.readUInt16BE(6)).toBe(1);
  await core.stop();
  await f.startRelay("selfhost-hk");
  core = await f.startCore();
  await eventuallyQuery("before-live-failure.test", 3000);
  const tag = f.config.dns.servers.find(server => server.tag === "dns-proxy").detour;
  const state = () => fetch(`http://127.0.0.1:19090/proxies/${encodeURIComponent(tag)}`).then(response => response.json());
  const selected = (await state()).now;
  await f.relays[selected].stop();
  const before = Date.now();
  const restored = await eventuallyQuery("after-live-failure.test", 75000);
  expect(restored.readUInt16BE(2) & 15).toBe(0);
  expect(restored.readUInt16BE(6)).toBe(1);
  expect((await state()).now).not.toBe(selected);
  console.log(JSON.stringify({ scenario: "dns-region-and-live-failover", recovery_ms: Date.now() - before }));
}), 90000);

test("普通 DNS 缓存正常重启后在 DoH 不可用时仍可恢复", () => withDNS(async f => {
  let core = await f.startCore();
  const first = await query("persisted-response.test", 65);
  expect(first.readUInt16BE(2) & 15).toBe(0);
  expect(first.readUInt16BE(6)).toBe(1);
  await core.stop();
  f.doh.stop(true);
  core = await f.startCore();
  const restored = await query("persisted-response.test", 65);
  expect(restored.readUInt16BE(2) & 15).toBe(0);
  expect(restored.readUInt16BE(6)).toBe(1);
  expect(restored.subarray(-10)).toEqual(first.subarray(-10));
}), 15000);

test("LAN 域名 TTL 过期后返回上游新地址而非过期缓存", () => withDNS(async f => {
  const lan = createSocket("udp4");
  let address = "192.0.2.10";
  try {
    const aRecord = (packet, ip) => {
      let end = 12;
      while (packet[end]) end += packet[end] + 1;
      end++;
      const header = Buffer.from(packet.subarray(0, 12));
      header.writeUInt16BE(0x8180, 2);
      header.writeUInt16BE(1, 6);
      const rr = Buffer.alloc(16);
      rr.writeUInt16BE(0xc00c); rr.writeUInt16BE(1, 2); rr.writeUInt16BE(1, 4);
      rr.writeUInt32BE(1, 6); rr.writeUInt16BE(4, 10);
      Buffer.from(ip.split(".").map(Number)).copy(rr, 12);
      return Buffer.concat([header, packet.subarray(12, end + 4), rr]);
    };
    lan.on("message", (packet, peer) => lan.send(aRecord(packet, address), peer.port, peer.address));
    await new Promise(resolve => lan.bind(15357, "127.0.0.1", resolve));
    // dns-local-system(type local) 跟随 VM 系统解析器，答案不可控；
    // 换成可控 UDP 上游后，LAN 规则本身的路由行为不变
    f.config.dns.servers = f.config.dns.servers.map(server =>
      server.tag === "dns-local-system"
        ? { type: "udp", tag: "dns-local-system", server: "127.0.0.1", server_port: 15357 }
        : server);
    const core = await f.startCore();
    const initial = await query("nas.lan", 1);
    expect(initial.readUInt16BE(2) & 15).toBe(0);
    expect(initial.subarray(-4).join(".")).toBe("192.0.2.10");
    await Bun.sleep(1200);
    address = "192.0.2.20";
    const fresh = await query("nas.lan", 1);
    expect(fresh.readUInt16BE(2) & 15).toBe(0);
    expect(fresh.subarray(-4).join(".")).toBe("192.0.2.20");
    await core.stop();
  } finally {
    lan.close();
  }
}), 15000);
