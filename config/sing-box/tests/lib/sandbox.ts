// 在 VM 内驱动 sing-box，供沙箱测试断言路由决策。
//
// 观测面是 debug 日志：sing-box 每做一次路由决策就打一行
//   router: match[N] rule_set=<tag> => route(<outbound>)
// 测试从日志里解析裁决结果。

export const SING_BOX = process.env.SING_BOX || "/opt/proxy-test/bin/sing-box";

// /host-home 是只读挂载，sing-box 的 -D 与 cache.db 都需要可写位置。
export const WORK = "/work/sing-box";

export interface SandboxOptions {
  configPath?: string;
}

export interface SandboxHandle {
  waitFor(pattern: string | RegExp, timeoutMs?: number): Promise<string>;
  log(): string;
  stop(): Promise<void>;
}

/**
 * 启动 sing-box，返回可查询的句柄。
 */
export function startSandbox(options: SandboxOptions = {}): SandboxHandle {
  const { configPath } = options;
  const targetConfig = configPath || `${WORK}/config.json`;
  const configArgs = ["-c", targetConfig];
  const proc = Bun.spawn(
    ["sudo", "-n", SING_BOX, "run", "-D", WORK, ...configArgs],
    { stdout: "pipe", stderr: "pipe" },
  );

  let output = "";
  let stopped = false;

  // 日志量大，必须持续排空管道，否则 sing-box 会阻塞在写日志上。
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      output += decoder.decode(chunk, { stream: true });
    }
  };
  const drains = [drain(proc.stdout), drain(proc.stderr)];

  return {
    async waitFor(pattern: string | RegExp, timeoutMs = 15_000): Promise<string> {
      const re = typeof pattern === "string" ? new RegExp(pattern) : pattern;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (re.test(output)) return output;
        if (proc.exitCode !== null) {
          throw new Error(
            `sing-box exited with code ${proc.exitCode}\n--- output ---\n${output}`,
          );
        }
        await Bun.sleep(50);
      }
      throw new Error(
        `timed out waiting for /${pattern}/ after ${timeoutMs}ms\n--- output ---\n${output}`,
      );
    },

    log: () => output,

    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      proc.kill("SIGTERM");
      await Promise.race([
        Promise.all(drains),
        Bun.sleep(3_000).then(() => proc.kill("SIGKILL")),
      ]);
      await proc.exited;
    },
  };
}
