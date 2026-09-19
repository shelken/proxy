// 在 VM 内驱动 sing-box，供沙箱测试断言路由决策。
//
// 观测面是 debug 日志：sing-box 每做一次路由决策就打一行
//   outbound/<type>[<tag>]: outbound connection to <destination>
// 测试据 tag 统计各出站被选中多少次。

import { rm, stat } from "node:fs/promises";

export const SING_BOX = "/opt/proxy-test/bin/sing-box";

// /host-home 是只读挂载，sing-box 的 -D 与 cache.db 都需要可写位置。
export const WORK = "/work/sing-box";

export interface SandboxOptions {
  configPath?: string;
}

export interface SandboxHandle {
  waitFor(pattern: string | RegExp, timeoutMs?: number): Promise<string>;
  clear(): void;
  log(): string;
  outboundHits(tag: string): number;
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

  const resetOutput = () => {
    output = "";
  };

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

    clear: resetOutput,
    log: () => output,

    outboundHits(tag: string): number {
      const matches = output.match(
        new RegExp(`outbound/\\w+\\[${tag}\\]: outbound connection`, "g"),
      );
      return matches ? matches.length : 0;
    },

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

export interface DnsFixtureOptions {
  port: number;
  logPath: string;
}

export interface DnsFixtureHandle {
  queried(): Promise<string[]>;
  waitForQuery(name: string, timeoutMs?: number): Promise<string[]>;
  stop(): Promise<void>;
}

/**
 * 启动 DNS 夹具，返回可查询的句柄。
 */
export async function startDnsFixture({ port, logPath }: DnsFixtureOptions): Promise<DnsFixtureHandle> {
  await rm(`${logPath}.ready`, { force: true });
  await rm(logPath, { force: true });

  const proc = Bun.spawn(
    ["/opt/proxy-test/bin/bun", "run", `${WORK}/tests/fixtures/dns-fixture.ts`, String(port), logPath],
    { stdout: "pipe", stderr: "pipe" },
  );

  const readyFile = `${logPath}.ready`;
  const exists = async (): Promise<boolean> => {
    try {
      await stat(readyFile);
      return true;
    } catch {
      return false;
    }
  };

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await exists()) break;
    if (proc.exitCode !== null) {
      throw new Error(`dns fixture exited with code ${proc.exitCode}`);
    }
    await Bun.sleep(50);
  }
  if (!(await exists())) {
    proc.kill("SIGKILL");
    throw new Error(`dns fixture did not become ready on port ${port}`);
  }

  return {
    async queried(): Promise<string[]> {
      const file = Bun.file(logPath);
      if (!(await file.exists())) return [];
      return (await file.text()).split("\n").filter(Boolean);
    },

    async waitForQuery(name: string, timeoutMs = 5_000): Promise<string[]> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const seen = await this.queried();
        if (seen.includes(name)) return seen;
        await Bun.sleep(50);
      }
      return this.queried();
    },

    async stop(): Promise<void> {
      proc.kill("SIGTERM");
      await proc.exited;
      await Bun.write(logPath, "");
    },
  };
}
