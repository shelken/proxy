#!/usr/bin/env -S bun test
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSocket } from "node:dgram";

const binary = process.env.SBTOOLS_BIN;
const kernel = process.env.SING_BOX;
const root = mkdtempSync(join(tmpdir(), "sbtools-observe-"));
const home = join(root, "home");
const configDir = join(home, ".config/sing-box");
mkdirSync(configDir, { recursive: true });
const api = "http://127.0.0.1:19190";
const records = [];
const processes = [];
let dns;
let web;
let tls;
let config;
let kernelLog = "";
const env = { ...process.env, HOME: home, SING_BOX: kernel };

async function run(name, args, extra = {}) {
  const p = Bun.spawn([binary, ...args], { env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe" });
  processes.push(p);
  // 被测 Rust 进程有独立时钟，必须用真实截止时间回收卡住的进程。
  const timer = setTimeout(() => p.kill(), 18000);
  try {
    const [stdout, stderr, exit] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    records.push({ name, command: ["sbtools", ...args], exit, stdout, stderr });
    return { stdout, stderr, exit };
  } finally { clearTimeout(timer); }
}

async function waitFor(check, detail) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(40);
  }
  throw new Error(detail + "\n" + kernelLog);
}

function saveConfig(overlay = config) {
  writeFileSync(join(configDir, "config.yaml"), "overlay: |\n  " + JSON.stringify(overlay) + "\n");
}

beforeAll(async () => {
  const links = JSON.parse(Bun.spawnSync(["ip", "-j", "link"]).stdout.toString());
  if (!Array.isArray(links) || links.some(x => typeof x !== "object" || x === null || typeof x.ifname !== "string")) throw new Error("ip link response has no interface names");
  expect(links.map(x => x.ifname)).toEqual(["lo"]);
  expect(Bun.spawnSync(["ip", "route", "show", "default"]).stdout.toString()).toBe("");
  dns = createSocket("udp4");
  dns.on("message", (query, from) => {
    let end = 12;
    const labels = [];
    while (query[end]) { const n = query[end++]; labels.push(query.subarray(end, end + n).toString()); end += n; }
    end++;
    const type = query.readUInt16BE(end);
    const answer = type === 1;
    const header = Buffer.from(query.subarray(0, 12));
    header.writeUInt16BE(0x8180, 2);
    header.writeUInt16BE(answer ? 1 : 0, 6);
    header.writeUInt16BE(0, 8); header.writeUInt16BE(0, 10);
    const address = labels.join(".") === "fake.test" ? [198, 18, 0, 9] : [203, 0, 113, 10];
    const rr = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 1, 0, 4, ...address]);
    dns.send(Buffer.concat([header, query.subarray(12, end + 4), ...(answer ? [rr] : [])]), from.port, from.address);
  });
  const bound = Promise.withResolvers();
  dns.bind(5354, "127.0.0.1", bound.resolve);
  await bound.promise;
  web = Bun.serve({ hostname: "203.0.113.10", port: 8088, fetch: () => new Response("synthetic-http-ok") });
  const cert = join(root, "cert.pem"), key = join(root, "key.pem");
  const issued = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=probe.test", "-addext", "subjectAltName=DNS:probe.test"]);
  expect(issued.exitCode).toBe(0);
  tls = Bun.serve({ hostname: "203.0.113.10", port: 443, tls: { cert: Bun.file(cert), key: Bun.file(key) }, fetch: () => new Response("synthetic-tls-ok") });
  const rule = join(root, "probe.json");
  writeFileSync(rule, JSON.stringify({ version: 3, rules: [{ domain_suffix: ["test"] }] }));
  config = {
    log: { level: "debug", timestamp: false, output: join(root, "kernel.log") },
    dns: { servers: [{ type: "udp", tag: "synthetic-dns", server: "127.0.0.1", server_port: 5354 }], rules: [{ domain_suffix: ["test"], server: "synthetic-dns" }], final: "synthetic-dns", disable_cache: true },
    inbounds: [{ type: "direct", tag: "dns-in", listen: "127.0.0.1", listen_port: 53, network: "udp" }, { type: "mixed", tag: "mixed-in", listen: "127.0.0.1", listen_port: 2080 }],
    outbounds: [{ type: "direct", tag: "direct" }],
    route: { rules: [{ inbound: "dns-in", action: "hijack-dns" }, { rule_set: ["Probe"], action: "route", outbound: "direct" }], rule_set: [{ type: "local", tag: "Probe", format: "source", path: rule }], default_domain_resolver: "synthetic-dns", final: "direct" },
    experimental: { clash_api: { external_controller: "127.0.0.1:19190" } },
  };
  const path = join(root, "kernel.json");
  writeFileSync(path, JSON.stringify(config));
  const checked = Bun.spawnSync([kernel, "check", "-c", path], { env });
  expect(checked.exitCode, checked.stderr.toString()).toBe(0);
  const p = Bun.spawn([kernel, "run", "-c", path], { env, stdout: "pipe", stderr: "pipe" });
  processes.push(p);
  void (async () => { for await (const part of p.stderr) kernelLog += new TextDecoder().decode(part); })();
  await waitFor(async () => { try { return (await fetch(api + "/version")).ok; } catch { return false; } }, "owned sing-box not ready");
  saveConfig();
}, 15000);

afterAll(async () => {
  for (const p of processes) { if (p.exitCode === null) p.kill(); await p.exited; }
  dns?.close(); web?.stop(true); tls?.stop(true);
  await Bun.write("results-observability.json", JSON.stringify(records, null, 2));
  await Bun.write("kernel-observability.log", kernelLog + (existsSync(join(root, "kernel.log")) ? readFileSync(join(root, "kernel.log"), "utf8") : ""));
  rmSync(root, { recursive: true, force: true });
});

test("config reports real running kernel from YAML and old JSON", async () => {
  const yaml = await run("config-live-yaml", ["config"]);
  expect(yaml.exit).toBe(0); expect(yaml.stdout).toContain("✓ SFM 运行时");
  expect(yaml.stdout).toContain("log-level: debug");
  rmSync(join(configDir, "config.yaml"));
  writeFileSync(join(configDir, "singbox.json"), JSON.stringify(config));
  const json = await run("config-live-json", ["config"]);
  expect(json.exit).toBe(0); expect(json.stdout).toContain("log-level: debug");
  rmSync(join(configDir, "singbox.json")); saveConfig();
});

test("logs -f decodes actual new kernel events and survives more than 4 seconds", async () => {
  const p = Bun.spawn([binary, "logs", "-f", "--level", "debug"], { env, stdout: "pipe", stderr: "pipe" });
  processes.push(p);
  let output = "";
  const drain = (async () => { for await (const part of p.stdout) output += new TextDecoder().decode(part); })();
  const err = new Response(p.stderr).text();
  try {
    await waitFor(() => output.includes("✓ 跟踪"), "logs did not attach");
    // Rust 日志流曾受整体超时影响，只有真实跨过 4 秒边界才能验证连接寿命。
    await Bun.sleep(4300);
    expect(p.exitCode).toBeNull();
    const probe = Bun.spawn(["curl", "--noproxy", "", "--proxy", "http://127.0.0.1:2080", "--max-time", "3", "http://probe.test:8088/"], { env, stdout: "pipe", stderr: "pipe" });
    processes.push(probe);
    expect(await new Response(probe.stdout).text()).toBe("synthetic-http-ok");
    expect(await probe.exited).toBe(0);
    await waitFor(() => output.includes("probe.test"), "logs missed the actual request");
    expect(output).not.toContain('"payload":');
  } finally {
    p.kill(); await p.exited; await drain;
    records.push({ name: "logs-follow-real-stream", command: ["sbtools", "logs", "-f", "--level", "debug"], exit: p.exitCode, stdout: output, stderr: await err, stoppedByHarness: true });
  }
}, 15000);

test("logs -n -f prints history and then follows real kernel events", async () => {
  const p = Bun.spawn([binary, "logs", "-n", "1", "-f"], { env, stdout: "pipe", stderr: "pipe" });
  processes.push(p);
  let output = "";
  const drain = (async () => { for await (const part of p.stdout) output += new TextDecoder().decode(part); })();
  const err = new Response(p.stderr).text();
  try {
    await waitFor(() => output.includes("✓ 跟踪"), "combined tail and follow did not attach");
    expect(output).toContain("✓ log.output:");
    const p2 = Bun.spawn(["curl", "--noproxy", "", "--proxy", "http://127.0.0.1:2080", "--max-time", "3", "http://combined.test:8088/"], { env, stdout: "pipe", stderr: "pipe" });
    processes.push(p2);
    expect(await new Response(p2.stdout).text()).toBe("synthetic-http-ok"); expect(await p2.exited).toBe(0);
    await waitFor(() => output.includes("combined.test"), "combined follow missed new request");
  } finally {
    p.kill(); await p.exited; await drain;
    records.push({ name: "logs-tail-and-follow", command: ["sbtools", "logs", "-n", "1", "-f"], exit: p.exitCode, stdout: output, stderr: await err, stoppedByHarness: true });
  }
}, 10000);

test("trace shows actual DNS, live rule-set chain and static rules with rejected self-signed TLS", async () => {
  const r = await run("trace-real-kernel", ["trace", "probe.test"]);
  expect(r.stdout).toContain("✓ 系统 resolver   A 203.0.113.10");
  expect(r.stdout).toContain("domain_suffix=test => synthetic-dns");
  expect(r.stdout).toMatch(/✓ live 路由归属.*Probe.*direct/i);
  expect(r.stdout).toContain("✓ 静态规则"); expect(r.stdout).toContain("Probe");
  expect(r.stdout).toContain("✗ HTTPS 首字节"); expect(r.exit).toBe(1);
}, 20000);

test("trace identifies a rule-set DNS candidate without claiming a domain match", async () => {
  saveConfig({ ...config, dns: { ...config.dns, rules: [{ rule_set: ["Probe"], server: "synthetic-dns" }] } });
  try {
    const r = await run("trace-dns-candidate", ["trace", "probe.test", "--api", "127.0.0.1:19190"]);
    expect(r.stdout).toContain("rule_set 候选，内容未匹配");
    expect(r.stdout).toContain("未命中落 final => synthetic-dns"); expect(r.exit).toBe(1);
  } finally { saveConfig(); }
}, 20000);

test("trace flags a fake IP instead of reporting a real resolver answer", async () => {
  const r = await run("trace-fakeip", ["trace", "fake.test"]);
  expect(r.stdout).toContain("A 198.18.0.9"); expect(r.stdout).toContain("fakeip 假 IP"); expect(r.exit).toBe(1);
}, 20000);
