#!/usr/bin/env -S bun test
import { beforeAll, afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const binary = process.env.SBTOOLS_BIN;
const kernel = process.env.SING_BOX;
const root = mkdtempSync(join(tmpdir(), "sbtools-public-"));
const home = join(root, "home");
mkdirSync(join(home, ".config/sing-box"), { recursive: true });
const env = { ...process.env, HOME: home, SING_BOX: kernel };
const records = [];
const processes = [];
let serverLog = "";
let kernelLog = "";
const api = "http://127.0.0.1:19191";
const server = "http://127.0.0.1:18185";

async function run(name, args) {
  const p = Bun.spawn([binary, ...args], { env, stdout: "pipe", stderr: "pipe" });
  processes.push(p);
  // 子进程的网络截止时间由真实 Rust 时钟控制。
  const timer = setTimeout(() => p.kill(), 25000);
  try {
    const [stdout, stderr, exit] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    records.push({ name, command: ["sbtools", ...args], exit, stdout, stderr });
    return { stdout, stderr, exit };
  } finally { clearTimeout(timer); }
}
async function ready(url, process) {
  // 轮询的是独立进程的真实监听状态，Bun 虚拟时钟不能推进它。
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error("owned process exited before readiness\n" + serverLog + kernelLog);
    try { if ((await fetch(url)).ok) return; } catch {}
    await Bun.sleep(40);
  }
  throw new Error("owned endpoint not ready: " + url + "\n" + serverLog + kernelLog);
}

beforeAll(async () => {
  const keys = await run("remote-keygen", ["keygen"]);
  expect(keys.exit).toBe(0);
  const secret = keys.stdout.match(/^SERVER_PRIVATE_KEY=([a-f0-9]{64})$/m)?.[1];
  expect(typeof secret).toBe("string");
  records.at(-1).stdout = "synthetic keys generated, private value omitted";
  const p = Bun.spawn([binary, "server", "--port", "18185"], { env: { ...env, SERVER_PRIVATE_KEY: secret }, stdout: "pipe", stderr: "pipe" });
  processes.push(p);
  void (async () => { for await (const chunk of p.stderr) serverLog += new TextDecoder().decode(chunk); })();
  await ready(server + "/healthz", p);
  const config = {
    log: { level: "debug", output: join(root, "public-kernel.log"), timestamp: false },
    dns: { servers: [{ type: "https", tag: "public-dns", server: "1.1.1.1" }], rules: [{ domain_suffix: ["example.com"], server: "public-dns" }], final: "public-dns", disable_cache: true },
    inbounds: [{ type: "direct", tag: "dns-in", listen: "127.0.0.10", listen_port: 53, network: "udp" }, { type: "mixed", tag: "mixed-in", listen: "127.0.0.1", listen_port: 2081 }],
    outbounds: [{ type: "direct", tag: "direct" }],
    route: { rules: [{ inbound: ["dns-in"], action: "hijack-dns" }, { rule_set: ["PublicExample"], action: "route", outbound: "direct" }], rule_set: [{ type: "inline", tag: "PublicExample", rules: [{ domain_suffix: ["example.com"] }] }], final: "direct", default_domain_resolver: "public-dns" },
    experimental: { clash_api: { external_controller: "127.0.0.1:19191" } },
  };
  const path = join(root, "kernel.json");
  writeFileSync(path, JSON.stringify(config));
  writeFileSync(join(home, ".config/sing-box/config.yaml"), "overlay: |\n  " + JSON.stringify(config) + "\n");
  const checked = Bun.spawnSync([kernel, "check", "-c", path], { env });
  expect(checked.exitCode, checked.stderr.toString()).toBe(0);
  const k = Bun.spawn([kernel, "run", "-c", path], { env, stdout: "pipe", stderr: "pipe" });
  processes.push(k);
  void (async () => { for await (const chunk of k.stderr) kernelLog += new TextDecoder().decode(chunk); })();
  await ready(api + "/version", k);
}, 15000);

afterAll(async () => {
  for (const p of processes) { if (p.exitCode === null) p.kill(); await p.exited; }
  await Bun.write("results-remote.json", JSON.stringify(records, null, 2));
  await Bun.write("server-remote.log", serverLog);
  await Bun.write("kernel-remote.log", kernelLog + (existsSync(join(root, "public-kernel.log")) ? readFileSync(join(root, "public-kernel.log"), "utf8") : ""));
  rmSync(root, { recursive: true, force: true });
});

test("encode and server download the requested public HTTPS template", async () => {
  const config = join(root, "dynamic.yaml");
  const template = "https://raw.githubusercontent.com/shelken/proxy/" + process.env.EXPECTED_COMMIT + "/config/sing-box/template.json";
  writeFileSync(config, "nodes:\n  - hy2://synthetic-pass@192.0.2.1:443?sni=example.test#selfhost-hk\n  - hy2://synthetic-pass@192.0.2.2:443?sni=example.test#selfhost-jp\ntemplate_url: " + template + "\noverlay: |\n  {\"log\":{\"level\":\"warn\"}}\n");
  const encoded = await run("encode-public-template", ["encode", "--server", server, "--config", config]);
  expect(encoded.exit).toBe(0);
  const url = encoded.stdout.split("\n").find(s => s.startsWith(server + "/sub?d="));
  expect(typeof url).toBe("string");
  const response = await fetch(url);
  const body = await response.text();
  records.push({ name: "server-public-template", method: "GET", path: "/sub", status: response.status, body });
  expect(response.status, body).toBe(200);
  const output = JSON.parse(body);
  expect(output.log.level).toBe("warn");
  expect(output.outbounds.find(x => x.tag === "selfhost-hk").server).toBe("192.0.2.1");
  expect(output.outbounds.find(x => x.tag === "selfhost-jp").server).toBe("192.0.2.2");
  expect(serverLog).toContain("底模: dynamic");
}, 30000);

test("check downloads the public template and performs the real kernel check", async () => {
  const r = await run("check-public-template", ["check", "-c", join(root, "dynamic.yaml")]);
  expect(r.exit, r.stderr).toBe(0);
  expect(r.stdout).toContain("✓ 内核 check 通过（底模: dynamic）");
  expect(r.stdout).toContain("log.level: warn");
}, 30000);

test("trace reports successful public resolver, live rule-set route and HTTPS first byte", async () => {
  const r = await run("trace-public-https", ["trace", "example.com", "--api", "127.0.0.1:19191"]);
  expect(r.exit, r.stdout + r.stderr).toBe(0);
  expect(r.stdout).toContain("✓ 系统 resolver");
  expect(r.stdout).toContain("domain_suffix=example.com => public-dns");
  expect(r.stdout).toMatch(/✓ live 路由归属.*PublicExample.*direct/i);
  expect(r.stdout).toContain("✓ 静态规则"); expect(r.stdout).toContain("PublicExample");
  expect(r.stdout).toContain("✓ HTTPS 首字节");
}, 30000);
