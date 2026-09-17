// 结构层：合并后的配置必须自洽。不需要特权。
//
// 被测对象是沙箱里的文件集（sync-sandbox 排除了生成产物），因此断言
// 「没有任何 type: local 规则集」等价于「生成产物没有漏进沙箱，
// 内联定义取得了唯一所有权」。

import { describe, expect, test, beforeAll } from "bun:test";
import { SING_BOX, WORK } from "./lib/sandbox.js";

const CONF = `${WORK}/conf.d`;
const OVERLAY = `${WORK}/tests/overlay.json`;
const MERGED = "/tmp/config-merged.json";

let merged;
let checkExit;

beforeAll(async () => {
  const merge = Bun.spawnSync([
    SING_BOX,
    "merge",
    MERGED,
    "-C",
    CONF,
    "-c",
    OVERLAY,
  ]);
  if (merge.exitCode !== 0) {
    throw new Error(`merge failed: ${merge.stderr.toString()}`);
  }
  merged = JSON.parse(await Bun.file(MERGED).text());

  const check = Bun.spawnSync([SING_BOX, "check", "-C", CONF, "-c", OVERLAY]);
  checkExit = { code: check.exitCode, stderr: check.stderr.toString() };
});

describe("merged config", () => {
  test("passes sing-box check", () => {
    expect(checkExit.stderr).toBe("");
    expect(checkExit.code).toBe(0);
  });

  test("every referenced rule_set tag is declared", () => {
    const declared = new Set(merged.route.rule_set.map((rs) => rs.tag));

    const referenced = [];
    for (const rule of merged.route.rules) {
      const tags = Array.isArray(rule.rule_set) ? rule.rule_set : [rule.rule_set];
      referenced.push(...tags.filter(Boolean));
    }

    const missing = referenced.filter((tag) => !declared.has(tag));
    expect(missing).toEqual([]);
  });

  test("every referenced dns server, outbound and final is defined", () => {
    const servers = new Set(merged.dns.servers.map((s) => s.tag));
    const outbounds = new Set(merged.outbounds.map((o) => o.tag));

    const missingServers = merged.dns.rules
      .map((rule) => rule.server)
      .filter(Boolean)
      .filter((tag) => !servers.has(tag));
    expect(missingServers).toEqual([]);

    const missingOutbounds = merged.route.rules
      .map((rule) => rule.outbound)
      .filter(Boolean)
      .filter((tag) => !outbounds.has(tag));
    expect(missingOutbounds).toEqual([]);

    expect(servers.has(merged.dns.final)).toBe(true);
    expect(outbounds.has(merged.route.final)).toBe(true);
  });

  test("no disk-backed rule_set leaked into the sandbox", () => {
    // 生成的 45-ruleset.json 引用 ../rules/generated/singbox/*.srs，其条目
    // 带 type: "local"。它若进入沙箱，其 tag 会与本覆盖层的内联定义重名，
    // 测试结果就取决于构建时是否跑过生成器。
    const local = merged.route.rule_set.filter((rs) => rs.type === "local");
    expect(local).toEqual([]);
  });

  test("only the two overlay rule sets are present", () => {
    // merge 会剥掉 type: "inline"（内联是默认类型），所以这里按 tag 断言。
    // 沙箱内既没有生成产物，也没有真实私有拓扑，规则集应当只有这两个。
    const tags = merged.route.rule_set.map((rs) => rs.tag).sort();
    expect(tags).toEqual(["ChinaMax", "zone-internal"]);
  });
});
