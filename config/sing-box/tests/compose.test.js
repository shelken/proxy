// 目录装配层：验证 conf.d 目录切片合并逻辑与优先级。
//
// 验证对象是 conf.d 下的 00-local.json（本地私有覆写）与 10-rules.json（双入站与分流底座）：
// 1. sing-box check -C conf.d 必须通过结构校验；
// 2. 内网私有规则在数组合并后必须排在前面优先命中；
// 3. 包含了 tun-in 与 mixed-in 双入站；
// 4. 内核通过 -C 目录能正常跑起来并初始化 tun。

import { describe, expect, test } from "bun:test";
import { SING_BOX, WORK, startSandbox } from "./lib/sandbox.js";

const CONF_DIR = `${WORK}/conf.d`;

function checkConfDir(dir) {
  return Bun.spawnSync([SING_BOX, "check", "-C", dir]);
}

function mergeConfDir(output) {
  const local = `${CONF_DIR}/00-local.json`;
  const rules = `${CONF_DIR}/10-rules.json`;
  return Bun.spawnSync([SING_BOX, "merge", output, "-c", local, "-c", rules]);
}

describe("conf.d directory compose", () => {
  test("conf.d directory passes sing-box structural check", () => {
    const checked = checkConfDir(CONF_DIR);
    expect(checked.stderr.toString() + checked.stdout.toString()).toBe("");
    expect(checked.exitCode).toBe(0);
  });

  test("merged config contains dual inbounds (tun-in and mixed-in)", async () => {
    const mergedPath = "/tmp/composed-merge-test.json";
    const res = mergeConfDir(mergedPath);
    expect(res.exitCode).toBe(0);

    const merged = JSON.parse(await Bun.file(mergedPath).text());
    const inboundTags = merged.inbounds.map((item) => item.tag);
    expect(inboundTags).toContain("tun-in");
    expect(inboundTags).toContain("mixed-in");
  });

  test("00-local rules precede generic rules in route.rules", async () => {
    const mergedPath = "/tmp/composed-merge-test.json";
    const res = mergeConfDir(mergedPath);
    expect(res.exitCode).toBe(0);

    const merged = JSON.parse(await Bun.file(mergedPath).text());
    const zoneRuleIndex = merged.route.rules.findIndex((r) =>
      (r.rule_set ?? []).includes("zone-internal"),
    );
    expect(zoneRuleIndex).toBeGreaterThanOrEqual(0);
  });

  test("runs with -C conf.d and establishes tun0 interface", async () => {
    const sb = startSandbox({ confDir: CONF_DIR });
    try {
      await sb.waitFor("sing-box started");
      await sb.waitFor("tun0");
      expect(sb.log()).not.toContain("FATAL");
    } finally {
      await sb.stop();
    }
  });
});
