/**
 * 沙箱 VM 驱动：`limactl` 调用、宿主命令执行与 `.env` 解析的唯一入口。
 *
 * 沙箱引导、trace-route 与 dns-observe 都经这里进 VM。VM 名、工作目录与 shell
 * 调用方式只在这一处定义。
 */

export const VM_NAME = "proxy-test";

/** 子进程退出码。命令被信号终止时为 null。 */
export interface ShellResult {
  code: number | null;
  out: string;
  err: string;
}

/** 在宿主机执行命令。 */
export function host(cmd: string[]): ShellResult {
  const p = Bun.spawnSync(cmd);
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

/** 在 VM 内执行命令；给了 stdin 就同时写入其标准输入。 */
export function guest(cmd: string, stdin?: string): ShellResult {
  const p = Bun.spawnSync(
    ["limactl", "shell", "--workdir", "/work", VM_NAME, "sh", "-c", cmd],
    stdin === undefined ? {} : { stdin: Buffer.from(stdin) },
  );
  return {
    code: p.exitCode,
    out: p.stdout.toString(),
    err: p.stderr.toString(),
  };
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
