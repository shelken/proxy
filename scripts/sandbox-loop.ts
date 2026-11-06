/**
 * 沙箱闭环引导（宿主机侧，由 `just sandbox-loop` 调用）。
 *
 * 取当前 HEAD 对应的 CI 产物 → 拷入 VM → VM 内起服务端 → 经 encode + /sub 取回
 * 它实际响应的配置 → 后处理为可驱动内核的形式。
 *
 * 引导必须跑在宿主机：`gh`（拉产物）与 `limactl`（驱动 VM）都只存在于这里。
 * 测试文件在 VM 内运行，只做断言，不参与引导。
 *
 * 二进制来自 CI 而非本地编译：本地工具链混用（nix cargo 与 rustup rustc 版本不一致）
 * 会触发 E0514，且构建产物不应污染工作区。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { RULES_URL } from "./settings.ts";

const VM = "proxy-test";
const ARTIFACT = "sbtools-aarch64-unknown-linux-musl";
const PORT = 18080;
const SB = "/opt/proxy-test/bin/sing-box";

const ARTIFACT_DIR = resolve(import.meta.dir, "../.sandbox-artifacts");
const LOCAL_BINARY = resolve(ARTIFACT_DIR, "sbtools");
const GUEST_BINARY = "/work/sbtools";
const WORK = "/work/sing-box";
const STAGING = resolve(ARTIFACT_DIR, "sandbox-rules");
const REPO_IN_GUEST = resolve(import.meta.dir, "..").replace(
  process.env.HOME ?? "",
  "/host-home",
);

interface ShellResult {
  code: number | null;
  out: string;
  err: string;
}

function host(cmd: string[]): ShellResult {
  const p = Bun.spawnSync(cmd);
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

/** 在 VM 内执行命令；给了 stdin 就同时写入其标准输入。 */
function guest(cmd: string, stdin?: string): ShellResult {
  const p = Bun.spawnSync(
    ["limactl", "shell", "--workdir", "/work", VM, "sh", "-c", cmd],
    stdin === undefined ? {} : { stdin: Buffer.from(stdin) },
  );
  return {
    code: p.exitCode,
    out: p.stdout.toString(),
    err: p.stderr.toString(),
  };
}

function fail(stage: string, detail: string): never {
  throw new Error(`[沙箱引导] ${stage} 失败：${detail}`);
}

/**
 * 取与当前代码等价的一份 CI 产物。
 *
 * 二进制只由 `BINARY_INPUTS` 列出那几处决定（底模经 include_str! 内嵌）。所以判据
 * 不是「commit 相等」，而是「这些路径与产物构建时一致」——纯删除/文档提交的 HEAD
 * 不会触发 release 工作流，此时回退到最近一次带产物的构建是安全的，且必须把实际
 * 使用的 commit 打出来。
 *
 * 候选来自 artifacts API 而非 run 列表：`mode=skip` 的 run（该版本已发布）同样
 * `conclusion=success` 且 `headSha=HEAD`，但构建 job 全被跳过、零产物，一旦进入
 * 候选就会在下载阶段失败。按「有可下载产物」筛，这类 run 天然不在池子里。
 *
 * 一旦这些路径确有差异就直接报错：那种情况下的产物与被测代码不对应，
 * 静默使用会产生最难排查的假绿。
 */
/**
 * 清理本工具自己管理的产物，不碰 .sandbox-artifacts 下的审查/验证/复现证据
 * （postmortem 012：证据必须持久）。
 */
export function cleanOwnedArtifacts(dir = ARTIFACT_DIR): void {
  for (const name of [basename(LOCAL_BINARY), ARTIFACT, "commit", basename(STAGING)]) {
    rmSync(join(dir, name), { recursive: true, force: true });
  }
  mkdirSync(dir, { recursive: true });
}

function ensureBinary(): void {
  const head = host(["git", "rev-parse", "HEAD"]).out.trim();
  if (!head) fail("解析 HEAD", "git rev-parse HEAD 无输出");

  // CI 产物不包含工作区改动，必须在复用缓存前核对构建输入。
  const status = host(["git", "status", "--porcelain", "--", ...BINARY_INPUTS]);
  if (status.code !== 0) fail("检查二进制输入", status.err.trim());
  const dirty = status.out.trim();
  if (dirty) {
    fail(
      "二进制输入未提交",
      `以下文件有未提交改动，不会体现在任何 CI 产物里（假绿风险）：\n` +
        `  ${dirty.replaceAll("\n", "\n  ")}\n` +
        `  先提交并推送分支，再执行 gh workflow run release-sbtools.yml --ref <分支> 并等它跑完`,
    );
  }

  const stamp = resolve(ARTIFACT_DIR, "commit");
  if (existsSync(LOCAL_BINARY) && existsSync(stamp)) {
    const cached = readFileSync(stamp, "utf-8").trim();
    if (cached === head || relevantDiff(cached, head) === "") {
      console.log(`[引导] 复用已下载产物 (${cached.slice(0, 8)})`);
      return;
    }
  }

  const branch = host(["git", "rev-parse", "--abbrev-ref", "HEAD"]).out.trim();
  const runs = listArtifactRuns();
  const pick = chooseArtifact(runs, head, relevantDiff);
  if (!pick) {
    const diff = runs[0] ? relevantDiff(runs[0].headSha, head) : "(无可用产物)";
    fail(
      "查找 CI 产物",
      `HEAD ${head.slice(0, 8)} 无对应产物，带产物的构建里也没有 Rust 源码/底模一致的。\n` +
        `  先执行 gh workflow run release-sbtools.yml --ref ${branch} 并等它跑完\n` +
        `  差异: ${diff}`,
    );
  }
  if (!pick.exact) {
    console.log(
      `[引导] 警告：产物来自 ${pick.chosen.headSha.slice(0, 8)}（HEAD ${head.slice(0, 8)} 无构建）；\n` +
        `         已确认 scripts/sbtools-rs/** 与 template.json 无差异，二进制等价`,
    );
  }
  const chosen = pick.chosen;

  cleanOwnedArtifacts();
  const got = host([
    "gh", "run", "download", String(chosen.databaseId), "-n", ARTIFACT, "-D", ARTIFACT_DIR,
  ]);
  if (got.code !== 0) fail("下载产物", got.err.trim());

  const downloaded = resolve(ARTIFACT_DIR, ARTIFACT);
  if (!existsSync(downloaded)) fail("校验下载结果", `预期文件不存在: ${downloaded}`);
  if (downloaded !== LOCAL_BINARY) host(["mv", downloaded, LOCAL_BINARY]);
  writeFileSync(stamp, chosen.headSha);
}

/** 一个带可下载产物的构建。 */
export interface ArtifactRun {
  databaseId: number;
  headSha: string;
}

/**
 * 从 artifacts API 的响应里取出「未过期」的构建记录。
 *
 * 响应形状缺字段说明 GitHub API 契约变了，硬失败而不是当成空列表——把契约破坏
 * 静默成「没有可用产物」会让排查绕远路。
 */
export function selectArtifactRuns(raw: string): ArtifactRun[] {
  const parsed = JSON.parse(raw) as {
    artifacts?: { expired?: boolean; workflow_run?: { id?: number; head_sha?: string } }[];
  };
  if (!Array.isArray(parsed.artifacts)) {
    fail("解析产物列表", `artifacts API 响应缺少 artifacts 数组: ${raw.slice(0, 200)}`);
  }
  return parsed.artifacts
    .filter((a) => a.expired === false)
    .map((a) => {
      const id = a.workflow_run?.id;
      const sha = a.workflow_run?.head_sha;
      if (typeof id !== "number" || typeof sha !== "string") {
        fail("解析产物列表", `产物记录缺少 workflow_run.id/head_sha: ${JSON.stringify(a)}`);
      }
      return { databaseId: id, headSha: sha };
    });
}

/**
 * 从候选里挑一个可用的：优先 headSha 精确相同，其次首个产物等价（`diffOf` 返回空串）。
 * 都不满足返回 null，由调用方报错。抽成纯函数以便不碰网络地覆盖选择逻辑。
 */
export function chooseArtifact(
  runs: ArtifactRun[],
  head: string,
  diffOf: (from: string, to: string) => string,
): { chosen: ArtifactRun; exact: boolean } | null {
  const exact = runs.find((r) => r.headSha === head);
  if (exact) return { chosen: exact, exact: true };
  const usable = runs.find((r) => diffOf(r.headSha, head) === "");
  return usable ? { chosen: usable, exact: false } : null;
}

/** 查询带可下载产物的构建记录（按创建时间倒序，新的在前）。 */
function listArtifactRuns(): ArtifactRun[] {
  const r = host([
    "gh", "api",
    `repos/{owner}/{repo}/actions/artifacts?name=${ARTIFACT}&per_page=100`,
  ]);
  if (r.code !== 0) fail("查询 CI 产物", r.err.trim());
  return selectArtifactRuns(r.out);
}

/**
 * 决定二进制内容的路径。判据不是「commit 相等」，而是「这些路径与产物构建时一致」。
 *
 * `release-sbtools.yml` 也在列：它决定 toolchain、target 与 cargo 构建参数——
 * 改动它同样会改变产物（版本本身不在此列，它由 Cargo.toml 决定，见上面的路径）。
 */
const BINARY_INPUTS = [
  "scripts/sbtools-rs/src",
  "scripts/sbtools-rs/Cargo.toml",
  "scripts/sbtools-rs/build.rs",
  "Cargo.toml",
  "Cargo.lock",
  "config/sing-box/template.json",
  // 底模由这些输入生成，改动它们必须重建内嵌底模的二进制
  "config/sing-box/settings.yaml",
  "config/sing-box/base.yaml",
  "config/sing-box/platforms",
  "scripts/build-config.ts",
  "scripts/settings.ts",
  ".github/workflows/release-sbtools.yml",
];

/** 两个 commit 之间，影响二进制内容的路径差异（空串表示产物等价）。 */
function relevantDiff(from: string, to: string): string {
  const r = host(["git", "diff", "--name-only", from, to, "--", ...BINARY_INPUTS]);
  // 退出码非零说明「能否等价」这个判断本身失效（commit 不存在、浅克隆取不到）。
  // 此时 stdout 为空，若当成「无差异」就会复用与被测代码不匹配的产物——
  // 正是本函数要防的那种假绿，所以必须硬失败而不是回退。
  if (r.code !== 0) {
    fail(
      "比较产物差异",
      `git diff ${from.slice(0, 8)}..${to.slice(0, 8)} 失败：${r.err.trim()}`,
    );
  }
  return r.out.trim();
}

interface RuleSetPlan {
  tag: string;
  url: string;
  external: boolean;
  /** 相对 WORK 的落位：仓库产物进 rules/，外部 .srs 进 external/ 且按序号唯一。 */
  path: string;
}

/** URL 路径的真实文件名：先解百分号编码再取 basename，中文/空格名不被编码破坏。 */
function urlBasename(url: string): string {
  return basename(decodeURIComponent(new URL(url).pathname));
}

const RELEASE = new URL(RULES_URL);

/**
 * 是否本仓库发布的直接产物：同 origin 且 path 的直接父目录就是发布目录。
 * 相邻目录（singbox-backup/）与嵌套子目录（singbox/nested/）都算外部来源，
 * 必须按用户 URL 原样下载，不能静默复用本地产物。
 */
export function isRepoArtifact(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.origin === RELEASE.origin && dirname(parsed.pathname) === RELEASE.pathname;
  } catch {
    return false;
  }
}

/**
 * 底模声明的远程规则集 → VM 内本地文件。
 *
 * 本仓库产物用 URL 路径里的真实产物名（兼容别名引用与中文名）；外部 .srs（如小米）
 * 不编译、不反编译，放进独立目录按序号命名，避免不同来源共享 basename 互相覆盖。
 */
export function planRuleSets(
  template: { route?: { rule_set?: Array<Record<string, unknown>> } } = JSON.parse(
    readFileSync(resolve(import.meta.dir, "../config/sing-box/template.json"), "utf-8"),
  ),
): RuleSetPlan[] {
  let next = 0;
  return (template.route?.rule_set ?? [])
    .filter((rs) => rs?.type === "remote" && typeof rs.url === "string")
    .map((rs) => {
      const url = rs.url as string;
      const external = !isRepoArtifact(url);
      return {
        tag: String(rs.tag),
        url,
        external,
        path: external ? `external/${next++}.srs` : `rules/${urlBasename(url)}`,
      };
    });
}

/**
 * 同步前确认本地规则产物齐备。
 *
 * `pushToGuest` 按 tag→本地文件映射拷贝规则集，缺哪个文件只有内核启动时才暴露成
 * `parse rule-set: open ...: no such file or directory`。这里当场核对仓库产物；
 * 外部 .srs 在 pushToGuest 时下载，不在预检里。
 */
function verifyLocalArtifacts(plan: RuleSetPlan[]): void {
  const genDir = resolve(import.meta.dir, "../config/rules/generated/singbox");
  const missing = plan.filter((p) => !p.external && !existsSync(join(genDir, basename(p.path))));
  if (missing.length > 0) {
    fail(
      "检查本地规则产物",
      `底模声明了 ${plan.length} 个远程规则集，本地 generated/singbox/ 缺 ${missing.length} 个：\n` +
        `  ${missing.map((p) => basename(p.path)).join(", ")}\n` +
        `  先执行 just rules-build 生成全量产物再引导`,
    );
  }
}

/** 下载外部 .srs 到宿主 staging，返回 tag→guest 内路径映射；仓库产物直接复用生成的 .srs。 */
export function stageRuleSets(
  plan: RuleSetPlan[],
  stagingDir = STAGING,
  guestDir = WORK,
): Record<string, string> {
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });
  const map: Record<string, string> = {};
  for (const item of plan) {
    if (item.external) {
      const dest = join(stagingDir, item.path);
      mkdirSync(dirname(dest), { recursive: true });
      const dl = Bun.spawnSync(["curl", "-fsSL", "--max-time", "60", item.url, "-o", dest]);
      if (dl.exitCode !== 0) fail("下载外部规则集", item.url);
    }
    map[item.tag] = `${guestDir}/${item.path}`;
  }
  writeFileSync(join(stagingDir, "rules-map.json"), JSON.stringify(map, null, 2));
  return map;
}

/** 把配置里的远程规则集按映射换成 VM 内本地文件，并去掉会联网的 clash_api。 */
export function localizeRuleSets(config: any, map: Record<string, string>) {
  const next = structuredClone(config);
  next.route = next.route ?? {};
  next.route.rule_set = (next.route.rule_set ?? []).map((rs: Record<string, any>) => {
    if (rs?.type !== "remote") return rs;
    const path = map[rs.tag];
    if (!path) throw new Error(`规则集 ${rs.tag} 没有本地映射`);
    return { type: "local", tag: rs.tag, format: "binary", path };
  });
  const experimental = { ...(next.experimental ?? {}) };
  delete experimental.clash_api;
  if (Object.keys(experimental).length > 0) next.experimental = experimental;
  else delete next.experimental;
  return next;
}

/** 同步二进制、规则产物与底模到 VM。内核需要这些文件在可读位置。 */
function pushToGuest(): void {
  // 崩溃可能留下服务端；替换 inode 避免原地覆写触发 ETXTBSY。
  const r = guest(`
    set -e
    sudo -n pkill -9 -x sbtools 2>/dev/null || true
    for _ in $(seq 1 100); do pgrep -x sbtools >/dev/null || break; sleep 0.05; done
    pgrep -x sbtools >/dev/null && { echo "残留 sbtools 未在 5s 内退出" >&2; exit 1; }
    mkdir -p /work
    cp ${REPO_IN_GUEST}/.sandbox-artifacts/sbtools ${GUEST_BINARY}.new
    chmod +x ${GUEST_BINARY}.new
    mv -f ${GUEST_BINARY}.new ${GUEST_BINARY}
    rm -rf ${WORK}
    mkdir -p ${WORK}/rules ${WORK}/tests
    cp -r ${REPO_IN_GUEST}/config/rules/generated/singbox/. ${WORK}/rules/
    cp ${REPO_IN_GUEST}/config/sing-box/template.json ${WORK}/template.json
    cp ${REPO_IN_GUEST}/config/sing-box/base.yaml ${WORK}/base.yaml
    cp ${REPO_IN_GUEST}/config/sing-box/settings.yaml ${WORK}/settings.yaml
    # tests/ 整目录在 VM 内跑，结构测试要读同目录的 base.yaml / settings.yaml（生成真源）
    cp ${REPO_IN_GUEST}/config/sing-box/template-ios.json ${WORK}/template-ios.json
    cp ${REPO_IN_GUEST}/config/sing-box/template-router.json ${WORK}/template-router.json
    cp -r ${REPO_IN_GUEST}/config/sing-box/tests/. ${WORK}/tests/
  `);
  if (r.code !== 0) fail("同步到 VM", r.err.trim());

  const ver = guest(`${GUEST_BINARY} version`);
  if (ver.code !== 0) fail("执行 VM 内二进制", ver.err.trim());
  console.log(`[引导] VM 内核二进制: ${ver.out.trim()}`);
}

/** 规则集映射与外部 .srs 在服务端配置取回后才确定，第二阶段再拷入 VM。 */
function pushRuleSetsToGuest(): void {
  const r = guest(`
    set -e
    mkdir -p ${WORK}/external
    cp -r ${REPO_IN_GUEST}/.sandbox-artifacts/sandbox-rules/external/. ${WORK}/external/ 2>/dev/null || true
    cp ${REPO_IN_GUEST}/.sandbox-artifacts/sandbox-rules/rules-map.json ${WORK}/rules-map.json
  `);
  if (r.code !== 0) fail("同步规则集到 VM", r.err.trim());
}

/**
 * 在 VM 内启动服务端并等它就绪。
 *
 * 两处环境必须显式处理：
 * - SING_BOX 要注入：VM 内内核不在 PATH 上（在 /opt/proxy-test/bin）
 * - 代理变量要清除：/etc/environment 有 lima 写入的宿主代理地址（VM 内不可达），
 *   不清会让服务端拉订阅时挂到超时
 *
 * 私钥全程只在 VM 内流转：keygen 与 server 在同一条 guest 命令里完成，
 * 不经宿主的 stdout，也不作为 `limactl` 的 argv（那会进宿主进程参数表）。
 */
function startServer(): void {
  const r = guest(
    `
    set -e
    # keygen 的私钥只在本 shell 内存在，不回到宿主
    SK=$(${GUEST_BINARY} keygen | sed -n 's/^SERVER_PRIVATE_KEY=//p')
    [ -n "$SK" ] || { echo "keygen 未产出私钥" >&2; exit 1; }

    sudo -n pkill -9 -x sbtools 2>/dev/null || true
    env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u all_proxy \\
      SING_BOX=${SB} SERVER_PRIVATE_KEY="$SK" \\
      nohup ${GUEST_BINARY} server --port ${PORT} > /work/sbtools-server.log 2>&1 &
    for _ in $(seq 1 40); do
      curl -sS --noproxy '*' -o /dev/null "http://127.0.0.1:${PORT}/healthz" && exit 0
      sleep 0.2
    done
    echo "服务端未就绪"; cat /work/sbtools-server.log; exit 1
  `,
  );
  if (r.code !== 0) fail("启动服务端", (r.err + r.out).trim());
}

/**
 * 闭环输入。
 *
 * 默认用假 URI：沙箱验证的是内核裁决结果，不是代理连通性（ADR-0003）。
 * `just trace` 追真实链路时传入 .env 里的订阅与节点。
 */
export interface LoopOptions {
  subs?: string[];
  /** 节点 URI 列表。tag 需能匹配底模 selfhost 组正则 `(?i)(vps|hy2|selfhost)`，
   *  否则该组展开为空被跳过，引用它的 proxy/openai 等组会因缺 tag 让内核 FATAL。 */
  nodes?: string[];
  /** 追加进 overlay 的字段（默认注入 debug 日志级别，裁决断言依赖它）。 */
  overlay?: Record<string, unknown>;
}

const DEFAULT_NODES = [
  "hy2://pass@192.0.2.1:8388?sni=example.com#selfhost-jp",
  "hy2://pass@192.0.2.2:8388?sni=example.com#selfhost-hk",
];

/** 真实数据源：用户的客户端配置。默认引用其 nodes/subs 走完整闭环，
 *  缺失或为空时 WARN 退回合成夹具。凭据只经 stdin 进 VM，不落日志。 */
const REAL_CONFIG = join(process.env.HOME ?? "", ".config/sing-box/config.yaml");

/** 提取客户端配置的 nodes/subs 列表，其余键（overlay 等）不碰。 */
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

/** 经客户端 encode + 服务端 /sub 取回真实产物，并后处理为可在 VM 内运行的配置。 */
function fetchRawConfig(options: LoopOptions): { route?: { rule_set?: Array<Record<string, unknown>> } } {
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
    fail("构造客户端配置", "subs 与 nodes 均为空，服务端会拒绝");
  }

  // 底模顶层无 log 键，裁决断言依赖 debug 级日志，只能由 overlay 注入
  const overlay = { log: { level: "debug" }, ...options.overlay };
  const yaml = [
    ...(subs.length > 0 ? ["subs:", ...subs.map((s) => `  - "${s}"`)] : []),
    ...(nodes.length > 0 ? ["nodes:", ...nodes.map((n) => `  - "${n}"`)] : []),
    "overlay: |",
    `  ${JSON.stringify(overlay)}`,
    "",
  ].join("\n");

  // 凭据只经 stdin 进 VM，不落宿主磁盘：`just trace` 传的是 .env 里的真实订阅与
  // 节点，写到宿主工作区等于把它们长期留在默认权限的文件里（.gitignore 只挡 Git
  // 跟踪，不挡本机读取）。VM 内用 umask 077 建文件，并在退出时清理。
  const r = guest(
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
    # 服务端已完成使命：留着会占端口，挡住下一次引导
    sudo -n pkill -9 -x sbtools 2>/dev/null || true
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

/** 用服务端实际配置建立的 tag→路径映射做本地化，再写回 VM 并校验。 */
function finalizeConfig(raw: unknown, map: Record<string, string>): void {
  let localized: unknown;
  try {
    localized = localizeRuleSets(raw, map);
  } catch (e) {
    fail("本地化规则集", e instanceof Error ? e.message : String(e));
  }
  const put = guest(`cat > ${WORK}/config.json`, JSON.stringify(localized, null, 2));
  if (put.code !== 0) fail("写入 VM 配置", put.err.trim());
  const chk = guest(`${SB} check -c ${WORK}/config.json`);
  if (chk.code !== 0) fail("校验配置", chk.err.trim());
  console.log(`[引导] 闭环就绪：${WORK}/config.json`);
}

/**
 * VM 内核必须与 `.mise.toml` 声明的版本一致，否则沙箱测的不是生产内核。
 *
 * lima.yaml 的 provision 只在首次创建时装内核（已存在即跳过），升级 `.mise.toml`
 * 后旧 VM 会一直停在旧版本。所以每次进沙箱前核对一次，不一致就替换。
 * 下载在宿主做：VM 的代理变量指向宿主地址，VM 内不可达（见 startServer）。
 */
export function ensureGuestKernel(): void {
  const versionOf = (out: string) => out.match(/^sing-box version (\S+)/m)?.[1];
  const want = host([
    "mise", "config", "get", "--file", resolve(import.meta.dir, "../.mise.toml"), "tools.sing-box",
  ]).out.trim();
  if (!want) fail("读取内核版本", ".mise.toml 的 tools.sing-box 为空");
  const have = versionOf(guest(`${SB} version`).out);
  if (have === want) return;

  console.log(`[引导] VM 内核 ${have ?? "缺失"} 与 .mise.toml ${want} 不一致，替换中`);
  const name = `sing-box-${want}-linux-arm64`;
  const dir = resolve(ARTIFACT_DIR, "kernel");
  mkdirSync(dir, { recursive: true });
  const tgz = resolve(dir, `${name}.tar.gz`);
  const url = `https://github.com/SagerNet/sing-box/releases/download/v${want}/${name}.tar.gz`;
  const dl = host(["curl", "-fsSL", "-o", tgz, url]);
  if (dl.code !== 0) fail("下载内核", `${url}: ${dl.err.trim()}`);
  const x = host(["tar", "-xzf", tgz, "-C", dir]);
  if (x.code !== 0) fail("解压内核", x.err.trim());

  // 先装到 .new 再 mv：替换 inode，避免覆写正在运行的内核触发 ETXTBSY
  const r = guest(`
    set -e
    sudo -n install -m 0755 ${REPO_IN_GUEST}/.sandbox-artifacts/kernel/${name}/sing-box ${SB}.new
    sudo -n mv -f ${SB}.new ${SB}
  `);
  if (r.code !== 0) fail("替换 VM 内核", r.err.trim());
  const now = versionOf(guest(`${SB} version`).out);
  if (now !== want) fail("替换 VM 内核", `替换后为 ${now ?? "无法执行"}，期望 ${want}`);
  console.log(`[引导] VM 内核已更新为 ${want}`);
}

export function bootstrap(options: LoopOptions = {}): void {
  // 二进制/仓库产物先行：底模声明的产物缺失时先报，不必碰 VM
  ensureBinary();
  verifyLocalArtifacts(planRuleSets());
  ensureGuestKernel();
  pushToGuest();
  startServer();
  // 规则集映射要看服务端实际配置（含 device overlay 声明的 set），再构建一次并校验
  const raw = fetchRawConfig(options);
  const plan = planRuleSets(raw);
  verifyLocalArtifacts(plan);
  const map = stageRuleSets(plan);
  pushRuleSetsToGuest();
  finalizeConfig(raw, map);
}

if (import.meta.main) {
  if (process.argv.includes("--kernel-only")) ensureGuestKernel();
  else bootstrap();
}
