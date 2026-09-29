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
function query(name, type) {
  return new Promise((resolve, reject) => {
    const socket = createSocket("udp4");
    const timer = setTimeout(() => { socket.close(); reject(new Error("DNS response timeout")); }, 3000);
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

test("真实内核保留HTTPS记录、代理DNS兜底、空应答与FakeIP跨重启映射", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sb-dns-behavior-"));
  let core, relay, doh;
  const udp = createSocket("udp4");
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
    const relayDir = await mkdtemp(join(dir, "relay-"));
    relay = await start({ log: { level: "debug" }, inbounds: [{ type: "socks", listen: "127.0.0.1", listen_port: 15355 }], outbounds: [{ type: "direct", tag: "direct" }], route: { final: "direct", default_domain_resolver: "local" }, dns: { servers: [{ type: "local", tag: "local" }] } }, relayDir);
    const dns = structuredClone(template.dns);
    for (const server of dns.servers) {
      if (server.type === "https") { server.server = "127.0.0.1"; server.server_port = doh.port; server.tls = { enabled: true, server_name: "localhost", certificate: await readFile(cert, "utf8") }; }
      if (server.type === "udp") { server.server = "127.0.0.1"; server.server_port = 15354; }
    }
    const config = {
      log: { level: "debug" }, dns,
      inbounds: [{ type: "direct", tag: "dns-test", listen: "127.0.0.1", listen_port: 15353 }],
      outbounds: [{ type: "direct", tag: "direct" }, { type: "socks", tag: "proxy", server: "127.0.0.1", server_port: 15355 }],
      route: { default_domain_resolver: "dns-local-system", rules: [{ inbound: ["dns-test"], action: "hijack-dns" }], rule_set: ["Lan-dns", "MyDirect-dns", "ChinaMax-dns"].map(tag => ({ type: "inline", tag, rules: [{ domain: ["nonmatching.invalid"] }] })) },
      experimental: { cache_file: { ...template.experimental.cache_file, path: "cache.db" } },
    };
    core = await start(config, dir);
    const https = await query("public.test", 65);
    expect(https.readUInt16BE(2) & 15).toBe(0);
    expect(https.readUInt16BE(6)).toBe(1);
    await query("public.test", 16);
    expect(dohQueries).toBe(2);
    expect(udpQueries).toBe(0);
    expect(relay.log()).toContain(`127.0.0.1:${doh.port}`);
    const empty = await query("internal.int.ooooo.space", 28);
    expect(empty.readUInt16BE(2) & 15).toBe(0);
    expect(empty.readUInt16BE(6)).toBe(0);
    const first = (await query("first.test", 1)).subarray(-4).toString("hex");
    await core.stop(); core = null;
    core = await start(config, dir);
    const second = (await query("second.test", 1)).subarray(-4).toString("hex");
    const restored = (await query("first.test", 1)).subarray(-4).toString("hex");
    expect(second).not.toBe(first);
    expect(restored).toBe(first);
  } finally {
    if (core) await core.stop();
    if (relay) await relay.stop();
    if (doh) doh.stop(true);
    udp.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 15000);
