import { test, expect } from "bun:test";
import { createSocket } from "node:dgram";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SING_BOX } from "./lib/sandbox.ts";
import { emitSingboxDns, parseYamlAst } from "../../../scripts/rules-compile.ts";

const template = JSON.parse(await readFile(new URL("../template.json", import.meta.url), "utf8"));

function question(name, type) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(123);
  header.writeUInt16BE(0x100, 2);
  header.writeUInt16BE(1, 4);
  return Buffer.concat([header, ...name.split(".").map(label => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])), Buffer.from([0, type >> 8, type & 255, 0, 1])]);
}
function response(packet, address = "192.0.2.10", ttl = 30) {
  let end = 12;
  while (packet[end]) end += packet[end] + 1;
  end++;
  const type = packet.readUInt16BE(end);
  const header = Buffer.from(packet.subarray(0, 12));
  header.writeUInt16BE(0x8180, 2);
  const data = type === 1 ? Buffer.from(address.split(".").map(Number)) : type === 65 ? Buffer.from([0, 1, 0, 0, 1, 0, 3, 2, 104, 50]) : null;
  header.writeUInt16BE(data ? 1 : 0, 6);
  const rr = Buffer.alloc(12);
  rr.writeUInt16BE(0xc00c); rr.writeUInt16BE(type, 2); rr.writeUInt16BE(1, 4); rr.writeUInt32BE(ttl, 6); rr.writeUInt16BE(data?.length ?? 0, 10);
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

async function withDNS(run, source = template) {
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
    const dns = structuredClone(source.dns);
    for (const server of dns.servers) {
      if (server.type === "https") { server.server = "127.0.0.1"; server.server_port = doh.port; server.tls = { enabled: true, server_name: "localhost", certificate: await readFile(cert, "utf8") }; }
      if (server.type === "udp") { server.server = "127.0.0.1"; server.server_port = 15354; }
    }
    const detour = dns.servers.find(server => server.tag === "dns-proxy").detour;
    const group = structuredClone(source.outbounds.find(outbound => outbound.tag === detour));
    group.outbounds = [...new Set(group.outbounds.flatMap(pattern => {
      const insensitive = pattern.startsWith("(?i)");
      const regex = new RegExp(insensitive ? pattern.slice(4) : pattern, insensitive ? "i" : "");
      return nodes.filter(node => regex.test(node.tag)).map(node => node.tag);
    }))];
    group.url = health.url.href;
    const dnsTags = [...new Set((dns.rules ?? []).flatMap(r => Array.isArray(r.rule_set) ? r.rule_set : (r.rule_set ? [r.rule_set] : [])))];
    const localDns = {};
    for (const name of ["Lan", "MyDirect"]) {
      const source = await readFile(new URL(`../../rules/custom/${name}.yaml`, import.meta.url), "utf8");
      localDns[`${name}-dns`] = JSON.parse(emitSingboxDns(parseYamlAst(source))).rules;
    }
    const config = {
      log: { level: "debug" }, dns,
      inbounds: [{ type: "direct", tag: "dns-test", listen: "127.0.0.1", listen_port: 15353 }],
      outbounds: [{ type: "direct", tag: "direct" }, ...nodes, group],
      route: { default_domain_resolver: "dns-lan", rules: [{ inbound: ["dns-test"], action: "hijack-dns" }], rule_set: dnsTags.map(tag => ({ type: "inline", tag, rules: localDns[tag] ?? [{ domain: ["nonmatching.invalid"] }] })) },
      experimental: { cache_file: { ...source.experimental.cache_file, path: "cache.db" }, clash_api: { external_controller: "127.0.0.1:19090" } },
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

for (const file of ["template.json", "template-ios.json", "template-router.json"]) {
  test(`${file}: local 根名立即空应答，子域与 LAN 仍由本网解析器应答`, async () => {
    const source = JSON.parse(await readFile(new URL(`../${file}`, import.meta.url), "utf8"));
    await withDNS(async f => {
      // 用可控上游验证规则边界，避免依赖沙箱所在链路上的 mDNS 设备。
      const lan = { type: "udp", tag: "dns-lan", server: "127.0.0.1", server_port: 15354 };
      f.config.dns.servers = f.config.dns.servers.filter(s => s.type !== "tailscale")
        .map(s => s.type === "local" ? lan : s);
      f.config.dns.rules = f.config.dns.rules.filter(r => ![r.preferred_by].flat().includes("dns-ts"));
      if (!f.config.dns.servers.some(s => s.tag === "dns-lan")) f.config.dns.servers.push(lan);
      const core = await f.startCore();
      const before = f.queries();
      for (const type of [65, 1, 28, 2, 6, 12, 16]) {
        const packet = await query("local", type, 1000);
        expect(packet.readUInt16BE(2) & 15).toBe(0);
        expect(packet.readUInt16BE(6)).toBe(0);
      }
      expect(f.queries()).toEqual(before);
      for (const name of ["probe.local", "probe.lan", "probe.home.arpa", "probe.tplinkwifi.net"]) {
        const packet = await query(name, 1);
        expect(packet.readUInt16BE(6)).toBe(1);
        expect(packet.subarray(-4).join(".")).toBe("192.0.2.10");
      }
      expect(core.log()).not.toContain("process DNS packet:");
    }, source);
  }, 15000);
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
    lan.on("message", (packet, peer) => lan.send(response(packet, address, 1), peer.port, peer.address));
    await new Promise(resolve => lan.bind(15357, "127.0.0.1", resolve));
    // dns-lan(type local) 跟随 VM 系统解析器，答案不可控；
    // 换成可控 UDP 上游后，LAN 规则本身的路由行为不变
    f.config.dns.servers = f.config.dns.servers.map(server =>
      server.tag === "dns-lan"
        ? { type: "udp", tag: "dns-lan", server: "127.0.0.1", server_port: 15357 }
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

// 极简 SOCKS5 捕获节点：只记录客户端 CONNECT 请求的 ATYP 与目标地址（不实际外联），
// 用来区分 sing-box 是把域名原样交给节点（ATYP=3），还是先本机 resolve 成 IP 再拨号（ATYP=1）。
function startSocksCapture() {
  let waitResolve;
  const first = new Promise(resolve => { waitResolve = resolve; });
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(sock) { sock.data = { step: 0, buf: Buffer.alloc(0) }; },
      data(sock, chunk) {
        sock.data.buf = Buffer.concat([sock.data.buf, Buffer.from(chunk)]);
        if (sock.data.step === 0) {
          if (sock.data.buf.length < 2) return;
          const n = sock.data.buf[1];
          if (sock.data.buf.length < 2 + n) return;
          sock.data.buf = sock.data.buf.subarray(2 + n);
          sock.data.step = 1;
          sock.write(Buffer.from([5, 0]));
        }
        if (sock.data.step === 1 && sock.data.buf.length >= 5) {
          const b = sock.data.buf;
          const atyp = b[3];
          let target;
          if (atyp === 1 && b.length >= 10) target = Array.from(b.subarray(4, 8)).join(".");
          else if (atyp === 3 && b.length >= 7 + b[4]) target = b.subarray(5, 5 + b[4]).toString("utf8");
          else if (atyp === 4 && b.length >= 22) target = "ipv6";
          else return;
          waitResolve?.({ atyp, target });
          waitResolve = null;
          sock.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          sock.end();
        }
      },
    },
  });
  return { port: server.port, first, stop: () => server.stop(true) };
}

async function connectViaMixed(port, host) {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("mixed CONNECT timeout")), 3000);
    Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(sock) { sock.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`); },
        data(sock) { clearTimeout(timer); sock.end(); resolve(); },
        close() { clearTimeout(timer); resolve(); },
        error(_s, err) { clearTimeout(timer); reject(err); },
        connectError(_s, err) { clearTimeout(timer); reject(err); },
      },
    });
  });
}

test("代理流量直接携带域名发往节点，不触发本机 DoH 解析（附反向对照）", () => withDNS(async f => {
  const runCase = async (extraRouteRules = []) => {
    const capture = startSocksCapture();
    const mixedPort = 15360 + Math.floor(Math.random() * 200);
    try {
      const routeRules = [...structuredClone(template.route.rules), ...extraRouteRules];
      const ruleSetTags = [...new Set([
        ...(f.config.route.rule_set ?? []).map(r => r.tag),
        ...routeRules.flatMap(r => Array.isArray(r.rule_set) ? r.rule_set : (r.rule_set ? [r.rule_set] : [])),
      ])];
      const outboundTags = [...new Set([
        template.route.final,
        ...routeRules.map(r => r.outbound).filter(Boolean),
      ])];
      const existing = new Set(f.config.outbounds.map(o => o.tag));
      const extraOutbounds = outboundTags
        .filter(tag => !existing.has(tag))
        .map(tag => ({ type: "socks", tag, server: "127.0.0.1", server_port: capture.port }));
      const caseConfig = {
        ...structuredClone(f.config),
        inbounds: [{ type: "mixed", tag: "mixed-test", listen: "127.0.0.1", listen_port: mixedPort }],
        outbounds: [...structuredClone(f.config.outbounds), ...extraOutbounds],
        route: {
          default_domain_resolver: "dns-lan",
          final: template.route.final,
          rules: routeRules,
          rule_set: ruleSetTags.map(tag => ({ type: "inline", tag, rules: [{ domain: ["nonmatching.invalid"] }] })),
        },
      };
      const dir = await mkdtemp(join(tmpdir(), "sb-proxy-dns-"));
      const core = await start(caseConfig, dir);
      try {
        const before = f.queries();
        await connectViaMixed(mixedPort, "proxy-target.test");
        const seen = await capture.first;
        const after = f.queries();
        return { seen, dohDelta: after.doh - before.doh, udpDelta: after.udp - before.udp };
      } finally {
        await core.stop();
        await rm(dir, { recursive: true, force: true });
      }
    } finally {
      capture.stop();
    }
  };

  // 正向：生产底模直接把域名交给节点（ATYP=3），零本机 DoH / UDP 查询
  const prod = await runCase();
  expect(prod.seen).toEqual({ atyp: 3, target: "proxy-target.test" });
  expect(prod.dohDelta).toBe(0);
  expect(prod.udpDelta).toBe(0);

  // 反向对照：若加回 action: resolve，本机先发 DoH 解析再把 IPv4（ATYP=1）发给节点
  const withResolve = await runCase([{ action: "resolve", server: "dns-proxy", strategy: "ipv4_only" }]);
  expect(withResolve.seen).toEqual({ atyp: 1, target: "192.0.2.10" });
  expect(withResolve.dohDelta).toBe(1);
}), 20000);

