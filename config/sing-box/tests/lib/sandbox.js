// 在 VM 内驱动 sing-box，供沙箱测试断言路由决策。
//
// 观测面是 debug 日志：sing-box 每做一次路由决策就打一行
//   outbound/<type>[<tag>]: outbound connection to <destination>
// 测试据 tag 统计各出站被选中多少次。

import { rm, stat } from "node:fs/promises";

export const SING_BOX = "/opt/proxy-test/bin/sing-box";

// /host-home 是只读挂载，sing-box 的 -D 与 cache.db 都需要可写位置。
export const WORK = "/work/sing-box";

/**
 * 启动 sing-box，返回可查询的句柄。
 * @param {{ confDir?: string, publicConfig?: string, overlay?: string }} [options={}]
 */
export function startSandbox(options = {}) {
  const { confDir, publicConfig, overlay } = options;
  let configArgs;
  if (confDir) {
    configArgs = ["-C", confDir];
  } else if (publicConfig) {
    configArgs = ["-c", publicConfig, ...(overlay ? ["-c", overlay] : [])];
  } else {
    configArgs = ["-C", `${WORK}/conf.d`];
  }

  const proc = Bun.spawn(
    ["sudo", "-n", SING_BOX, "run", "-D", WORK, ...configArgs],
    { stdout: "pipe", stderr: "pipe" },
  );

  let output = "";
  let stopped = false;

  // 日志量大，必须持续排空管道，否则 sing-box 会阻塞在写日志上。
  const drain = async (stream) => {
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
    /** 等到输出中出现匹配 pattern 的行，或超时抛错。 */
    async waitFor(pattern, timeoutMs = 15_000) {
      const re = new RegExp(pattern);
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

    /** 清空已累积的日志，让下一个用例的断言不受上一个用例影响。 */
    clear: resetOutput,

    /** 返回日志全文，用于诊断。 */
    log: () => output,

    /** 统计某个出站 tag 被选中多少次。 */
    outboundHits(tag) {
      const matches = output.match(
        new RegExp(`outbound/\\w+\\[${tag}\\]: outbound connection`, "g"),
      );
      return matches ? matches.length : 0;
    },

    /** 幂等停止。 */
    async stop() {
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

/**
 * 启动 DNS 夹具，返回可查询的句柄。
 * @param {{ port: number, logPath: string }} options
 */
export async function startDnsFixture({ port, logPath }) {
  // 上一轮遗留的 .ready 会让下面的轮询立刻通过，从而在 bind 之前就发查询。
  await rm(`${logPath}.ready`, { force: true });
  await rm(logPath, { force: true });

  const proc = Bun.spawn(
    ["/opt/proxy-test/bin/bun", "run", `${WORK}/tests/fixtures/dns-fixture.mjs`, String(port), logPath],
    { stdout: "pipe", stderr: "pipe" },
  );

  // 夹具绑定端口后写下 <logPath>.ready。轮询它，不用固定 sleep：
  // 测试若在 bind 之前发查询，包会被静默丢弃。
  const readyFile = `${logPath}.ready`;
  const exists = async () => {
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
    /** 夹具收到的查询域名列表。 */
    async queried() {
      const file = Bun.file(logPath);
      if (!(await file.exists())) return [];
      return (await file.text()).split("\n").filter(Boolean);
    },

    /** 等到夹具的记录里出现某个域名，或超时返回当前内容。 */
    async waitForQuery(name, timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const seen = await this.queried();
        if (seen.includes(name)) return seen;
        await Bun.sleep(50);
      }
      return this.queried();
    },

    async stop() {
      proc.kill("SIGTERM");
      await proc.exited;
      await Bun.write(logPath, "");
    },
  };
}
