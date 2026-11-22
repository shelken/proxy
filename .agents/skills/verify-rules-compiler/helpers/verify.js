#!/usr/bin/env bun
/**
 * verify-rules-compiler 入口（宿主侧）。
 *
 * 验证规则编译管道：
 *   - 外部镜像：geosite:x / geoip:x → 直接镜像 meta-rules-dat 三端原生资产
 *   - 内部 AST：custom/*.yaml → parseYamlAst → 三端产物
 *
 * 编译在宿主完成（联网拉上游清单），内核行为断言在隔离沙箱容器内完成。
 *
 * 用法：
 *   RUN=".sandbox-artifacts/verification/$(date -u +%Y%m%dT%H%M%SZ)"
 *   bun --no-env-file .agents/skills/verify-rules-compiler/helpers/verify.js launch  --out "$RUN"
 *   bun --no-env-file .agents/skills/verify-rules-compiler/helpers/verify.js doctor  --out "$RUN"
 *   bun --no-env-file .agents/skills/verify-rules-compiler/helpers/verify.js drive   --out "$RUN"
 *   bun --no-env-file .agents/skills/verify-rules-compiler/helpers/verify.js cleanup --out "$RUN"
 *   bun --no-env-file .agents/skills/verify-rules-compiler/helpers/verify.js all
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { localizeRuleSets, planRuleSets, stageRuleSets } from "../../../../scripts/rule-set-local.ts";
import { ensureSandboxImage, withSandbox } from "../../../../scripts/sandbox.ts";

const REPO = resolve(import.meta.dir, "../../../..");
const ARTIFACTS_ROOT = join(REPO, ".sandbox-artifacts/verification");
const GENERATED = join(REPO, "config/rules/generated");
const GUEST_REPO = "/repo";
const GUEST_SB = "sing-box";

const SUFFIX = { singbox: ".srs", clash: ".yaml", plain: ".list" };

const PROBES = [
  {
    tag: "Adult",
    kind: "内部 AST（logical 树 + domain 类字段）",
    assert: (j) => j.rules.filter((r) => r.type === "logical").length === 3,
  },
  {
    tag: "Hijacking",
    kind: "内部 AST（no-resolve 应在 sing-box 端剥离）",
    assert: (j) => j.rules.some((r) => Array.isArray(r.ip_cidr) && r.ip_cidr.every((v) => !v.includes("no-resolve"))),
  },
  {
    tag: "geoip-cn",
    kind: "外部镜像（meta-rules-dat geoip）",
    assert: (j) => j.rules.length === 1 && Array.isArray(j.rules[0].ip_cidr) && j.rules[0].ip_cidr.length > 1000,
  },
];

function log(...a) {
  console.log(...a);
}
function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function host(cmd, args, opts = {}) {
  const p = spawnSync(cmd, args, { encoding: "utf8", cwd: REPO, ...opts });
  return { code: p.status ?? 1, out: p.stdout ?? "", err: p.stderr ?? "" };
}

const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

function walk(dir, base = dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full, base));
    else out.push(relative(base, full));
  }
  return out;
}

// ---------------------------------------------------------------- launch

export function launch(outDir) {
  mkdirSync(outDir, { recursive: true });
  log("[launch] 构建全部规则产物（联网拉上游清单 + sing-box rule-set compile）…");
  const build = host("bun", ["scripts/rules-compile.ts", "build", "--all"]);
  writeFileSync(join(outDir, "build.log"), build.out + build.err);
  if (build.code !== 0) fail(`[launch] 构建失败，见 ${join(outDir, "build.log")}`);
  const built = /done: built=(\d+)/.exec(build.out);
  if (!built) fail("[launch] 构建输出未包含 done: built=N");

  const files = walk(GENERATED).sort().map((f) => ({
    path: f,
    size: statSync(join(GENERATED, f)).size,
    sha256: sha256(join(GENERATED, f)),
  }));
  const manifest = {
    phase: "ready",
    commit: host("git", ["rev-parse", "HEAD"]).out.trim(),
    dirty: host("git", ["status", "--porcelain"]).out.trim(),
    settingsSha: sha256(join(REPO, "config/sing-box/settings.yaml")),
    templateSha: sha256(join(REPO, "config/sing-box/template.json")),
    builtTags: Number(built[1]),
    generatedAt: new Date().toISOString(),
    fileCount: files.length,
    files,
  };
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  log(`[launch] built=${manifest.builtTags} tags，${files.length} 个产物写入 ${outDir}/manifest.json`);
}

// ---------------------------------------------------------------- doctor

export function doctor(outDir) {
  const problems = [];
  const mp = join(outDir, "manifest.json");
  if (!existsSync(mp)) {
    problems.push("manifest.json 缺失：先跑 launch");
  } else {
    const m = JSON.parse(readFileSync(mp, "utf8"));
    if (m.phase !== "ready") problems.push(`manifest.phase=${m.phase}`);
    const head = host("git", ["rev-parse", "HEAD"]).out.trim();
    if (head !== m.commit) problems.push(`源码已漂移：manifest=${m.commit.slice(0, 8)} HEAD=${head.slice(0, 8)}，重新 launch`);
    for (const f of m.files) {
      const abs = join(GENERATED, f.path);
      if (!existsSync(abs)) problems.push(`产物缺失：${f.path}`);
      else if (sha256(abs) !== f.sha256) problems.push(`产物被改动：${f.path}`);
    }
  }

  const check = host("bun", ["scripts/build-config.ts", "--check"]);
  if (check.code !== 0) problems.push(`底模与 settings/shared/platforms 不一致：\n${check.out}${check.err}`);

  try {
    ensureSandboxImage();
  } catch (e) {
    problems.push(`沙箱容器不可用：${String(e)}`);
  }

  writeFileSync(join(outDir, "doctor.log"), problems.join("\n") || "OK\n");
  log(problems.length ? "[doctor] 问题：\n" + problems.map((p) => "  - " + p).join("\n") : "[doctor] 通过");
  return problems.length === 0;
}

// ---------------------------------------------------------------- drive

export function driveArtifacts(box, outDir) {
  const results = [];
  const add = (id, ok, detail) => {
    results.push({ id, ok, detail });
    log(`${ok ? "PASS" : "FAIL"}  ${id}  ${detail}`);
  };

  for (const p of PROBES) {
    for (const client of ["singbox", "clash", "plain"]) {
      const abs = join(GENERATED, client, p.tag + SUFFIX[client]);
      const ok = existsSync(abs) && statSync(abs).size > 0;
      add(`D1/${client}/${p.tag}`, ok, ok ? `${statSync(abs).size}B` : "缺失或为空");
      if (client === "clash" && ok) {
        add(`D1/clash-shape/${p.tag}`, readFileSync(abs, "utf8").startsWith("payload:"), "payload: 开头");
      }
    }
  }

  const decomp = join(outDir, "decompiled");
  mkdirSync(decomp, { recursive: true });
  for (const p of PROBES) {
    const r = box.exec(
      `${GUEST_SB} rule-set decompile ${GUEST_REPO}/config/rules/generated/singbox/${p.tag}.srs -o /tmp/vrc-${p.tag}.json && cat /tmp/vrc-${p.tag}.json`,
    );
    if (r.code !== 0) {
      add(`D2/${p.tag}`, false, `decompile 失败：${r.err.trim().slice(0, 160)}`);
      continue;
    }
    writeFileSync(join(decomp, `${p.tag}.json`), r.out);
    const json = JSON.parse(r.out);
    add(`D2/${p.tag}`, p.assert(json), `${p.kind}；rules=${json.rules.length}`);
  }
  return results;
}

export function driveKernel(box, outDir) {
  const ruleSet = (tag) =>
    `{ "type": "local", "tag": "${tag}", "format": "binary", "path": "${GUEST_REPO}/config/rules/generated/singbox/${tag}.srs" }`;
  const cfg = {
    log: { level: "debug" },
    inbounds: [{ type: "mixed", tag: "in", listen: "127.0.0.1", listen_port: 18181 }],
    outbounds: [{ type: "direct", tag: "direct" }, { type: "block", tag: "block" }],
    route: {
      rule_set: [JSON.parse(ruleSet("Adult")), JSON.parse(ruleSet("geoip-cn"))],
      rules: [
        { action: "sniff" },
        { rule_set: "Adult", action: "route", outbound: "block" },
        { rule_set: "geoip-cn", action: "route", outbound: "direct" },
      ],
      final: "direct",
    },
  };
  const script = `
D=/work/rule-verify; rm -rf $D; mkdir -p $D
cat > $D/config.json <<'JSON'
${JSON.stringify(cfg, null, 2)}
JSON
${GUEST_SB} check -D $D -c $D/config.json || { echo "CHECK_FAILED"; exit 1; }
echo "CHECK_OK"
${GUEST_SB} run -D $D -c $D/config.json > $D/sb.log 2>&1 &
PID=$!
for i in $(seq 1 60); do grep -q "sing-box started" $D/sb.log && break; sleep 0.2; done
grep -q "sing-box started" $D/sb.log && echo "READY" || { echo "NOT_READY"; tail -8 $D/sb.log; }
echo "--- 命中路径：javdb.com 属于 Adult（domain_suffix）---"
curl -s -m 6 --proxy http://127.0.0.1:18181 https://javdb.com/ -o /dev/null -w "HIT_HTTP=%{http_code}\\n"; echo "HIT_EXIT=$?"
echo "--- 未命中路径：example.com 应走 final=direct ---"
curl -s -m 6 --proxy http://127.0.0.1:18181 https://example.com/ -o /dev/null -w "MISS_HTTP=%{http_code}\\n"; echo "MISS_EXIT=$?"
echo "--- 内核裁决日志 ---"
grep -oE "match\\[[0-9]+\\] rule_set=[A-Za-z0-9_-]+" $D/sb.log | head -6
kill $PID 2>/dev/null || true
wait $PID 2>/dev/null || true
`;
  const r = box.exec(script);
  writeFileSync(join(outDir, "kernel.log"), r.out + r.err);

  const results = [];
  const add = (id, ok, detail) => {
    results.push({ id, ok, detail });
    log(`${ok ? "PASS" : "FAIL"}  ${id}  ${detail}`);
  };
  const o = r.out;
  add("D3/check", /CHECK_OK/.test(o), "配置 + 规则集通过 sing-box check");
  add("D3/ready", /READY/.test(o), "sing-box 启动就绪");
  add("D3/hit", /match\[\d+\] rule_set=Adult/.test(o) && /HIT_EXIT=(?!0)\d+/.test(o), "javdb.com 命中 rule_set=Adult 并被 block");
  add("D3/miss", /MISS_HTTP=200/.test(o), "example.com 未命中规则集，走 final=direct");
  return results;
}

export function driveXiaomi(box, outDir) {
  const results = [];
  const add = (id, ok, detail) => {
    results.push({ id, ok, detail });
    log(`${ok ? "PASS" : "FAIL"}  ${id}  ${detail}`);
  };
  const url = "https://cdn.jsdelivr.net/gh/razaxq/dns-blocklists-sing-box@rule-set/hagezi-tracker-xiaomi.srs";
  const template = {
    route: { rule_set: [{ type: "remote", tag: "小米追踪", format: "binary", url, update_interval: "1d" }] },
  };
  const staging = join(resolve(outDir), "xiaomi-staging");
  let map;
  try {
    map = stageRuleSets(planRuleSets(template), staging, "/work/xiaomi-staging");
  } catch (e) {
    add("D5/stage", false, String(e));
    return results;
  }
  const srs = join(staging, "external/0.srs");
  add("D5/stage", existsSync(srs) && statSync(srs).size > 0, `经 plan+staging 得到 ${existsSync(srs) ? statSync(srs).size : 0}B`);
  box.cpTo(staging, "/work/xiaomi-staging");

  const cfg = localizeRuleSets(
    {
      log: { level: "debug" },
      inbounds: [{ type: "mixed", tag: "in", listen: "127.0.0.1", listen_port: 18182 }],
      outbounds: [{ type: "direct", tag: "direct" }, { type: "block", tag: "block" }],
      route: {
        rule_set: template.route.rule_set,
        rules: [{ action: "sniff" }, { rule_set: "小米追踪", action: "route", outbound: "block" }],
        final: "direct",
      },
    },
    map,
  );
  const script = `
D=/work/rule-verify-xiaomi; rm -rf $D; mkdir -p $D
cat > $D/config.json <<'JSON'
${JSON.stringify(cfg, null, 2)}
JSON
${GUEST_SB} check -D $D -c $D/config.json || { echo CHECK_FAILED; exit 1; }
echo CHECK_OK
${GUEST_SB} run -D $D -c $D/config.json > $D/sb.log 2>&1 &
PID=$!
for i in $(seq 1 60); do grep -q "sing-box started" $D/sb.log && break; sleep 0.2; done
grep -q "sing-box started" $D/sb.log && echo READY || { echo NOT_READY; tail -8 $D/sb.log; }
curl -s -m 6 --proxy http://127.0.0.1:18182 https://api.xmpush.xiaomi.com/ -o /dev/null -w "HIT_HTTP=%{http_code}\\n"; echo HIT_EXIT=$?
grep -oE "match\\[[0-9]+\\] rule_set=[^ ]+" $D/sb.log | head -4
kill $PID 2>/dev/null || true
wait $PID 2>/dev/null || true
`;
  const r = box.exec(script);
  writeFileSync(join(outDir, "xiaomi-kernel.log"), r.out + r.err);
  add("D5/check", /CHECK_OK/.test(r.out), "经准备链本地化的配置通过 sing-box check");
  add("D5/hit", /match\[\d+\] rule_set=小米追踪/.test(r.out), "api.xmpush.xiaomi.com 命中小米规则集");
  return results;
}

export function driveDns(box, outDir) {
  const results = [];
  const add = (id, ok, detail) => {
    results.push({ id, ok, detail });
    log(`${ok ? "PASS" : "FAIL"}  ${id}  ${detail}`);
  };
  const srs = (tag) => join(GENERATED, "singbox", `${tag}-dns.srs`);
  const dnsJson = (tag) => join(GENERATED, "singbox", `${tag}-dns.json`);
  const main = (tag) => join(GENERATED, "singbox", `${tag}.srs`);

  add("D4/internal", existsSync(srs("Lan")) && statSync(srs("Lan")).size > 0, "internal 产出 Lan-dns.srs");
  add("D4/internal-json", existsSync(dnsJson("Lan")), "internal 先发射域名版 JSON 再编译");
  add("D4/geosite", existsSync(srs("ChinaMax")) && statSync(srs("ChinaMax")).size > 0, "geosite 产出 ChinaMax-dns.srs");
  add("D4/geosite-reuse", sha256(main("ChinaMax")) === sha256(srs("ChinaMax")), "geosite 伴生与主产物字节相同（复用上游，不重编译）");
  add("D4/geosite-no-json", !existsSync(dnsJson("ChinaMax")), "geosite 无中间 JSON");
  add("D4/geoip-skip", !existsSync(srs("geoip-cn")), "geoip 不产伴生（IP 集合无 DNS 判定语义）");

  const DNS_KEYS = new Set(["type", "mode", "rules", "invert", "domain", "domain_suffix", "domain_keyword"]);
  const foreignKeys = (node) => {
    const bad = [];
    const visit = (n) => {
      for (const [k, v] of Object.entries(n)) {
        if (Array.isArray(v)) {
          if (k === "rules") v.forEach((x) => x && typeof x === "object" && visit(x));
          else if (!DNS_KEYS.has(k)) bad.push(k);
        } else if (v && typeof v === "object") visit(v);
        else if (!DNS_KEYS.has(k)) bad.push(k);
      }
    };
    visit(node);
    return bad;
  };

  const decomp = join(outDir, "decompiled");
  mkdirSync(decomp, { recursive: true });
  for (const tag of ["Lan-dns", "Lan"]) {
    const r = box.exec(`${GUEST_SB} rule-set decompile ${GUEST_REPO}/config/rules/generated/singbox/${tag}.srs -o /tmp/vrc-${tag}.json && cat /tmp/vrc-${tag}.json`);
    if (r.code !== 0) {
      add(`D4/${tag}`, false, `decompile 失败：${r.err.trim().slice(0, 160)}`);
      continue;
    }
    writeFileSync(join(decomp, `${tag}.json`), r.out);
    const j = JSON.parse(r.out);
    const bad = [...new Set(j.rules.flatMap(foreignKeys))];
    if (tag === "Lan-dns") add("D4/dns-only-fields", bad.length === 0, bad.length ? `域名版混入非域名字段：${bad.join(",")}` : "域名版仅含 domain 类字段");
    else add("D4/filter-control", bad.includes("ip_cidr"), "对照组：Lan 主产物确含 ip_cidr");
  }
  return results;
}

export async function drive(outDir) {
  const results = await withSandbox((box) => [
    ...driveArtifacts(box, outDir),
    ...driveDns(box, outDir),
    ...driveKernel(box, outDir),
    ...driveXiaomi(box, outDir),
  ], "vrc-sandbox");
  writeFileSync(join(outDir, "results.json"), JSON.stringify({ results }, null, 2));
  const failed = results.filter((r) => !r.ok);
  log(`[drive] ${results.length - failed.length}/${results.length} 通过`);
  return failed.length === 0;
}

// ---------------------------------------------------------------- cleanup

export function cleanup(outDir) {
  rmSync(join(resolve(outDir), "xiaomi-staging"), { recursive: true, force: true });
  log("[cleanup] 临时 staging 已清除，证据保留");
}

// ---------------------------------------------------------------- CLI

const [cmd, ...args] = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const defaultRun = join(ARTIFACTS_ROOT, new Date().toISOString().replace(/[:.]/g, "").slice(0, 15) + "Z");
const outDir = outIdx >= 0 ? resolve(args[outIdx + 1]) : defaultRun;

switch (cmd) {
  case "launch":
    launch(outDir);
    break;
  case "doctor":
    process.exit(doctor(outDir) ? 0 : 1);
  case "drive":
    process.exit((await drive(outDir)) ? 0 : 1);
  case "cleanup":
    cleanup(outDir);
    break;
  case "all": {
    launch(outDir);
    if (!doctor(outDir)) fail("[all] doctor 未通过");
    const ok = await drive(outDir);
    cleanup(outDir);
    process.exit(ok ? 0 : 1);
  }
  default:
    fail("用法：verify.js <launch|doctor|drive|cleanup|all> [--out DIR]");
}
