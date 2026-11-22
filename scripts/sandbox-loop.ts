/**
 * 沙箱闭环引导（宿主机侧，由 `just sandbox-loop` / `just test-sandbox` 调用）。
 *
 * 在隔离网络命名空间的临时容器内：本地容器编译当前工作区 Linux 版 `sbtools`
 * → 拷入容器 → 起服务端 → 经 encode + /sub 取回实际响应的配置 → 本地化规则集
 * 后交给内核驱动验证。配置来源是服务端产物，不再是等价实现（ADR-0003）。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { localizeRuleSets, planRuleSets, stageRuleSets, verifyLocalArtifacts } from "./rule-set-local.ts";
import {
  REPO_ROOT,
  SANDBOX_WORK,
  SandboxContainer,
  buildLinuxSbtools,
  withSandbox,
} from "./sandbox.ts";

const PORT = 18080;
const SB = "sing-box";

const ARTIFACT_DIR = resolve(REPO_ROOT, ".sandbox-artifacts");
const LOCAL_BINARY = resolve(ARTIFACT_DIR, "sbtools");
const GUEST_BINARY = "/work/sbtools";
const WORK = SANDBOX_WORK;
const STAGING = resolve(ARTIFACT_DIR, "sandbox-rules");

function fail(stage: string, detail: string): never {
  throw new Error(`[沙箱引导] ${stage} 失败：${detail}`);
}

/**
 * 清理本工具自己管理的产物，不碰 .sandbox-artifacts 下的审查/验证/复现证据
 * （postmortem 012：证据必须持久）。
 */
export function cleanOwnedArtifacts(dir = ARTIFACT_DIR): void {
  for (const name of [
    basename(LOCAL_BINARY),
    "sbtools-aarch64-unknown-linux-musl",
    "commit",
    basename(STAGING),
  ]) {
    rmSync(join(dir, name), { recursive: true, force: true });
  }
  mkdirSync(dir, { recursive: true });
}

function pushToGuest(box: SandboxContainer): void {
  const prep = box.exec(
    `set -e; mkdir -p ${WORK}/rules ${WORK}/external`,
  );
  if (prep.code !== 0) fail("初始化容器工作目录", prep.err.trim());

  box.cpTo(LOCAL_BINARY, GUEST_BINARY);

  const sync = box.exec(`
    set -e
    chmod +x ${GUEST_BINARY}
    cp -r /repo/config/rules/generated/singbox/. ${WORK}/rules/
  `);
  if (sync.code !== 0) fail("同步文件到容器", sync.err.trim());

  const ver = box.exec(`${GUEST_BINARY} version`);
  if (ver.code !== 0) fail("执行容器内二进制", ver.err.trim());
  console.log(`[引导] 容器内 sbtools: ${ver.out.trim()}`);
}

function pushRuleSetsToGuest(box: SandboxContainer): void {
  const extDir = join(STAGING, "external");
  if (existsSync(extDir)) {
    box.cpTo(extDir, `${WORK}/external`);
  }
  box.cpTo(join(STAGING, "rules-map.json"), `${WORK}/rules-map.json`);
}

/** 在容器内启动服务端并等待就绪；私钥只在容器内存活。 */
function startServer(box: SandboxContainer): void {
  const r = box.exec(`
    set -e
    SK=$(${GUEST_BINARY} keygen | sed -n 's/^SERVER_PRIVATE_KEY=//p')
    [ -n "$SK" ] || { echo "keygen 未产出私钥" >&2; exit 1; }

    env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u all_proxy \\
      SING_BOX=${SB} SERVER_PRIVATE_KEY="$SK" \\
      nohup ${GUEST_BINARY} server --port ${PORT} > /work/sbtools-server.log 2>&1 &
    for _ in $(seq 1 40); do
      curl -sS --noproxy '*' -o /dev/null "http://127.0.0.1:${PORT}/healthz" && exit 0
      sleep 0.2
    done
    echo "服务端未就绪"; cat /work/sbtools-server.log; exit 1
  `);
  if (r.code !== 0) fail("启动服务端", (r.err + r.out).trim());
}

export interface LoopOptions {
  subs?: string[];
  nodes?: string[];
  overlay?: Record<string, unknown>;
}

const DEFAULT_NODES = [
  "hy2://pass@192.0.2.1:8388?sni=example.com#selfhost-jp",
  "hy2://pass@192.0.2.2:8388?sni=example.com#selfhost-hk",
];

const REAL_CONFIG = join(process.env.HOME ?? "", ".config/sing-box/config.yaml");

export function extractRealInput(
  raw: string,
): { nodes: string[]; subs: string[] } {
  const parsed = Bun.YAML.parse(raw) as Record<string, unknown> | null;
  const pick = (key: string): string[] => {
    const list = parsed?.[key];
    return Array.isArray(list)
      ? list.filter((v): v is string => typeof v === "string")
      : [];
  };
  return { nodes: pick("nodes"), subs: pick("subs") };
}

function loadRealInput(): { nodes: string[]; subs: string[] } | null {
  if (!existsSync(REAL_CONFIG)) return null;
  try {
    const input = extractRealInput(readFileSync(REAL_CONFIG, "utf8"));
    return input.nodes.length + input.subs.length > 0 ? input : null;
  } catch {
    return null;
  }
}

function fetchRawConfig(
  box: SandboxContainer,
  options: LoopOptions,
): { route?: { rule_set?: Array<Record<string, unknown>> } } {
  const real = options.nodes || options.subs ? null : loadRealInput();
  const nodes = options.nodes ?? real?.nodes ?? DEFAULT_NODES;
  const subs = options.subs ?? real?.subs ?? [];
  if (real) {
    console.log(
      `[引导] 真实数据源 ${REAL_CONFIG}：nodes=${nodes.length} subs=${subs.length}（凭据不入日志）`,
    );
  } else if (!options.nodes && !options.subs) {
    console.warn(
      `[引导] WARN：${REAL_CONFIG} 不存在或无 nodes/subs，退回合成夹具节点，仅验证链路，不代表真实出口`,
    );
  }
  if (nodes.length === 0 && subs.length === 0) {
    fail("构造客户端输入", "nodes 与 subs 不能同时为空");
  }

  const overlay = { log: { level: "debug" }, ...options.overlay };
  const yaml = [
    ...(subs.length > 0 ? ["subs:", ...subs.map((s) => `  - "${s}"`)] : []),
    ...(nodes.length > 0 ? ["nodes:", ...nodes.map((n) => `  - "${n}"`)] : []),
    "overlay: |",
    `  ${JSON.stringify(overlay)}`,
    "",
  ].join("\n");

  // 凭据只经 stdin 进隔离容器，不落宿主磁盘；容器退出即销毁
  const r = box.exec(
    `
    set -e
    umask 077
    trap 'rm -f ${WORK}/client.yaml' EXIT
    cat > ${WORK}/client.yaml

    URL=$(${GUEST_BINARY} encode -s http://127.0.0.1:${PORT} \\
      -c ${WORK}/client.yaml 2>/dev/null | grep '^http')
    [ -n "$URL" ] || { echo "encode 未产出 URL" >&2; exit 1; }
    curl -sS --noproxy '*' "$URL" -o ${WORK}/raw.json
    cat ${WORK}/raw.json
    pkill -9 -x sbtools 2>/dev/null || true
  `,
    yaml,
  );
  if (r.code !== 0) fail("取回服务端配置", (r.err + r.out).trim());
  try {
    return JSON.parse(r.out);
  } catch (e) {
    fail("解析服务端配置", e instanceof Error ? e.message : String(e));
  }
}

function finalizeConfig(
  box: SandboxContainer,
  raw: unknown,
  map: Record<string, string>,
): void {
  let localized: unknown;
  try {
    localized = localizeRuleSets(raw, map);
  } catch (e) {
    fail("本地化规则集", e instanceof Error ? e.message : String(e));
  }
  const put = box.exec(`cat > ${WORK}/config.json`, JSON.stringify(localized, null, 2));
  if (put.code !== 0) fail("写入容器配置", put.err.trim());
  const chk = box.exec(`${SB} check -D ${WORK} -c ${WORK}/config.json`);
  if (chk.code !== 0) fail("校验配置", (chk.err + chk.out).trim());
  console.log(`[引导] 闭环就绪：${WORK}/config.json`);
}

export function bootstrap(box: SandboxContainer, options: LoopOptions = {}): void {
  verifyLocalArtifacts(
    planRuleSets(
      JSON.parse(readFileSync(resolve(REPO_ROOT, "config/sing-box/template.json"), "utf8")),
    ),
  );
  cleanOwnedArtifacts();
  buildLinuxSbtools(LOCAL_BINARY);
  pushToGuest(box);
  startServer(box);

  const raw = fetchRawConfig(box, options);
  const plan = planRuleSets(raw);
  verifyLocalArtifacts(plan);
  const map = stageRuleSets(plan, STAGING, WORK);
  pushRuleSetsToGuest(box);
  finalizeConfig(box, raw, map);
}

if (import.meta.main) {
  const runIdx = process.argv.indexOf("--run");
  const cmd = runIdx >= 0 ? process.argv[runIdx + 1] : undefined;
  await withSandbox(async (box) => {
    bootstrap(box);
    if (cmd) {
      const code = box.execInherit(["sh", "-c", cmd]);
      if (code !== 0) process.exitCode = code;
    }
  });
}
