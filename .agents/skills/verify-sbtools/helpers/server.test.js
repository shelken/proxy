// sbtools server 形态验证（commit 8180991）。被测对象是真实二进制与真实内核产物，
// 不是等价实现：encode 用真实 keygen 密钥产出真实加密 URL，/sub 用真实 sing-box merge 装配。
// 环境合约（由协调者注入，缺一即失败，不静默跳过）：
//   SBTOOLS_BIN  被测 sbtools 二进制绝对路径
//   SING_BOX     sing-box 内核绝对路径（server 子进程经环境继承）
// 运行位置：Linux aarch64 Lima proxy-test 的独立 unshare --net --mount --pid namespace，
// 只有 lo 接口；本文件所有网络仅 127.0.0.1，所有密钥/配置/订阅均为合成数据。
// 每次真实 CLI / 端点执行都记入 results 数组，afterAll 落盘 results-server.json 到 cwd。

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SBTOOLS = process.env.SBTOOLS_BIN;
const SING_BOX = process.env.SING_BOX || "/opt/proxy-test/bin/sing-box";

// 固定端口：本组独占 namespace，无其他组服务；28099 永不监听（证明 encode 本地先校验）。
const PORT_MAIN = 28081;
const PORT_BAD_KERNEL = 28082;
const PORT_PORT_ENV = 28083;
const PORT_SHORT_FLAG = 28084;
const PORT_NO_KEY = 28085;
const PORT_SUBS = 28090;
const PORT_DEAD = 28099;

const MAIN = `http://127.0.0.1:${PORT_MAIN}`;
const SUB_BASE = `http://127.0.0.1:${PORT_SUBS}`;

// ---- 合成节点（IP 字面量，绝不触发 DNS；服务器永不拨号，仅进 merge）----
const NODE_HY2 = "hy2://e2e-pass@192.0.2.1:8388?sni=example.com&insecure=1#e2e-hy2-node";
const NODE_ANYTLS = "anytls://at-pass@192.0.2.2:8443?sni=cdn.example.net#e2e-anytls-node";
// ss SIP002：userinfo = base64("aes-128-gcm:ss-pass")
const NODE_SS = "ss://YWVzLTEyOC1nY206c3MtcGFzcw==@192.0.2.3:8388#e2e-ss-node";
const NODE_V6 = "anytls://v6pass@[2001:db8::1]:8443#e2e-v6-node";
const NODES_ALL = [NODE_HY2, NODE_ANYTLS, NODE_SS, NODE_V6];

// overlay：标量覆盖（log.level）+ 一条宽泛路由规则（验证被反回环规则压住）。
const OVERLAY = JSON.stringify({
  log: { level: "warn" },
  route: { rules: [{ domain_suffix: ["overlay-loop.test"], outbound: "proxy" }] },
});

// 本地订阅 fixture：URI 逐行与 base64 两种格式喂同一批节点，另设三类失败源。
const SUB_LINES = [
  "hy2://subpass@198.51.100.10:8388?sni=sub.example.org#sub-vps-01",
  "anytls://subpass@198.51.100.11:8443?sni=jp.example.org#sub-jp-02",
].join("\n");
const SUB_B64 = Buffer.from(SUB_LINES, "utf8").toString("base64");

// ---- 顶层状态：results / 进程注册表 / 临时目录，全部由 afterAll 兜底清理 ----
const results = [];
const procs = [];
const tempDirs = [];
let keys = null; // { sk, pk, run }  keygen 真实产物（sk 只进服务端环境，绝不进 results）
let mainServer = null;
let subServer = null;
let urlMain = null; // cfg1 第一次 encode 的完整订阅 URL
let urlMainAgain = null; // 同一 cfg1 第二次 encode 的 URL（密文必须不同）

function record(scenario, kind, fields) {
  results.push({ scenario, kind, ...fields, at: new Date().toISOString() });
}

// 结果落盘前的脱敏与截断：私钥永不入 results，密文/超大响应体截断保可读。
function scrub(text) {
  const redacted = String(text).replace(/SERVER_PRIVATE_KEY=[0-9a-fA-F]{64}/g, "SERVER_PRIVATE_KEY=<redacted>");
  return redacted.length > 800 ? redacted.slice(0, 800) + `…(${redacted.length}B)` : redacted;
}

function scrubUrl(url) {
  const idx = url.indexOf("d=");
  if (idx === -1) return url;
  const head = url.slice(0, idx + 2);
  const d = url.slice(idx + 2);
  return head + (d.length > 48 ? d.slice(0, 48) + `…(${d.length}B)` : d);
}

function spawnDrained(argv, envOverrides, baseEnv = process.env) {
  const env = { ...baseEnv, HOME: fixtureDir("home-empty"), SING_BOX, ...envOverrides };
  const proc = Bun.spawn(argv, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  procs.push(proc);
  const state = { stdout: "", stderr: "" };
  const drain = async (stream, name) => {
    const dec = new TextDecoder();
    for await (const chunk of stream) state[name] += dec.decode(chunk, { stream: true });
  };
  state.drained = Promise.all([drain(proc.stdout, "stdout"), drain(proc.stderr, "stderr")]);
  return { proc, state };
}

async function runCLI(scenario, args, envOverrides = {}) {
  const { proc, state } = spawnDrained([SBTOOLS, ...args], envOverrides);
  await state.drained;
  const exitCode = await proc.exited;
  record(scenario, "cli", { argv: ["sbtools", ...args], exitCode, stdout: scrub(state.stdout), stderr: scrub(state.stderr) });
  return { exitCode, stdout: state.stdout, stderr: state.stderr };
}

function startServer(port, envOverrides = {}) {
  return spawnDrained([SBTOOLS, "server", "--port", String(port)], {
    SERVER_PRIVATE_KEY: keys.sk,
    ...envOverrides,
  });
}

// 虚拟时钟只能推进测试进程自身的事件循环，管不了独立 server 进程的真实启动，
// 所以就绪判定只能真实轮询健康端点并有限重试。
async function waitForHealth(base, scenario, timeoutMs = 15000) {
  const started = Date.now();
  let lastError = "";
  for (let i = 0; Date.now() - started < timeoutMs; i++) {
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) {
        record(scenario, "endpoint", { method: "GET", url: `${base}/healthz`, status: res.status, body: await res.text(), readyMs: Date.now() - started });
        return;
      }
      lastError = `status ${res.status}`;
    } catch (e) {
      lastError = String(e);
    }
    await Bun.sleep(150);
  }
  throw new Error(`server ${base} 未就绪（${timeoutMs}ms 内）：${lastError}`);
}

async function callEndpoint(scenario, url, init) {
  const method = init?.method ?? "GET";
  const res = await fetch(url, init);
  const body = await res.text();
  record(scenario, "endpoint", { method, url: scrubUrl(url), status: res.status, contentType: res.headers.get("content-type") ?? "", body: scrub(body) });
  return { res, body };
}

function extractSubUrl(stdout) {
  const lines = stdout.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("http://") || l.startsWith("https://"));
  expect(lines.length, `stdout 里应有一行订阅 URL，实际:\n${stdout.slice(0, 400)}`).toBeGreaterThan(0);
  return lines[lines.length - 1];
}

// encode 输出断言：Linux 无 pbcopy 走真实 fallback（不 mock pbcopy）；macOS 有 pbcopy 则为复制成功提示。
function expectClipboardLine(stdout) {
  if (process.platform === "darwin") {
    expect(stdout).toContain("已复制到剪切板");
  } else {
    expect(stdout).toContain("未找到 pbcopy，请手动复制下方 URL");
  }
}

async function encodeOk(scenario, args, envOverrides) {
  const r = await runCLI(scenario, ["encode", ...args], envOverrides);
  if (r.exitCode !== 0) {
    throw new Error(`${scenario}: encode 应退出 0，stderr=${r.stderr.slice(0, 300)}`);
  }
  expectClipboardLine(r.stdout);
  return extractSubUrl(r.stdout);
}

async function encodeFails(scenario, args, envOverrides, expectIn) {
  const r = await runCLI(scenario, ["encode", ...args], envOverrides);
  if (r.exitCode === 0) {
    throw new Error(`${scenario}: encode 应非零退出，stdout=${r.stdout.slice(0, 200)}`);
  }
  for (const fragment of expectIn) {
    expect(r.stderr, scenario).toContain(fragment);
  }
  return r;
}

async function fetchSub(scenario, url) {
  const { res, body } = await callEndpoint(scenario, url);
  expect(res.status, `${scenario}: /sub 状态码（body=${body.slice(0, 200)}）`).toBe(200);
  expect(res.headers.get("content-type") ?? "").toContain("application/json");
  return JSON.parse(body);
}

function fixtureDir(name) {
  const dir = join(process.cwd(), ".fixtures", name);
  mkdirSync(dir, { recursive: true });
  if (!tempDirs.includes(dir)) tempDirs.push(dir);
  return dir;
}

function writeConfig(name, yaml) {
  const dir = fixtureDir("configs");
  const path = join(dir, name);
  writeFileSync(path, yaml);
  return path;
}

const CFG_MAIN = writeConfig(
  "cfg-main.yaml",
  `nodes:\n${NODES_ALL.map((n) => `  - ${n}`).join("\n")}\noverlay: |\n  ${OVERLAY.replace(/\n/g, "\n  ")}\n`,
);

function outboundOf(artifact, tag) {
  return artifact.outbounds.find((o) => o.tag === tag);
}

function groupOf(artifact, tag) {
  const g = outboundOf(artifact, tag);
  expect(g, `策略组 ${tag} 应存在`).toBeDefined();
  expect(["selector", "urltest"], `${tag} 应为组类型，实际 ${g?.type}`).toContain(g.type);
  return g;
}

beforeAll(async () => {
  if (!SBTOOLS) throw new Error("SBTOOLS_BIN 未设置：本组验证被测二进制路径由环境注入，缺省不跳过");
  fixtureDir("home-empty");

  const keygen = await runCLI("keygen", ["keygen"]);
  expect(keygen.exitCode).toBe(0);
  const sk = keygen.stdout.match(/SERVER_PRIVATE_KEY=([0-9a-fA-F]{64})/)?.[1];
  const pk = keygen.stdout.match(/SERVER_PUBLIC_KEY=([0-9a-fA-F]{64})/)?.[1];
  expect(sk, "keygen 应输出 64 hex 私钥").toBeDefined();
  expect(pk, "keygen 应输出 64 hex 公钥").toBeDefined();
  keys = { sk, pk, run: keygen };

  mainServer = startServer(PORT_MAIN);
  await waitForHealth(MAIN, "server-ready-main");

  subServer = Bun.serve({
    hostname: "127.0.0.1",
    port: PORT_SUBS,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/sub-line") return new Response(SUB_LINES);
      if (path === "/sub-b64") return new Response(SUB_B64);
      if (path === "/sub-fail") return new Response("boom", { status: 500 });
      if (path === "/sub-garbage") return new Response("not-base64!!");
      if (path === "/sub-huge") return new Response("A".repeat(5 * 1024 * 1024 + 16));
      return new Response("not found", { status: 404 });
    },
  });

  urlMain = await encodeOk("encode-short-flags", ["-s", MAIN, "-c", CFG_MAIN]);
  urlMainAgain = await encodeOk("encode-repeat", ["-s", MAIN, "-c", CFG_MAIN]);
}, 60000);

afterAll(async () => {
  try {
    subServer?.stop(true);
  } catch {}
  for (const p of procs.reverse()) {
    try {
      p.kill("SIGTERM");
    } catch {}
  }
  await Promise.allSettled(procs.map((p) => p.exited));
  for (const p of procs) {
    try {
      if (p.exitCode === null) p.kill("SIGKILL");
    } catch {}
  }
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
  // 结果最后落盘：清理失败也不吞掉证据。
  writeFileSync(join(process.cwd(), "results-server.json"), JSON.stringify(results, null, 2));
});

describe("keygen 与密钥推导", () => {
  test("keygen 输出成对 64-hex 公私钥且互不相同", () => {
    expect(keys.run.exitCode).toBe(0);
    expect(keys.sk).toMatch(/^[0-9a-fA-F]{64}$/);
    expect(keys.pk).toMatch(/^[0-9a-fA-F]{64}$/);
    expect(keys.sk).not.toBe(keys.pk);
    // 私钥只在 keygen stdout 出现一次（results 里已被 scrub）
    expect(keys.run.stdout.split("SERVER_PRIVATE_KEY=").length - 1).toBe(1);
  }, 20000);

  test("GET /pubkey 与 keygen 公钥一致（私钥推导链路）", async () => {
    const { res, body } = await callEndpoint("pubkey", `${MAIN}/pubkey`);
    expect(res.status).toBe(200);
    expect(body.trim()).toMatch(/^[0-9a-f]{64}$/);
    expect(body.trim()).toBe(keys.pk);
  }, 20000);
});

describe("server 端点基础", () => {
  test("GET /healthz 返回 ok", async () => {
    const { res, body } = await callEndpoint("healthz", `${MAIN}/healthz`);
    expect(res.status).toBe(200);
    expect(body).toBe("ok");
  }, 20000);

  test("未知 endpoint 404、POST 404（路由仅认 GET 与已知路径）", async () => {
    const missing = await callEndpoint("unknown-endpoint", `${MAIN}/nope`);
    expect(missing.res.status).toBe(404);
    expect(missing.body).toBe("not found");
    const postHealth = await callEndpoint("post-healthz", `${MAIN}/healthz`, { method: "POST" });
    expect(postHealth.res.status).toBe(404);
    const postSub = await callEndpoint("post-sub", `${MAIN}/sub?d=AAAA`, { method: "POST" });
    expect(postSub.res.status).toBe(404);
  }, 20000);

  test("/sub 缺 d、空 d、非 d 参数都 400「缺少 d 参数」", async () => {
    for (const [name, suffix] of [["missing-d", ""], ["empty-d", "?d="], ["other-param", "?e=zzz"]]) {
      const { res, body } = await callEndpoint(`sub-${name}`, `${MAIN}/sub${suffix}`);
      expect(res.status, name).toBe(400);
      expect(body, name).toBe("缺少 d 参数");
    }
  }, 20000);

  test("/sub 篡改密文 403（GCM 校验失败），非法 base64 也 403", async () => {
    const d = urlMain.split("d=")[1];
    const mid = Math.floor(d.length / 2);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const replacement = [...alphabet].find((c) => c !== d[mid]);
    const tampered = d.slice(0, mid) + replacement + d.slice(mid + 1);
    const flip = await callEndpoint("sub-tampered-ciphertext", `${MAIN}/sub?d=${tampered}`);
    expect(flip.res.status, `篡改应 403，实际 ${flip.res.status}`).toBe(403);
    expect(flip.body).toMatch(/解密失败|Base64URL/);

    const garbage = await callEndpoint("sub-garbage-d", `${MAIN}/sub?d=not-valid-base64!!`);
    expect(garbage.res.status).toBe(403);
    expect(garbage.body).toMatch(/Base64URL/);
  }, 20000);

  test("/sub 超长参数 400（128KB 查询上限）", async () => {
    const { res, body } = await callEndpoint("sub-overlong", `${MAIN}/sub?d=${"A".repeat(128 * 1024 + 10)}`);
    expect(res.status).toBe(400);
    expect(body).toContain("上限");
  }, 20000);
});

describe("encode 与默认 HOME 配置路径", () => {
  test("encode -s/-c 与 --server/--config 长flag 顺序无关；重复 -s 后者生效", async () => {
    const reversed = await encodeOk("encode-flag-order-reversed", ["-c", CFG_MAIN, "-s", MAIN]);
    expect(reversed.split("d=")[1].length).toBeGreaterThan(0);
    const longFlags = await encodeOk("encode-long-flags", ["--server", MAIN, "--config", CFG_MAIN]);
    expect(longFlags.split("d=")[1].length).toBeGreaterThan(0);

    const dup = await runCLI("encode-duplicate-flag-last-wins", [
      "encode", "-s", MAIN, "-s", `http://127.0.0.1:${PORT_DEAD}`, "-c", CFG_MAIN,
    ]);
    expect(dup.exitCode).not.toBe(0);
    // 后一个 -s 覆盖前一个：对无人监听的端口发 /pubkey 请求而失败
    expect(dup.stderr).toContain(`http://127.0.0.1:${PORT_DEAD}`);
    expect(dup.stderr).not.toContain("未知参数");
  }, 30000);

  test("encode 缺省读 $HOME/.config/sing-box/config.yaml 并走完整 /sub 链路", async () => {
    const home = fixtureDir("home-with-cfg");
    mkdirSync(join(home, ".config", "sing-box"), { recursive: true });
    writeFileSync(join(home, ".config", "sing-box", "config.yaml"), `nodes:\n  - ${NODE_HY2.replace("#e2e-hy2-node", "#home-vps-node")}\n`);
    const url = await encodeOk("encode-default-home", ["-s", MAIN], { HOME: home });
    const artifact = await fetchSub("encode-default-home-sub", url);
    expect(outboundOf(artifact, "home-vps-node")?.type).toBe("hysteria2");
  }, 30000);

  test("默认 HOME 无配置时报错并列出查找路径", async () => {
    const emptyHome = fixtureDir("home-without-cfg");
    const r = await runCLI("encode-default-home-missing", ["encode", "-s", MAIN], { HOME: emptyHome });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain(join(emptyHome, ".config", "sing-box", "config.yaml"));
  }, 20000);

  test("encode 未知 flag / 位置参数 / 非法 server 均本地报错", async () => {
    await encodeFails("encode-unknown-flag", ["-s", MAIN, "-c", CFG_MAIN, "-x"], {}, ["未知参数"]);
    await encodeFails("encode-positional-server", ["http://127.0.0.1:1"], {}, ["未知参数"]);
    await encodeFails("encode-server-no-scheme", ["-s", `127.0.0.1:${PORT_MAIN}`, "-c", CFG_MAIN], {}, ["http(s)://"]);
    await encodeFails("encode-config-no-value", ["-s", MAIN, "-c"], {}, ["需要一个配置文件路径"]);
  }, 30000);
});

describe("template_url 客户端校验（SSRF 分支的客户端侧）", () => {
  // 服务端 -s 指向无人监听端口：若 encode 先发网络请求，报错会是连接失败而非下列文案。
  const deadServer = `http://127.0.0.1:${PORT_DEAD}`;

  test("拒绝 http 底模与内网/本机/链路本地 https 底模，且全部在本地、先于任何网络请求", async () => {
    const cases = [
      ["http://example.com/t.json", ["https"]],
      ["https://127.0.0.1/t.json", ["内网"]],
      ["https://192.168.1.1/t.json", ["内网"]],
      ["https://169.254.169.254/latest/meta-data/", ["内网"]],
      ["https://[::1]/t.json", ["内网"]],
      ["https://0.0.0.0/t.json", ["内网"]],
    ];
    for (const [i, [url, fragments]] of cases.entries()) {
      const cfg = writeConfig(`tpl-${i}.yaml`, `nodes:\n  - ${NODE_HY2}\ntemplate_url: ${url}\n`);
      await encodeFails(`template-reject-${url}`, ["-s", deadServer, "-c", cfg], {}, fragments);
    }
  }, 40000);

  test("overlay 含路径引用字段在客户端即拒绝（任意文件读取防线）", async () => {
    const cfg = writeConfig(
      "overlay-path-field.yaml",
      `nodes:\n  - ${NODE_HY2}\noverlay: |\n  {"tls": {"key_path": "/etc/passwd"}}\n`,
    );
    await encodeFails("overlay-forbidden-field", ["-s", deadServer, "-c", cfg], {}, ["key_path", "禁用字段"]);
  }, 20000);

  // 合法公网 https 底模的成功分支需要真实公网出口，本组不伪造：
  // 由协调者用公网 fixture 单独运行（见 verify-sbtools SKILL.md 的「覆盖边界」）。
});

describe("/sub 完整装配：节点、策略组、overlay、反回环", () => {
  let artifact = null;

  test("真实加密 URL 请求真实服务端，两次 encode 密文不同但产物相同", async () => {
    expect(urlMain.split("d=")[1]).not.toBe(urlMainAgain.split("d=")[1]);
    const art1 = await fetchSub("sub-artifact-1", urlMain);
    const art2 = await fetchSub("sub-artifact-2", urlMainAgain);
    expect(art1).toEqual(art2);
    artifact = art1;
  }, 60000);

  test("overlay 标量覆盖在服务端响应中生效", () => {
    expect(artifact.log.level).toBe("warn");
  }, 20000);

  test("反回环直连规则恒居 route.rules 首位，overlay 规则次之，底模规则最后", () => {
    const rules = artifact.route.rules;
    const first = rules[0];
    expect(first.outbound).toBe("direct");
    expect(first.domain, "纯 IP 节点不应生成 domain 分支").toBeUndefined();
    expect(first.ip_cidr).toEqual(["192.0.2.1/32", "192.0.2.2/32", "192.0.2.3/32", "2001:db8::1/128"]);
    // 00-direct(反回环) → 01-overlay(设备规则) → 02-base(底模) 的字典序承重设计
    expect(rules[1]).toEqual({ domain_suffix: "overlay-loop.test", outbound: "proxy" });
    expect(rules[2].action).toBe("sniff");
  }, 20000);

  test("ss/hy2/anytls 节点逐字段精确落进 outbounds（含 IPv6 括号形态）", () => {
    expect(artifact.outbounds[0]).toEqual({ type: "direct", tag: "direct" });
    expect(outboundOf(artifact, "e2e-hy2-node")).toEqual({
      type: "hysteria2", tag: "e2e-hy2-node", server: "192.0.2.1", server_port: 8388,
      password: "e2e-pass", tls: { enabled: true, server_name: "example.com", insecure: true },
    });
    expect(outboundOf(artifact, "e2e-anytls-node")).toEqual({
      type: "anytls", tag: "e2e-anytls-node", server: "192.0.2.2", server_port: 8443,
      password: "at-pass", tls: { enabled: true, server_name: "cdn.example.net" },
    });
    expect(outboundOf(artifact, "e2e-ss-node")).toEqual({
      type: "shadowsocks", tag: "e2e-ss-node", server: "192.0.2.3", server_port: 8388,
      method: "aes-128-gcm", password: "ss-pass",
    });
    expect(outboundOf(artifact, "e2e-v6-node")).toEqual({
      type: "anytls", tag: "e2e-v6-node", server: "[2001:db8::1]", server_port: 8443,
      password: "v6pass", tls: { enabled: true },
    });
  }, 20000);

  test("策略组按模式展开：私有节点保序前插，空组剔除，无悬空引用", () => {
    const tags = artifact.outbounds.map((o) => o.tag);
    const nodes = artifact.outbounds.filter((o) => !["direct", "selector", "urltest"].includes(o.type));
    expect(nodes.map((n) => n.tag)).toEqual(["e2e-hy2-node", "e2e-anytls-node", "e2e-ss-node", "e2e-v6-node"]);
    const lastNodeIdx = tags.lastIndexOf("e2e-v6-node");
    const firstGroupIdx = tags.findIndex((t) => outboundOf(artifact, t)?.type === "selector" || outboundOf(artifact, t)?.type === "urltest");
    expect(firstGroupIdx, "组应整体排在节点之后").toBeGreaterThan(lastNodeIdx);

    expect(groupOf(artifact, "selfhost").outbounds).toEqual(["e2e-hy2-node"]);
    expect(groupOf(artifact, "dns-auto").outbounds).toEqual(["e2e-hy2-node"]);
    expect(groupOf(artifact, "proxy").outbounds).toEqual(["selfhost", "e2e-hy2-node", "e2e-anytls-node", "e2e-ss-node", "e2e-v6-node"]);
    expect(groupOf(artifact, "japansite").outbounds).toEqual(["proxy", "selfhost"]);
    for (const absent of ["hk", "jp", "us", "tw", "sg", "kr"]) {
      expect(outboundOf(artifact, absent), `空组 ${absent} 应被剔除`).toBeUndefined();
    }
    // 完整性：任何组的候选与 DNS detour 都必须解析到真实存在的 tag
    const tagSet = new Set(tags);
    for (const g of artifact.outbounds.filter((o) => ["selector", "urltest"].includes(o.type))) {
      expect(g.outbounds.length, `组 ${g.tag} 非空`).toBeGreaterThan(0);
      for (const entry of g.outbounds) expect(tagSet.has(entry), `${g.tag} 引用存在的 tag`).toBe(true);
      expect(g.interrupt_exist_connections).toBe(true);
    }
    for (const s of artifact.dns.servers) {
      if (typeof s.detour === "string") expect(tagSet.has(s.detour), `dns ${s.tag} detour 存在`).toBe(true);
    }
  }, 20000);
});

describe("订阅源格式与失败订阅", () => {
  test("URI 逐行与 base64 两种订阅格式产出完全相同的配置", async () => {
    const lineCfg = writeConfig("cfg-sub-line.yaml", `subs:\n  - ${SUB_BASE}/sub-line\nnodes:\n  - ${NODE_HY2}\n`);
    const b64Cfg = writeConfig("cfg-sub-b64.yaml", `subs:\n  - ${SUB_BASE}/sub-b64\nnodes:\n  - ${NODE_HY2}\n`);
    const fromLine = await fetchSub("sub-from-line", await encodeOk("encode-sub-line", ["-s", MAIN, "-c", lineCfg]));
    const fromB64 = await fetchSub("sub-from-b64", await encodeOk("encode-sub-b64", ["-s", MAIN, "-c", b64Cfg]));
    expect(fromLine).toEqual(fromB64);

    expect(nodesTags(fromLine)).toEqual(["e2e-hy2-node", "sub-vps-01", "sub-jp-02"]);
    expect(groupOf(fromLine, "selfhost").outbounds).toEqual(["e2e-hy2-node", "sub-vps-01"]);
    expect(groupOf(fromLine, "jp").outbounds).toEqual(["sub-jp-02"]);
    expect(groupOf(fromLine, "proxy").outbounds).toEqual(["selfhost", "e2e-hy2-node", "sub-vps-01", "sub-jp-02"]);
    expect(fromLine.route.rules[0].ip_cidr).toContain("192.0.2.1/32");
    expect(fromLine.route.rules[0].ip_cidr).toContain("198.51.100.10/32");
    expect(fromLine.route.rules[0].ip_cidr).toContain("198.51.100.11/32");
  }, 90000);

  test("失败订阅源：HTTP 500、无法解析内容、超 5MB 均让 /sub 返回 400", async () => {
    const cases = [
      ["sub-fail", "/sub-fail"],
      ["sub-garbage", "/sub-garbage"],
      ["sub-huge", "/sub-huge"],
    ];
    for (const [name, path] of cases) {
      const cfg = writeConfig(`cfg-${name}.yaml`, `subs:\n  - ${SUB_BASE}${path}\n`);
      const url = await encodeOk(`encode-${name}`, ["-s", MAIN, "-c", cfg]);
      const { res, body } = await callEndpoint(`sub-${name}`, url);
      expect(res.status, `${name} 应 400，实际 ${res.status}`).toBe(400);
    }
  }, 90000);
});

function nodesTags(artifact) {
  return artifact.outbounds.filter((o) => !["direct", "selector", "urltest"].includes(o.type)).map((o) => o.tag);
}

describe("server 进程生命周期与错误路径", () => {
  test("缺 SERVER_PRIVATE_KEY 启动即失败", async () => {
    // baseEnv 从零构造：即使协调者 shell 里带了 SERVER_PRIVATE_KEY 也真实复现「未设置」
    const keyFreeEnv = { PATH: process.env.PATH, HOME: fixtureDir("home-empty"), SING_BOX };
    const { proc, state } = spawnDrained([SBTOOLS, "server", "--port", String(PORT_NO_KEY)], {}, keyFreeEnv);
    await state.drained;
    const code = await proc.exited;
    expect(code, `stderr=${state.stderr.slice(0, 200)}`).not.toBe(0);
    expect(state.stderr).toContain("SERVER_PRIVATE_KEY 未设置");
    record("server-missing-key", "cli", { argv: ["sbtools", "server"], exitCode: code, stdout: scrub(state.stdout), stderr: scrub(state.stderr) });
  }, 20000);

  test("坏私钥（非 hex）启动即失败", async () => {
    const r = await runCLI("server-bad-key", ["server", "--port", String(PORT_NO_KEY)], { SERVER_PRIVATE_KEY: "zzzz-not-hex" });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("私钥 Hex 解析失败");
  }, 20000);

  test("非法端口与未知 flag 的 CLI 报错", async () => {
    const badPort = await runCLI("server-port-not-number", ["server", "--port", "abc"]);
    expect(badPort.exitCode).not.toBe(0);
    expect(badPort.stderr).toContain("非法端口: abc");
    const noValue = await runCLI("server-port-no-value", ["server", "--port"]);
    expect(noValue.exitCode).not.toBe(0);
    expect(noValue.stderr).toContain("需要一个数字参数");
    const unknown = await runCLI("server-unknown-flag", ["server", "--bogus", "1"]);
    expect(unknown.exitCode).not.toBe(0);
    expect(unknown.stderr).toContain("server 用法");
  }, 30000);

  test("PORT 环境变量与 -p 短flag 均可指定监听端口", async () => {
    const envSrv = spawnDrained([SBTOOLS, "server"], { SERVER_PRIVATE_KEY: keys.sk, PORT: String(PORT_PORT_ENV) });
    const shortSrv = spawnDrained([SBTOOLS, "server", "-p", String(PORT_SHORT_FLAG)], { SERVER_PRIVATE_KEY: keys.sk }).proc;
    try {
      await waitForHealth(`http://127.0.0.1:${PORT_PORT_ENV}`, "server-ready-port-env");
      await waitForHealth(`http://127.0.0.1:${PORT_SHORT_FLAG}`, "server-ready-short-flag");
    } finally {
      envSrv.proc.kill("SIGTERM");
      shortSrv.kill("SIGTERM");
    }
  }, 30000);

  test("SING_BOX 指向不存在路径：该 server 进程 /sub 返回 400 且报错含内核路径，正常 server 不受影响", async () => {
    const bad = startServer(PORT_BAD_KERNEL, { SING_BOX: "/nonexistent/sbtools-e2e-missing-kernel" });
    try {
      await waitForHealth(`http://127.0.0.1:${PORT_BAD_KERNEL}`, "server-ready-bad-kernel");
      const { res, body } = await callEndpoint("sub-bad-kernel", `http://127.0.0.1:${PORT_BAD_KERNEL}/sub?d=${urlMain.split("d=")[1]}`);
      expect(res.status, `坏内核应 400，实际 ${res.status}`).toBe(400);
      expect(body).toContain("/nonexistent/sbtools-e2e-missing-kernel");
      expect(body).toContain("启动内核失败");

      // 坏内核只影响它自己那个进程：正常 server 的 healthz 与完整 /sub 仍然工作
      const still = await callEndpoint("main-healthz-after-bad-kernel", `${MAIN}/healthz`);
      expect(still.res.status).toBe(200);
      expect(still.body).toBe("ok");
      const artifact = await fetchSub("main-sub-after-bad-kernel", urlMain);
      expect(outboundOf(artifact, "e2e-hy2-node")?.type).toBe("hysteria2");
    } finally {
      bad.proc.kill("SIGTERM");
      await bad.proc.exited;
    }
  }, 60000);
});
