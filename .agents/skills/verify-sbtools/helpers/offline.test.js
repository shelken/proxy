/**
 * sbtools 离线验证套件（slice: offline）— Bun JavaScript（仓库未装 TS 类型声明，保持零依赖）。
 *
 * 被测对象：sbtools 二进制（真实 CLI 进程）；sing-box 内核仅在 check 用例中真实调用，不 mock。
 * 运行环境：隔离 namespace（unshare --net --mount --pid，仅 lo），无外部服务；
 *           涉及 HTTP 的用例用 Bun.serve 合成端点（仅 127.0.0.1）。
 *
 * 环境变量：
 *   SBTOOLS_BIN       必填，被测二进制路径
 *   SING_BOX          check 用例必填，sing-box 内核路径
 *   SOURCE_ROOT       可选，源码根（用于从 scripts/sbtools-rs/Cargo.toml 读期望版本）
 *   EXPECTED_VERSION  可选，显式期望版本，优先于 Cargo.toml（验证 CI 产物时注入）
 *
 * 隔离保证：每次 spawn 注入最小 env（PATH/HOME/SING_BOX），HOME 指向 cwd 下合成夹具，
 * 不触碰真机 HOME 与任何私人配置。每次执行记录 {scenario, argv, stdout, stderr, exit,
 * status, durationMs}，afterAll 汇总写入 cwd/results-offline.json。
 *
 * 断言全部针对用户可见行为（stdout/stderr/exit），不做源码断言；契约上存在两种
 * 合理形态的点记入 observations，但不放宽期望去掩盖真实错误。
 *
 * @typedef {{scenario: string, argv: string[], exit: number|null, status: string,
 *            signal: string|null, killed: boolean, durationMs: number,
 *            home: string, stdout: string, stderr: string}} CaseRecord
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const SBTOOLS_BIN = process.env.SBTOOLS_BIN ?? "";
const KERNEL = process.env.SING_BOX ?? "";
const INJECTED_VERSION = (process.env.EXPECTED_VERSION ?? "").trim();
const FX = join(process.cwd(), "fx-offline");

/** @type {CaseRecord[]} */
const results = [];
const observations = [];
const meta = {};
let expectedVersion = "";

/** 从 start 目录逐级向上查找相对路径 rel（定位仓库清单用）。 */
function findUp(start, rel, maxLevels = 8) {
  let dir = start;
  for (let i = 0; i < maxLevels; i++) {
    const cand = join(dir, rel);
    if (existsSync(cand)) return cand;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** 期望版本：EXPECTED_VERSION 优先，否则从真实 Cargo.toml 读取（不硬编码版本号）。 */
function resolveExpectedVersion() {
  if (INJECTED_VERSION) return INJECTED_VERSION;
  const rel = join("scripts", "sbtools-rs", "Cargo.toml");
  const fromSource =
    process.env.SOURCE_ROOT && existsSync(join(process.env.SOURCE_ROOT, rel))
      ? join(process.env.SOURCE_ROOT, rel)
      : null;
  const manifest = fromSource ?? findUp(import.meta.dir, rel) ?? findUp(process.cwd(), rel);
  if (!manifest) {
    throw new Error(
      "无法确定期望版本：设置 EXPECTED_VERSION，或提供 SOURCE_ROOT / 在仓库内运行（需找到 scripts/sbtools-rs/Cargo.toml）",
    );
  }
  const m = readFileSync(manifest, "utf8").match(/^version\s*=\s*"([^"]+)"/m);
  if (!m) throw new Error(`Cargo.toml 未找到 version 字段: ${manifest}`);
  return m[1];
}

/** 在 home 下生成合成配置目录与文件。 */
function makeHome(tag) {
  const home = join(FX, tag, "home");
  mkdirSync(join(home, ".config", "sing-box"), { recursive: true });
  return home;
}

/** 写文件（自动建父目录），返回绝对路径。 */
function writeFx(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

/** 客户端 YAML（合法最小形态）+ 可选 overlay 块（YAML 块标量内嵌 JSON）。 */
const clientYaml = (overlayJson, extra = "") =>
  `subs:\n  - https://airport.example/sub\n${extra}` +
  (overlayJson ? `overlay: |\n  ${overlayJson.replace(/\n/g, "\n  ")}\n` : "");

function requireKernel() {
  if (!KERNEL) throw new Error("缺少 SING_BOX 环境变量（sing-box 内核路径），无法运行内核用例");
  return KERNEL;
}

/**
 * 执行被测 CLI 并记录完整证据。
 *
 * 真实 setTimeout 仅作兜底 kill：虚拟时钟（vi.useFakeTimers）只控制本进程 JS 计时，
 * 无法驱动或终止外部子进程，跨进程超时必须走真实时钟。
 */
async function runCli(scenario, args, opts) {
  const started = Date.now();
  const proc = Bun.spawn([SBTOOLS_BIN, ...args], {
    cwd: FX,
    env: { PATH: "/usr/bin:/bin", HOME: opts.home, SING_BOX: KERNEL, ...opts.env },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  let killed = false;
  const timer = setTimeout(() => {
    killed = true;
    proc.kill("SIGKILL");
  }, opts.timeoutMs ?? 20_000);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exit = await proc.exited;
  clearTimeout(timer);
  /** @type {CaseRecord} */
  const rec = {
    scenario,
    argv: ["sbtools", ...args],
    exit,
    killed,
    status: killed ? "timeout-killed" : exit === 0 ? "ok" : "error",
    signal: proc.signalCode ?? null,
    durationMs: Date.now() - started,
    home: opts.home,
    stdout,
    stderr,
  };
  results.push(rec);
  return rec;
}

beforeAll(() => {
  if (!SBTOOLS_BIN) throw new Error("缺少 SBTOOLS_BIN 环境变量（被测二进制路径）");
  if (!existsSync(SBTOOLS_BIN)) throw new Error(`SBTOOLS_BIN 不存在: ${SBTOOLS_BIN}`);
  expectedVersion = resolveExpectedVersion();
  rmSync(FX, { recursive: true, force: true });
  mkdirSync(FX, { recursive: true });
  meta.binary = SBTOOLS_BIN;
  meta.kernel = KERNEL;
  meta.expectedVersion = expectedVersion;
  if (KERNEL && existsSync(KERNEL)) {
    try {
      const p = Bun.spawnSync([KERNEL, "version"], { env: { PATH: "/usr/bin:/bin" } });
      meta.singBoxVersion = p.stdout.toString().trim().split("\n")[0] ?? "";
    } catch {
      meta.singBoxVersion = "unknown";
    }
  }
  observations.push(
    "契约注记: `--help`/`-h` 未被特殊处理，按未知命令输出 usage 到 stderr 且 exit 1（实测口径）",
    "契约注记: 无参数裸调用 exit 0（usage 到 stderr）；未知命令 exit 1，两者不对称",
    "契约注记: trace 非回环拒绝文案建议 `--api 显式指定`，即使该地址正来自 --api 本身",
    "契约注记: logs 无 `-n` 时无默认 tail 行数，直接退化为 -f 跟踪 /logs 流",
  );
});

afterAll(() => {
  const out = {
    slice: "offline",
    finishedAt: new Date().toISOString(),
    total: results.length,
    meta,
    observations,
    results,
  };
  const outPath = join(process.cwd(), "results-offline.json");
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`[offline] ${results.length} 条记录 → ${outPath}`);
});

// ---------------------------------------------------------------------------
// version 与帮助
// ---------------------------------------------------------------------------

describe("version 与帮助", () => {
  test("version 子命令输出 sbtools <版本> 且 exit 0", async () => {
    const rec = await runCli("version 子命令", ["version"], { home: makeHome("version-sub") });
    expect(rec.exit).toBe(0);
    expect(rec.stdout.trim()).toBe(`sbtools ${expectedVersion}`);
  });

  test.each([["--version"], ["-V"]])("%s 输出同一版本号", async (flag) => {
    const rec = await runCli(`version 标志 ${flag}`, [flag], { home: makeHome("version-flag") });
    expect(rec.exit).toBe(0);
    expect(rec.stdout.trim()).toBe(`sbtools ${expectedVersion}`);
  });

  test("无参数裸调用：usage 到 stderr、exit 0", async () => {
    const rec = await runCli("裸调用无参数", [], { home: makeHome("bare") });
    expect(rec.exit).toBe(0);
    expect(rec.stdout).toBe("");
    expect(rec.stderr).toContain("sbtools");
  });

  test("未知命令：usage 到 stderr、exit 1", async () => {
    const rec = await runCli("未知命令 frobnicate", ["frobnicate"], { home: makeHome("unknown-cmd") });
    expect(rec.exit).toBe(1);
    expect(rec.stdout).toBe("");
    for (const cmd of ["encode", "trace", "check", "config", "logs", "keygen", "version"]) {
      expect(rec.stderr).toContain(cmd);
    }
  });

  test("--help 按未知命令处理（usage 到 stderr、exit 1）", async () => {
    const rec = await runCli("--help 未特殊处理", ["--help"], { home: makeHome("help-flag") });
    expect(rec.exit).toBe(1);
    expect(rec.stderr).toContain("encode");
    expect(rec.stderr).toContain("keygen");
  });
});

// ---------------------------------------------------------------------------
// keygen
// ---------------------------------------------------------------------------

describe("keygen", () => {
  test("两次运行各自产出 64hex 公私钥且互不相同", async () => {
    const home = makeHome("keygen");
    const r1 = await runCli("keygen 第一次", ["keygen"], { home });
    const r2 = await runCli("keygen 第二次", ["keygen"], { home });
    for (const rec of [r1, r2]) {
      expect(rec.exit).toBe(0);
      const lines = rec.stdout.trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatch(/^SERVER_PRIVATE_KEY=[0-9a-f]{64}$/);
      expect(lines[1]).toMatch(/^SERVER_PUBLIC_KEY=[0-9a-f]{64}$/);
      expect(lines[0].split("=")[1]).not.toBe(lines[1].split("=")[1]);
    }
    const sk1 = r1.stdout.trim().split("\n")[0].split("=")[1];
    const sk2 = r2.stdout.trim().split("\n")[0].split("=")[1];
    const pk1 = r1.stdout.trim().split("\n")[1].split("=")[1];
    const pk2 = r2.stdout.trim().split("\n")[1].split("=")[1];
    expect(sk1).not.toBe(sk2);
    expect(pk1).not.toBe(pk2);
  });
});

// ---------------------------------------------------------------------------
// encode：全部为本地校验路径（namespace 内无网络，成功路径需要 /pubkey，不在本组）
// ---------------------------------------------------------------------------

describe("encode 本地校验", () => {
  test("无参：报用法错误 exit 1", async () => {
    const rec = await runCli("encode 无参数", ["encode"], { home: makeHome("encode-noargs") });
    expect(rec.exit).toBe(1);
    expect(rec.stderr).toContain("encode 用法");
    expect(rec.stderr).toContain("-s");
  });

  test("-s 缺值报错", async () => {
    const rec = await runCli("encode -s 缺值", ["encode", "-s"], { home: makeHome("encode-s-missing") });
    expect(rec.exit).toBe(1);
    expect(rec.stderr).toContain("-s 需要一个服务端地址");
  });

  test("-c 缺值报错", async () => {
    const rec = await runCli("encode -c 缺值", ["encode", "-s", "http://sub.example.invalid", "-c"], {
      home: makeHome("encode-c-missing"),
    });
    expect(rec.exit).toBe(1);
    expect(rec.stderr).toContain("-c 需要一个配置文件路径");
  });

  test("未知 flag 报错", async () => {
    const rec = await runCli("encode 未知 flag", ["encode", "-s", "http://sub.example.invalid", "-x"], {
      home: makeHome("encode-unknown-flag"),
    });
    expect(rec.exit).toBe(1);
    expect(rec.stderr).toContain("未知参数 -x");
  });

  test("位置参数形式的 server 已废弃：按未知参数拒绝", async () => {
    const rec = await runCli("encode 位置参数被拒", ["encode", "https://sub.example.invalid"], {
      home: makeHome("encode-positional"),
    });
    expect(rec.exit).toBe(1);
    expect(rec.stderr).toContain("未知参数 https://sub.example.invalid");
  });

  test("server 非 http(s) scheme 拒绝", async () => {
    const rec = await runCli("encode scheme 拒绝", ["encode", "-s", "ftp://sub.example.invalid"], {
      home: makeHome("encode-scheme"),
    });
    expect(rec.exit).toBe(1);
    expect(rec.stderr).toContain("服务端地址必须以 http(s):// 开头");
    expect(rec.stderr).toContain("ftp://sub.example.invalid");
  });

  test("server 空串拒绝", async () => {
    const rec = await runCli("encode 空 server", ["encode", "-s", ""], { home: makeHome("encode-empty-server") });
    expect(rec.exit).toBe(1);
    expect(rec.stderr).toContain("服务端地址不能为空");
  });

  test("配置文件不存在报错并指出路径", async () => {
    const home = makeHome("encode-missing-file");
    const rec = await runCli(
      "encode 缺配置文件",
      ["encode", "-s", "http://sub.example.invalid", "-c", join(home, "nope.yaml")],
      { home },
    );
    expect(rec.exit).toBe(1);
    expect(rec.stderr).toContain("读取配置");
    expect(rec.stderr).toContain("nope.yaml");
  });

  test("YAML 解析失败报错", async () => {
    const home = makeHome("encode-broken-yaml");
    const p = writeFx(join(home, ".config", "sing-box", "broken.yaml"), "subs: [unclosed\n");
    const rec = await runCli("encode 损坏 YAML", ["encode", "-s", "http://sub.example.invalid", "-c", p], { home });
    expect(rec.exit).toBe(1);
    expect(rec.stderr).toContain("YAML 解析失败");
  });

  test("subs 与 nodes 均空拒绝", async () => {
    const home = makeHome("encode-empty-sources");
    const p = writeFx(join(home, ".config", "sing-box", "empty.yaml"), "subs: []\n");
    const rec = await runCli("encode 空输入", ["encode", "-s", "http://sub.example.invalid", "-c", p], { home });
    expect(rec.exit).toBe(1);
    expect(rec.stderr).toContain("至少需要一个非空列表");
  });

  test("subs 非 http(s) URL 拒绝", async () => {
    const home = makeHome("encode-bad-sub");
    const p = writeFx(join(home, ".config", "sing-box", "bad-sub.yaml"), "subs:\n  - ftp://airport.example/sub\n");
    const rec = await runCli("encode subs 非法 URL", ["encode", "-s", "http://sub.example.invalid", "-c", p], { home });
    expect(rec.exit).toBe(1);
    expect(rec.stderr).toContain("subs[0] 必须是 http(s) URL");
  });

  test("overlay 非法 JSON 拒绝", async () => {
    const home = makeHome("encode-overlay-badjson");
    const p = writeFx(join(home, ".config", "sing-box", "ov.yaml"), clientYaml("{{not-json}}"));
    const rec = await runCli("encode overlay 非法 JSON", ["encode", "-s", "http://sub.example.invalid", "-c", p], { home });
    expect(rec.exit).toBe(1);
    expect(rec.stderr).toContain("overlay JSON 解析失败");
  });

  test("overlay 顶层非 Object 拒绝", async () => {
    const home = makeHome("encode-overlay-array");
    const p = writeFx(join(home, ".config", "sing-box", "ov.yaml"), clientYaml("[1, 2, 3]"));
    const rec = await runCli("encode overlay 顶层数组", ["encode", "-s", "http://sub.example.invalid", "-c", p], { home });
    expect(rec.exit).toBe(1);
    expect(rec.stderr).toContain("overlay 顶层必须是 JSON Object");
  });

  test("overlay 含 certificate_path 路径字段拒绝", async () => {
    const home = makeHome("encode-overlay-certpath");
    const p = writeFx(
      join(home, ".config", "sing-box", "ov.yaml"),
      clientYaml('{"inbounds":[{"type":"mixed","tls":{"certificate_path":"/etc/passwd"}}]}'),
    );
    const rec = await runCli("encode overlay 路径字段", ["encode", "-s", "http://sub.example.invalid", "-c", p], { home });
    expect(rec.exit).toBe(1);
    expect(rec.stderr).toContain("禁用字段 `certificate_path`");
  });

  test("overlay ECH 嵌套 config_path 同样拒绝", async () => {
    const home = makeHome("encode-overlay-echpath");
    const p = writeFx(
      join(home, ".config", "sing-box", "ov.yaml"),
      clientYaml('{"outbounds":[{"type":"vmess","tls":{"ech":{"config_path":"/etc/passwd"}}}]}'),
    );
    const rec = await runCli(
      "encode overlay ECH 嵌套路径字段",
      ["encode", "-s", "http://sub.example.invalid", "-c", p],
      { home },
    );
    expect(rec.exit).toBe(1);
    expect(rec.stderr).toContain("禁用字段 `config_path`");
  });

  test("template_url 非 https 拒绝", async () => {
    const home = makeHome("encode-tpl-http");
    const p = writeFx(
      join(home, ".config", "sing-box", "tpl.yaml"),
      clientYaml(undefined, "template_url: http://example.invalid/t.json\n"),
    );
    const rec = await runCli("encode template_url http", ["encode", "-s", "http://sub.example.invalid", "-c", p], { home });
    expect(rec.exit).toBe(1);
    expect(rec.stderr).toContain("template_url 仅支持 https");
  });

  test("template_url 指向回环地址拒绝（SSRF 防护）", async () => {
    const home = makeHome("encode-tpl-loopback");
    const p = writeFx(
      join(home, ".config", "sing-box", "tpl.yaml"),
      clientYaml(undefined, "template_url: https://127.0.0.1/t.json\n"),
    );
    const rec = await runCli("encode template_url 内网", ["encode", "-s", "http://sub.example.invalid", "-c", p], { home });
    expect(rec.exit).toBe(1);
    expect(rec.stderr).toContain("不得指向内网地址");
  });

  test("template_url 非法 URL 本地解析报错", async () => {
    const home = makeHome("encode-tpl-garbage");
    const p = writeFx(
      join(home, ".config", "sing-box", "tpl.yaml"),
      clientYaml(undefined, "template_url: not a url\n"),
    );
    const rec = await runCli("encode template_url 非法", ["encode", "-s", "http://sub.example.invalid", "-c", p], { home });
    expect(rec.exit).toBe(1);
    expect(rec.stderr).toContain("template_url");
    expect(rec.stderr).toContain("解析失败");
  });

  test("本地校验先于网络：非法配置不发起 /pubkey 请求", async () => {
    const home = makeHome("encode-order");
    const p = writeFx(join(home, ".config", "sing-box", "empty.yaml"), "subs: []\n");
    const rec = await runCli("encode 校验先于网络", ["encode", "-s", "http://127.0.0.1:59993", "-c", p], { home });
    expect(rec.exit).toBe(1);
    expect(rec.stderr).toContain("至少需要一个非空列表");
    expect(rec.stderr).not.toContain("HTTP 请求失败");
  });
});

// ---------------------------------------------------------------------------
// check：真实内核 merge + check，不 mock
// ---------------------------------------------------------------------------

describe("check", () => {
  test("底模（无 overlay）内核 check 通过并输出生效摘要", async () => {
    requireKernel();
    const home = makeHome("check-base");
    const p = writeFx(join(home, ".config", "sing-box", "config.yaml"), clientYaml());
    const rec = await runCli("check 纯底模", ["check", "-c", p], { home });
    expect(rec.exit).toBe(0);
    expect(rec.stdout).toContain("内核 check 通过");
    expect(rec.stdout).toContain("底模: embedded");
    expect(rec.stdout).toContain("dns.rules 条数");
    expect(rec.stdout).toContain("route.default_domain_resolver: dns-local-system");
    expect(rec.stdout).toContain("route.final: proxy");
  });

  test("合法 overlay 合并后内核 check 通过，摘要反映 overlay 生效", async () => {
    requireKernel();
    const home = makeHome("check-overlay-ok");
    const p = writeFx(
      join(home, ".config", "sing-box", "config.yaml"),
      clientYaml('{"log":{"level":"debug"},"dns":{"rules":[{"domain_suffix":["example.test"],"server":"dns-local-system"}]}}'),
    );
    const rec = await runCli("check 合法 overlay", ["check", "-c", p], { home });
    expect(rec.exit).toBe(0);
    expect(rec.stdout).toContain("内核 check 通过");
    expect(rec.stdout).toContain("domain_suffix=example.test -> dns-local-system");
    expect(rec.stdout).toContain("log.level: debug");
    const m = rec.stdout.match(/dns\.rules 条数: (\d+)/);
    expect(m).not.toBeNull();
    expect(Number(m[1])).toBeGreaterThanOrEqual(10);
  });

  test("显式 -c 缺文件报错", async () => {
    const home = makeHome("check-missing-file");
    const rec = await runCli("check 缺文件", ["check", "-c", join(home, "missing.yaml")], { home });
    expect(rec.exit).toBe(1);
    expect(rec.stderr).toContain("读取配置");
    expect(rec.stderr).toContain("missing.yaml");
  });

  test("默认发现路径缺文件报错（不静默）", async () => {
    const home = makeHome("check-default-missing");
    const rec = await runCli("check 默认路径缺文件", ["check"], { home });
    expect(rec.exit).toBe(1);
    expect(rec.stderr).toContain("读取配置");
    expect(rec.stderr).toContain(join(".config", "sing-box", "config.yaml"));
  });

  test("损坏 YAML 报解析错误", async () => {
    const home = makeHome("check-broken-yaml");
    const p = writeFx(join(home, ".config", "sing-box", "broken.yaml"), "subs: [unclosed\n");
    const rec = await runCli("check 损坏 YAML", ["check", "-c", p], { home });
    expect(rec.exit).toBe(1);
    expect(rec.stderr).toContain("YAML 解析失败");
  });

  test("overlay 引用不存在的 rule-set：内核 check 失败（该命令的核心价值）", async () => {
    requireKernel();
    const home = makeHome("check-bad-ruleset");
    const p = writeFx(
      join(home, ".config", "sing-box", "config.yaml"),
      clientYaml('{"dns":{"rules":[{"rule_set":["Definitely-Missing-Ruleset"],"server":"dns-local-system"}]}}'),
    );
    const rec = await runCli("check 不存在 ruleset 引用", ["check", "-c", p], { home });
    expect(rec.exit).toBe(1);
    expect(rec.stderr).toContain("内核 check 失败");
    expect(rec.stdout).not.toContain("内核 check 通过");
    // 内核 FATAL 原文已完整记录于 results；不硬断言内核措辞，但必须能定位到该 ruleset
    if (!rec.stderr.includes("Definitely-Missing-Ruleset")) {
      observations.push(
        `check-bad-ruleset: 内核报错未直接点名 ruleset（stderr 前 500 字: ${rec.stderr.slice(0, 500)}）`,
      );
    }
  });

  test("SING_BOX 指向不存在路径：报错含该路径", async () => {
    const home = makeHome("check-no-kernel");
    const bogus = join(home, "no-such-sing-box");
    const p = writeFx(join(home, ".config", "sing-box", "config.yaml"), clientYaml());
    const rec = await runCli("check 不存在 SING_BOX", ["check", "-c", p], {
      home,
      env: { SING_BOX: bogus },
    });
    expect(rec.exit).toBe(1);
    expect(rec.stderr).toContain("启动内核失败");
    expect(rec.stderr).toContain("no-such-sing-box");
    expect(rec.stdout).not.toContain("内核 check 通过");
  });

  test("未知 flag 与 -c 缺值分别报错", async () => {
    const home = makeHome("check-flags");
    const bad = await runCli("check 未知 flag", ["check", "--oops"], { home });
    expect(bad.exit).toBe(1);
    expect(bad.stderr).toContain("未知参数 --oops");
    const missing = await runCli("check -c 缺值", ["check", "-c"], { home });
    expect(missing.exit).toBe(1);
    expect(missing.stderr).toContain("-c 需要一个配置文件路径");
  });
});

// ---------------------------------------------------------------------------
// config：脱敏与发现
// ---------------------------------------------------------------------------

describe("config", () => {
  test("--path 显式缺文件报错", async () => {
    const home = makeHome("config-missing-explicit");
    const rec = await runCli("config 显式缺文件", ["config", "--path", join(home, "missing.json")], { home });
    expect(rec.exit).toBe(1);
    expect(rec.stderr).toContain("ERROR: 读取");
    expect(rec.stderr).toContain("missing.json");
  });

  test("--path 缺值报错", async () => {
    const rec = await runCli("config --path 缺值", ["config", "--path"], { home: makeHome("config-path-missing") });
    expect(rec.exit).toBe(1);
    expect(rec.stderr).toContain("--path 需要一个配置文件路径");
  });

  test("未知 flag 报错", async () => {
    const rec = await runCli("config 未知 flag", ["config", "--bogus"], { home: makeHome("config-unknown-flag") });
    expect(rec.exit).toBe(1);
    expect(rec.stderr).toContain("未知参数 --bogus");
  });

  test("发现链：config.yaml 优先于 legacy singbox.json", async () => {
    const home = makeHome("config-discovery-yaml");
    writeFx(join(home, ".config", "sing-box", "config.yaml"), "subs:\n  - https://airport.example/sub\n");
    writeFx(join(home, ".config", "sing-box", "singbox.json"), '{"memo":"LEGACY-JSON-MARKER"}');
    const rec = await runCli("config yaml 优先", ["config"], { home });
    expect(rec.exit).toBe(0);
    expect(rec.stdout).toContain("✓ 生效配置:");
    expect(rec.stdout).toContain(join(".config", "sing-box", "config.yaml"));
    expect(rec.stdout).not.toContain("LEGACY-JSON-MARKER");
    // 顶层 subs 元素整体脱敏
    expect(rec.stdout).toContain("[已隐藏]");
    expect(rec.stdout).not.toContain("airport.example");
  });

  test("发现链：仅 legacy singbox.json 时可用", async () => {
    const home = makeHome("config-discovery-legacy");
    writeFx(join(home, ".config", "sing-box", "singbox.json"), '{"memo":"LEGACY-ONLY-MARKER"}');
    const rec = await runCli("config 仅 legacy json", ["config"], { home });
    expect(rec.exit).toBe(0);
    expect(rec.stdout).toContain(join(".config", "sing-box", "singbox.json"));
    expect(rec.stdout).toContain("LEGACY-ONLY-MARKER");
  });

  test("发现链：无任何配置且 API 离线 → 明示报错而非静默", async () => {
    const home = makeHome("config-none-offline");
    const rec = await runCli("config 缺配置且离线", ["config"], { home });
    expect(rec.exit).toBe(1);
    expect(rec.stdout).toContain("磁盘未找到生效配置");
    expect(rec.stderr).toContain("未找到生效配置，且 clash api 127.0.0.1:9090 不可达");
    expect(rec.stderr).toContain("--path");
  });

  test("顶层 JSON 脱敏：出站凭据隐藏，非机密路由保留", async () => {
    const home = makeHome("config-redact-json");
    const top = {
      log: { level: "info", output: join(FX, "redact-json.log") },
      experimental: { clash_api: { external_controller: "127.0.0.1:19090", secret: "FAKE-CTRL-SECRET" } },
      dns: {
        servers: [{ type: "udp", tag: "dns-direct-cn", server: "192.0.2.53" }],
        rules: [{ domain_suffix: ["example.org"], server: "dns-alt" }],
      },
      route: {
        default_domain_resolver: { server: "dns-direct-cn" },
        rules: [{ domain_suffix: ["demo.test"], outbound: "direct" }],
        final: "proxy",
      },
      outbounds: [
        { type: "shadowsocks", tag: "proxy", server: "192.0.2.20", server_port: 8388, password: "FAKE-PW" },
        {
          type: "vless",
          tag: "proxy-2",
          server: "192.0.2.21",
          uuid: "FAKE-UUID",
          tls: { reality: { public_key: "FAKE-PK", short_id: "FAKE-SID" } },
        },
      ],
    };
    const p = writeFx(join(home, ".config", "sing-box", "top.json"), JSON.stringify(top));
    const rec = await runCli("config 顶层 JSON 脱敏", ["config", "--path", p], { home });
    expect(rec.exit).toBe(0);
    const out = rec.stdout;
    for (const secret of [
      "FAKE-PW",
      "FAKE-UUID",
      "FAKE-PK",
      "FAKE-SID",
      "FAKE-CTRL-SECRET",
      "192.0.2.20",
      "192.0.2.21",
    ]) {
      expect(out).not.toContain(secret);
    }
    // 非机密项保留：dns 上游、dns/route 标签、controller、端口、路由动作
    expect(out).toContain("192.0.2.53");
    expect(out).toContain("dns-alt");
    expect(out).toContain("dns-direct-cn");
    expect(out).toContain("127.0.0.1:19090");
    expect(out).toContain("8388");
    expect(out).toContain("demo.test");
    expect(out).toContain("[已隐藏]");
  });

  test("YAML overlay 脱敏：subs/nodes 整体隐藏，overlay 递归脱敏后保留 log.output", async () => {
    const home = makeHome("config-redact-yaml");
    const overlayLog = join(FX, "redact-yaml.log");
    const overlay = JSON.stringify({
      outbounds: [{ type: "ss", tag: "ov-proxy", server: "192.0.2.7", password: "FAKE-OV-PW" }],
      log: { output: overlayLog, level: "debug" },
    });
    const p = writeFx(
      join(home, ".config", "sing-box", "client.yaml"),
      "subs:\n  - https://airport.example/sub?token=FAKE-SUB-TOKEN\n" +
        "nodes:\n  - ss://RkFLRS1CQVNFPQA=@192.0.2.10:8388#node-a\n  - hy2://user:FAKE-HY2-PASS@192.0.2.11:443\n" +
        `overlay: |\n  ${overlay}\n`,
    );
    const rec = await runCli("config YAML overlay 脱敏", ["config", "--path", p], { home });
    expect(rec.exit).toBe(0);
    const out = rec.stdout;
    for (const secret of [
      "FAKE-SUB-TOKEN",
      "RkFLRS1CQVNFPQA=",
      "FAKE-HY2-PASS",
      "FAKE-OV-PW",
      "192.0.2.7",
      "192.0.2.10",
      "192.0.2.11",
      "airport.example",
    ]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain("[已隐藏]");
    // overlay 内 log.output 非机密，保留
    expect(out).toContain(overlayLog);
  });

  test("顶层 clash_api 非回环：拒绝连接并跳过运行时摘要（exit 0）", async () => {
    const home = makeHome("config-nonloopback-top");
    const p = writeFx(
      join(home, ".config", "sing-box", "top.json"),
      JSON.stringify({ experimental: { clash_api: { external_controller: "192.0.2.5:19090" } } }),
    );
    const rec = await runCli("config top 非回环跳过摘要", ["config", "--path", p], { home });
    expect(rec.exit).toBe(0);
    expect(rec.stdout).toContain("controller 192.0.2.5:19090 非回环地址，已拒绝");
    expect(rec.stdout).toContain("跳过运行时摘要");
    expect(rec.stdout).not.toContain("SFM 运行时");
  });

  test("overlay clash_api 非回环：同样拒绝并跳过摘要", async () => {
    const home = makeHome("config-nonloopback-overlay");
    const p = writeFx(
      join(home, ".config", "sing-box", "client.yaml"),
      clientYaml('{"experimental":{"clash_api":{"external_controller":"127.0.0.2:19090"}}}'),
    );
    const rec = await runCli("config overlay 非回环跳过摘要", ["config", "--path", p], { home });
    expect(rec.exit).toBe(0);
    expect(rec.stdout).toContain("controller 127.0.0.2:19090 非回环地址，已拒绝");
    expect(rec.stdout).not.toContain("SFM 运行时");
  });

  test("loopback controller 可达：附 /configs 运行时摘要（合成端点）", async () => {
    const home = makeHome("config-runtime-summary");
    const requests = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        requests.push(path);
        if (path === "/version") return Response.json({ version: "v1.19.0-fake" });
        if (path === "/configs") {
          return Response.json({ mode: "rule", "mixed-port": 2080, tun: { enable: true }, "log-level": "info" });
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const p = writeFx(
        join(home, ".config", "sing-box", "top.json"),
        JSON.stringify({ experimental: { clash_api: { external_controller: `127.0.0.1:${server.port}` } } }),
      );
      const rec = await runCli("config 可达附运行时摘要", ["config", "--path", p], { home });
      expect(rec.exit).toBe(0);
      expect(rec.stdout).toContain(`✓ SFM 运行时 (clash api 127.0.0.1:${server.port})`);
      expect(rec.stdout).toContain("  mode: rule");
      expect(rec.stdout).toContain("  mixed-port: 2080");
      expect(rec.stdout).toContain("  tun: true");
      expect(rec.stdout).toContain("  log-level: info");
      expect(rec.stdout).toContain("SFM profile 磁盘直读受限");
      expect(requests).toContain("/configs");
    } finally {
      server.stop(true);
    }
  });

  test("loopback controller 存在但离线：磁盘配置已打印，静默跳过摘要（exit 0）", async () => {
    const home = makeHome("config-loopback-offline");
    const srv = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("x") });
    const port = srv.port;
    srv.stop(true); // 先占再释放，取一个确定空闲的端口
    const p = writeFx(
      join(home, ".config", "sing-box", "top.json"),
      JSON.stringify({ experimental: { clash_api: { external_controller: `127.0.0.1:${port}` } } }),
    );
    const rec = await runCli("config 离线静默跳过", ["config", "--path", p], { home });
    expect(rec.exit).toBe(0);
    expect(rec.stdout).toContain("✓ 生效配置:");
    expect(rec.stdout).not.toContain("SFM 运行时");
    expect(rec.stderr).not.toContain("ERROR");
  });
});

// ---------------------------------------------------------------------------
// logs
// ---------------------------------------------------------------------------

describe("logs", () => {
  /**
   * 生成 legacy singbox.json + log.output 文件的夹具。
   * 返回 { logPath, lines } 供 tail 断言。
   */
  function setupLegacy(home, count = 10) {
    const lines = Array.from({ length: count }, (_, i) => `line-${String(i + 1).padStart(2, "0")}`);
    const logPath = writeFx(join(home, "kernel.log"), lines.join("\n"));
    writeFx(join(home, ".config", "sing-box", "singbox.json"), JSON.stringify({ log: { level: "info", output: logPath } }));
    return { logPath, lines };
  }

  test.each([
    ["-n 3 读末 3 行", 3],
    ["-n 1 读末 1 行", 1],
  ])("tail %s", async (_label, n) => {
    const home = makeHome(`logs-tail-${n}`);
    const { logPath, lines } = setupLegacy(home);
    const rec = await runCli(`logs tail ${n}`, ["logs", "-n", String(n)], { home });
    expect(rec.exit).toBe(0);
    const out = rec.stdout.trim().split("\n");
    expect(out[0]).toBe(`✓ log.output: ${logPath}`);
    expect(out.slice(1)).toEqual(lines.slice(-n));
  });

  test("-n 0 输出零行", async () => {
    const home = makeHome("logs-tail-0");
    const { logPath, lines } = setupLegacy(home);
    const rec = await runCli("logs tail 0", ["logs", "-n", "0"], { home });
    expect(rec.exit).toBe(0);
    expect(rec.stdout.trim().split("\n")).toEqual([`✓ log.output: ${logPath}`]);
    expect(rec.stdout).not.toContain(lines[0]);
  });

  test("-n 大于总行数时全量返回", async () => {
    const home = makeHome("logs-tail-big");
    const { logPath, lines } = setupLegacy(home, 10);
    const rec = await runCli("logs tail 999", ["logs", "-n", "999"], { home });
    expect(rec.exit).toBe(0);
    const out = rec.stdout.trim().split("\n");
    expect(out[0]).toBe(`✓ log.output: ${logPath}`);
    expect(out.slice(1)).toEqual(lines);
  });

  test("发现优先级：config.yaml 的 log.output 胜出 legacy singbox.json", async () => {
    const home = makeHome("logs-yaml-vs-legacy");
    const yamlLog = writeFx(join(home, "yaml.log"), "y-1\ny-2\n");
    writeFx(join(home, ".config", "sing-box", "config.yaml"), `log:\n  output: ${yamlLog}\n`);
    const legacyLog = writeFx(join(home, "legacy.log"), "l-1\nl-2\n");
    writeFx(
      join(home, ".config", "sing-box", "singbox.json"),
      JSON.stringify({ log: { output: legacyLog }, memo: "LEGACY-MARKER" }),
    );
    const rec = await runCli("logs yaml 优先", ["logs", "-n", "2"], { home });
    expect(rec.exit).toBe(0);
    expect(rec.stdout).toContain(`✓ log.output: ${yamlLog}`);
    expect(rec.stdout).toContain("y-1");
    expect(rec.stdout).not.toContain("l-1");
    expect(rec.stdout).not.toContain("LEGACY-MARKER");
  });

  test("root 无 log.output 时退化读取 overlay 内的 log.output", async () => {
    const home = makeHome("logs-overlay-fallback");
    const overlayLog = writeFx(join(home, "overlay.log"), "o-1\no-2\n");
    writeFx(
      join(home, ".config", "sing-box", "config.yaml"),
      clientYaml(`{"log":{"output":${JSON.stringify(overlayLog)}}}`),
    );
    const rec = await runCli("logs overlay 退化", ["logs", "-n", "1"], { home });
    expect(rec.exit).toBe(0);
    expect(rec.stdout).toContain(`✓ log.output: ${overlayLog}`);
    expect(rec.stdout.trim().split("\n").slice(1)).toEqual(["o-2"]);
  });

  test("log.output 文件不存在报错", async () => {
    const home = makeHome("logs-missing-file");
    writeFx(
      join(home, ".config", "sing-box", "singbox.json"),
      JSON.stringify({ log: { output: join(home, "no-such.log") } }),
    );
    const rec = await runCli("logs 文件缺失", ["logs", "-n", "5"], { home });
    expect(rec.exit).toBe(1);
    expect(rec.stderr).toContain("读取");
    expect(rec.stderr).toContain("no-such.log");
  });

  test("log 文件含非法 UTF-8 字节报读取错误", async () => {
    const home = makeHome("logs-bad-utf8");
    const logPath = writeFx(join(home, "bad.log"), new Uint8Array([0xff, 0xfe, 0x62, 0x61, 0x64]));
    writeFx(join(home, ".config", "sing-box", "singbox.json"), JSON.stringify({ log: { output: logPath } }));
    const rec = await runCli("logs 非 UTF-8 文件", ["logs", "-n", "5"], { home });
    expect(rec.exit).toBe(1);
    expect(rec.stderr).toContain("读取");
    expect(rec.stderr).toContain("UTF-8");
  });

  test.each([
    ["--level 非白名单", ["logs", "-n", "1", "--level", "verbose"], "仅支持 debug|info|warn|error"],
    ["-n 非数字", ["logs", "-n", "abc"], "-n 非法行数"],
    ["-n 缺值", ["logs", "-n"], "-n 需要一个行数"],
    ["--level 缺值", ["logs", "--level"], "--level 需要一个级别"],
    ["未知 flag", ["logs", "-x"], "未知参数 -x"],
  ])("参数校验: %s", async (label, args, expected) => {
    const rec = await runCli(`logs ${label}`, args, { home: makeHome("logs-flag") });
    expect(rec.exit).toBe(1);
    expect(rec.stderr).toContain(expected);
  });

  test("裸 logs（无 -n）：退化为 -f 跟踪，controller 缺省口离线报错", async () => {
    const home = makeHome("logs-bare-follow");
    setupLegacy(home, 2);
    const rec = await runCli("logs 裸调用退化为 -f", ["logs"], { home });
    expect(rec.exit).toBe(1);
    expect(rec.stdout).not.toContain("log.output"); // 未走文件 tail 分支
    expect(rec.stderr).toContain("127.0.0.1:9090 不可达");
  });

  test("logs -f：controller 不可达立即报错，不挂起", async () => {
    const home = makeHome("logs-f-unreachable");
    setupLegacy(home, 1);
    const rec = await runCli("logs -f controller 离线", ["logs", "-f"], { home });
    expect(rec.exit).toBe(1);
    expect(rec.stderr).toContain("127.0.0.1:9090 不可达");
    expect(rec.stderr).toContain("clash api");
  });

  test("配置存在但无 log.output：-n 显式回看缺文件必须报错，不擅自转跟踪", async () => {
    const home = makeHome("logs-no-output-degrade");
    writeFx(join(home, ".config", "sing-box", "config.yaml"), "memo: no-log-here\n");
    const rec = await runCli("logs 无 log.output 报错", ["logs", "-n", "5"], { home });
    expect(rec.exit).toBe(1);
    expect(rec.stderr).toContain("未配置 log.output");
    expect(rec.stderr).toContain("显式 -f");
  });
});

// ---------------------------------------------------------------------------
// trace：全部为拒绝路径（正向探测需要真机内核，不在离线范围）
// ---------------------------------------------------------------------------

describe("trace", () => {
  test("无 domain 报用法错误", async () => {
    const rec = await runCli("trace 无 domain", ["trace"], { home: makeHome("trace-noargs") });
    expect(rec.exit).toBe(1);
    expect(rec.stderr).toContain("trace 用法");
  });

  test("--api 缺值报错", async () => {
    const rec = await runCli("trace --api 缺值", ["trace", "example.test", "--api"], {
      home: makeHome("trace-api-missing"),
    });
    expect(rec.exit).toBe(1);
    expect(rec.stderr).toContain("--api 需要一个地址");
  });

  test("未知 flag 报错", async () => {
    const rec = await runCli("trace 未知 flag", ["trace", "example.test", "--bogus"], {
      home: makeHome("trace-unknown-flag"),
    });
    expect(rec.exit).toBe(1);
    expect(rec.stderr).toContain("未知参数 --bogus");
  });

  test("CLI --api 非回环：显式拒绝连接", async () => {
    const rec = await runCli("trace CLI 非回环", ["trace", "example.test", "--api", "192.0.2.5:9090"], {
      home: makeHome("trace-cli-nonloopback"),
    });
    expect(rec.exit).toBe(1);
    expect(rec.stderr).toContain("非回环地址");
    expect(rec.stderr).toContain("192.0.2.5:9090");
  });

  test("顶层配置非回环 controller：拒绝且不回退缺省口", async () => {
    const home = makeHome("trace-top-nonloopback");
    writeFx(
      join(home, ".config", "sing-box", "singbox.json"),
      JSON.stringify({ experimental: { clash_api: { external_controller: "192.0.2.5:19090" } } }),
    );
    const rec = await runCli("trace top 非回环", ["trace", "example.test"], { home });
    expect(rec.exit).toBe(1);
    expect(rec.stderr).toContain("非回环地址");
    expect(rec.stderr).toContain("192.0.2.5:19090");
  });

  test("overlay 配置非回环 controller：同样拒绝", async () => {
    const home = makeHome("trace-overlay-nonloopback");
    writeFx(
      join(home, ".config", "sing-box", "config.yaml"),
      clientYaml('{"experimental":{"clash_api":{"external_controller":"127.0.0.2:19090"}}}'),
    );
    const rec = await runCli("trace overlay 非回环", ["trace", "example.test"], { home });
    expect(rec.exit).toBe(1);
    expect(rec.stderr).toContain("非回环地址");
    expect(rec.stderr).toContain("127.0.0.2:19090");
  });
});
