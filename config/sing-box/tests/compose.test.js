// 端点核心装配出来的整份配置必须被内核接受。
//
// sing-box check 不下载规则集，但会校验规则集引用、字段是否合法（注意它不校验规则里的
// 出站是否存在，那要跑起来才现形）。端点核心把底模、内网参数、节点出站与策略组拼成一份
// 配置，拼错的地方在这里现形。
//
// 用例只断言外部可观察的产出：这份配置能不能过校验、里面引用了什么、能不能跑起来。

import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { SING_BOX, WORK, startSandbox } from "./lib/sandbox.js";

const TOOLS = `${WORK}/tools`;
const COMPOSED = `${WORK}/composed.json`;
const REMOTE_BASE = "https://raw.githubusercontent.com/shelken/proxy/sing-box-rules";
// 本地投影节点：装配要求至少一个节点，规则集下载也会经过它。
const PROBE_PORT = 18388;
const PROBE_NODE = {
  type: "shadowsocks",
  tag: "probe-ss",
  server: "127.0.0.1",
  server_port: PROBE_PORT,
  method: "aes-128-gcm",
  password: "test",
};

// 内网参数经契约传入；解析后端换成沙箱里的投影节点，因此不依赖容器。
const INPUT = { dns: "192.0.2.10", zone: "corp.internal" };

// 复用仓库里真实的装配代码，不在测试里再抄一份分组与装配规则。
const { buildConfig } = await import(`${TOOLS}/endpoint.mjs`);

let sb;

/** 用端点核心装配一份完整配置，产物落在 ${WORK}/composed.json。 */
async function compose(payload = INPUT) {
  const config = await buildConfig(
    { source: "fixture", dns: payload.dns, zone: payload.zone },
    {
      template: JSON.parse(readFileSync(`${WORK}/template.json`, "utf-8")),
      parse: async () => [structuredClone(PROBE_NODE)],
    },
  );
  writeFileSync(COMPOSED, JSON.stringify(config, null, 2) + "\n", "utf-8");
  return config;
}

function check(path) {
  return Bun.spawnSync([SING_BOX, "check", "-c", path]);
}

describe("compose", () => {
  test("composed darwin config passes the kernel's structural check", async () => {
    const config = await compose();

    const checked = check(COMPOSED);
    expect(checked.stderr.toString() + checked.stdout.toString()).toBe("");
    expect(checked.exitCode).toBe(0);

    // 拼出来的必须是完整一份：入口、出站、规则集引用都得在。
    expect(config.inbounds.map((item) => item.tag)).toContain("tun-in");
    expect(config.outbounds.map((item) => item.tag)).toContain("proxy");
    expect(config.route.rule_set.length).toBeGreaterThan(10);

    // 规则只许引用存在的出站：check 不查这一条，漏了要等启动才 FATAL。
    const tags = new Set(config.outbounds.map((item) => item.tag));
    const missing = config.route.rules
      .map((rule) => rule.outbound)
      .filter((tag) => tag && !tags.has(tag));
    expect(missing).toEqual([]);
  });

  test("composed config pulls rule sets from the published branch", async () => {
    const config = await compose();

    const remote = config.route.rule_set.filter((item) => item.type === "remote");
    expect(remote.length).toBeGreaterThan(10);
    for (const item of remote) {
      expect(item.url.startsWith(`${REMOTE_BASE}/singbox/`)).toBe(true);
    }
    // 一份能跑起来的配置不该引用磁盘上的产物：沙箱里没有那些文件。
    expect(config.route.rule_set.some((item) => item.type === "local")).toBe(false);
  });

  test("internal zone and resolver come from the parameters", async () => {
    const config = await compose({ dns: "192.0.2.10", zone: "lab.test" });

    expect(
      config.dns.servers.find((item) => item.tag === "dns-internal").server,
    ).toBe("192.0.2.10");
    expect(
      config.route.rule_set.find((item) => item.tag === "zone-internal").rules,
    ).toEqual([{ domain_suffix: ["lab.test"] }]);

    // 内网规则必须先于列表规则：反过来的话内网直连永远不会命中。
    const zoneRule = config.route.rules.findIndex((rule) =>
      (rule.rule_set ?? []).includes("zone-internal"),
    );
    const firstListRule = config.route.rules.findIndex((rule) =>
      (rule.rule_set ?? []).some((tag) => tag !== "zone-internal"),
    );
    expect(zoneRule).toBeGreaterThanOrEqual(0);
    expect(firstListRule).toBeGreaterThan(zoneRule);
  });
});

// 结构校验看不出装配错误：内核在启动阶段才拒绝「空直连出站当 detour」这类组合，
// 而它一旦拒绝就是 FATAL，配置根本起不来。所以这里真把它跑起来。
//
// 需要联网：规则集从发布分支拉，拉不下来内核同样退出（实测），因此这一层无法离线。
describe("composed config runs", () => {
  test("starts, pulls every rule set and comes up with a tun", async () => {
    const probe = await startProbeNode();
    try {
      await compose();

      sb = startSandbox({ publicConfig: COMPOSED });
      await sb.waitFor("sing-box started", 60_000);
      await sb.waitFor("tun0", 30_000);

      const updated = (sb.log().match(/updated rule-set/g) ?? []).length;
      // 26 份清单产物 + 1 份 DNS 域名版；内联的 zone-internal 不需要下载。
      expect(updated).toBe(27);
      expect(sb.log()).not.toContain("FATAL");
      // DNS 规则引用含 IP 条目的规则集会触发这条废弃告警，1.16 起还会拒绝启动。
      expect(sb.log()).not.toContain("Legacy Address Filter");
    } finally {
      await sb?.stop();
      await probe.stop();
    }
  }, 180_000);
});

/**
 * 起一个本地 shadowsocks 服务端，供合成出来的配置当节点用。
 *
 * 服务端自己的出站绑定物理网卡：客户端 TUN 抢走默认路由后，不绑定的话服务端的上游流量
 * 会被再次灌进 TUN，形成回环（实测表现为规则集下载被 reset，内核 FATAL 退出）。
 */
async function startProbeNode() {
  const configPath = `${WORK}/probe-node.json`;
  await Bun.write(
    configPath,
    JSON.stringify(
      {
        log: { level: "info" },
        inbounds: [
          {
            type: "shadowsocks",
            tag: "ss-in",
            listen: "127.0.0.1",
            listen_port: PROBE_PORT,
            method: "aes-128-gcm",
            password: "test",
          },
        ],
        outbounds: [{ type: "direct", tag: "direct", bind_interface: "eth0" }],
      },
      null,
      2,
    ),
  );

  const proc = Bun.spawn([SING_BOX, "run", "-c", configPath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  let output = "";
  const drain = async (stream) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      output += decoder.decode(chunk, { stream: true });
    }
  };
  const drains = [drain(proc.stdout), drain(proc.stderr)];

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (output.includes(`tcp server started at 127.0.0.1:${PROBE_PORT}`)) break;
    if (proc.exitCode !== null) {
      throw new Error(`probe node exited with code ${proc.exitCode}\n${output}`);
    }
    await Bun.sleep(50);
  }
  if (!output.includes(`tcp server started at 127.0.0.1:${PROBE_PORT}`)) {
    proc.kill("SIGKILL");
    throw new Error(`probe node did not start\n${output}`);
  }

  return {
    async stop() {
      proc.kill("SIGTERM");
      await Promise.race([
        Promise.all(drains),
        Bun.sleep(3_000).then(() => proc.kill("SIGKILL")),
      ]);
      await proc.exited;
    },
  };
}
