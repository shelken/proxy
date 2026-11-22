/**
 * 容器沙箱驱动：OrbStack/Docker 启停、镜像缓存、本地 musl 编译、Linux 内核校验
 * 与临时网络命名空间容器管理的唯一入口。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export const REPO_ROOT = resolve(import.meta.dir, "..");
export const SANDBOX_WORK = "/work/sing-box";

const SANDBOX_DOCKERFILE = resolve(REPO_ROOT, "config/sing-box/Dockerfile.sandbox");
const BUILDER_DOCKERFILE = resolve(REPO_ROOT, "scripts/Dockerfile.builder");
const TARGET_VOLUME = "proxy-sbtools-target";

export interface ShellResult {
  code: number | null;
  out: string;
  err: string;
}

export function host(cmd: string[], opts: { cwd?: string } = {}): ShellResult {
  const p = Bun.spawnSync(cmd, { cwd: opts.cwd ?? REPO_ROOT });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

/** 解析 `KEY=VALUE` 形式的 .env；空行与注释跳过，成对的引号去掉。 */
export function parseEnv(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const k = trimmed.slice(0, eq).trim();
    let v = trimmed.slice(eq + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    env[k] = v;
  }
  return env;
}

/** 从 `.mise.toml` 读取与线上对齐的 `sing-box` 版本号。 */
export function readSingBoxVersion(repoRoot = REPO_ROOT): string {
  const raw = readFileSync(resolve(repoRoot, ".mise.toml"), "utf8");
  const parsed = Bun.TOML.parse(raw) as { tools?: Record<string, unknown> };
  const ver = parsed.tools?.["sing-box"];
  if (typeof ver !== "string" || !ver.trim()) {
    throw new Error("未能在 .mise.toml 的 [tools] 中读取 sing-box 版本");
  }
  return ver.trim();
}

function fileHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 12);
}

function runInherit(cmd: string[]): void {
  const p = Bun.spawnSync(cmd, { cwd: REPO_ROOT, stdout: "inherit", stderr: "inherit" });
  if (p.exitCode !== 0) {
    throw new Error(`命令失败 (exit=${p.exitCode}): ${cmd.join(" ")}`);
  }
}

/** 确保 OrbStack / Docker 守护进程就绪；若已停止则按需拉起。 */
export function ensureOrb(): void {
  if (host(["docker", "info"]).code === 0) return;

  if (!Bun.which("orb")) {
    throw new Error("Docker 不可用且未找到 orb 命令，请先安装并启动 OrbStack");
  }
  console.log("[沙箱] OrbStack 未运行，正在按需启动...");
  const start = host(["orb", "start"]);
  if (start.code !== 0) {
    throw new Error(`orb start 失败：${(start.err + start.out).trim()}`);
  }
  if (host(["docker", "info"]).code !== 0) {
    throw new Error("OrbStack 启动后 Docker 仍不可达");
  }
}

function ensureBuiltImage(
  tag: string,
  dockerfile: string,
  contextDir: string,
  buildArgs: string[] = [],
): string {
  ensureOrb();
  if (host(["docker", "image", "inspect", tag]).code === 0) return tag;

  console.log(`[沙箱] 构建镜像 ${tag}...`);
  runInherit([
    "docker",
    "build",
    "-f",
    dockerfile,
    ...buildArgs.flatMap((arg) => ["--build-arg", arg]),
    "-t",
    tag,
    contextDir,
  ]);
  return tag;
}

/** 确保当前 `.mise.toml` 版本对应的沙箱镜像存在，版本或 Dockerfile 变更自动重建。 */
export function ensureSandboxImage(): string {
  const ver = readSingBoxVersion();
  const tag = `proxy-sandbox:sb-${ver}-${fileHash(SANDBOX_DOCKERFILE)}`;
  return ensureBuiltImage(tag, SANDBOX_DOCKERFILE, dirname(SANDBOX_DOCKERFILE), [
    `SING_BOX_VERSION=${ver}`,
  ]);
}

/** 确保静态 musl 编译镜像存在。 */
export function ensureBuilderImage(): string {
  const tag = `proxy-sbtools-builder:${fileHash(BUILDER_DOCKERFILE)}`;
  return ensureBuiltImage(tag, BUILDER_DOCKERFILE, dirname(BUILDER_DOCKERFILE));
}

/**
 * 在容器内编译当前工作区的 Linux musl 版 `sbtools`，复用宿主 Cargo registry 与
 * 专用 Docker target 缓存卷；优先离线编译，缺包时才允许回落在线拉取。
 */
export function buildLinuxSbtools(outPath: string): void {
  const image = ensureBuilderImage();
  const absOut = resolve(outPath);
  const outDir = dirname(absOut);
  const outName = basename(absOut);
  mkdirSync(outDir, { recursive: true });

  const cargoRegistry = join(homedir(), ".cargo/registry");
  const mounts = [
    "--mount", `type=bind,src=${REPO_ROOT},dst=/src,ro`,
    "--mount", `type=volume,src=${TARGET_VOLUME},dst=/target`,
    "--mount", `type=bind,src=${outDir},dst=/out`,
  ];
  if (existsSync(cargoRegistry)) {
    mounts.push("--mount", `type=bind,src=${cargoRegistry},dst=/usr/local/cargo/registry`);
  }

  const runCargo = (offline: boolean): ShellResult => {
    const net = offline ? ["--network=none"] : [];
    const offlineFlag = offline ? "--offline " : "";
    const cmd = [
      "docker", "run", "--rm",
      ...net,
      ...mounts,
      "-w", "/src",
      "-e", "CARGO_TARGET_DIR=/target",
      image,
      "sh", "-ec",
      `cargo build --release --locked ${offlineFlag}-p sbtools && install -m 0755 /target/release/sbtools /out/${outName}`,
    ];
    return host(cmd);
  };

  console.log("[沙箱] 编译当前工作区 Linux 版 sbtools（容器增量缓存）...");
  let res = runCargo(true);
  if (res.code !== 0) {
    const combined = res.err + res.out;
    if (existsSync(cargoRegistry) && /--offline|missing crate|no matching package/i.test(combined)) {
      console.log("[沙箱] 宿主 Cargo registry 缺依赖，切联网补齐后编译...");
      res = runCargo(false);
    }
  }
  if (res.code !== 0) {
    throw new Error(`容器编译 sbtools 失败：\n${(res.err + res.out).trim()}`);
  }
}

/** 在无网络 Linux 官方 sing-box 容器内校验配置文件（用于 router 等 Linux 专属项）。 */
export function kernelCheckLinux(configPath: string): ShellResult {
  ensureOrb();
  const ver = readSingBoxVersion();
  const abs = resolve(configPath);
  return host([
    "docker",
    "run",
    "--rm",
    "--network=none",
    "--mount",
    `type=bind,src=${dirname(abs)},dst=/work,ro`,
    `ghcr.io/sagernet/sing-box:v${ver}`,
    "check",
    "-D",
    "/tmp",
    "-c",
    `/work/${basename(abs)}`,
  ]);
}

/**
 * 隔离网络命名空间的临时沙箱容器。每次创建即独享 `/work` 与 `tun` 设备，
 * `stop()` 自动移除容器及其临时状态，不再污染持久化环境。
 */
export class SandboxContainer {
  readonly name: string;
  private started = false;

  constructor(prefix = "proxy-sandbox") {
    this.name = `${prefix}-${process.pid}-${Date.now()}`;
  }

  start(): void {
    if (this.started) return;
    const image = ensureSandboxImage();
    const res = host([
      "docker",
      "run",
      "-d",
      "--rm",
      "--init",
      "--name",
      this.name,
      "--cap-add=NET_ADMIN",
      "--device=/dev/net/tun",
      "--mount",
      `type=bind,src=${REPO_ROOT},dst=/repo,ro`,
      "-w",
      "/work",
      image,
      "sleep",
      "infinity",
    ]);
    if (res.code !== 0) {
      throw new Error(`启动沙箱容器失败：${(res.err + res.out).trim()}`);
    }
    this.started = true;
  }

  exec(cmd: string, stdin?: string, workdir = "/work"): ShellResult {
    if (!this.started) this.start();
    const args = ["docker", "exec"];
    if (stdin !== undefined) args.push("-i");
    args.push("-w", workdir, this.name, "sh", "-c", cmd);
    const p = Bun.spawnSync(
      args,
      stdin === undefined ? { cwd: REPO_ROOT } : { cwd: REPO_ROOT, stdin: Buffer.from(stdin) },
    );
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  }

  execInherit(cmd: string[], workdir = "/work"): number {
    if (!this.started) this.start();
    const p = Bun.spawnSync(["docker", "exec", "-w", workdir, this.name, ...cmd], {
      cwd: REPO_ROOT,
      stdout: "inherit",
      stderr: "inherit",
    });
    return p.exitCode ?? 1;
  }

  spawn(cmd: string[], workdir = "/work") {
    if (!this.started) this.start();
    return Bun.spawn(["docker", "exec", "-w", workdir, this.name, ...cmd], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  cpTo(hostPath: string, containerPath: string): void {
    if (!this.started) this.start();
    const res = host(["docker", "cp", resolve(hostPath), `${this.name}:${containerPath}`]);
    if (res.code !== 0) {
      throw new Error(`拷入容器失败 (${hostPath} -> ${containerPath})：${res.err.trim()}`);
    }
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    host(["docker", "rm", "-f", this.name]);
  }
}

export async function withSandbox<T>(
  fn: (box: SandboxContainer) => T | Promise<T>,
  prefix = "proxy-sandbox",
): Promise<T> {
  const box = new SandboxContainer(prefix);
  box.start();
  try {
    return await fn(box);
  } finally {
    box.stop();
  }
}

if (import.meta.main) {
  const [sub, ...rest] = process.argv.slice(2);
  if (sub === "check" && rest[0]) {
    const r = kernelCheckLinux(rest[0]);
    if (r.out) process.stdout.write(r.out);
    if (r.err) process.stderr.write(r.err);
    process.exit(r.code ?? 1);
  } else if (sub === "exec") {
    const sep = rest.indexOf("--");
    const cmd = sep >= 0 ? rest.slice(sep + 1) : rest;
    if (cmd.length === 0) {
      console.error("用法: bun run scripts/sandbox.ts exec -- <cmd...>");
      process.exit(2);
    }
    const image = ensureSandboxImage();
    const p = Bun.spawnSync(
      [
        "docker",
        "run",
        "--rm",
        "--cap-add=NET_ADMIN",
        "--device=/dev/net/tun",
        "--mount",
        `type=bind,src=${REPO_ROOT},dst=/repo,ro`,
        "-w",
        "/work",
        image,
        ...cmd,
      ],
      { cwd: REPO_ROOT, stdout: "inherit", stderr: "inherit" },
    );
    process.exit(p.exitCode ?? 1);
  } else if (sub === "image") {
    const tag = ensureSandboxImage();
    console.log(tag);
  } else {
    console.error("用法: bun run scripts/sandbox.ts <check <file> | exec -- <cmd...> | image>");
    process.exit(2);
  }
}
