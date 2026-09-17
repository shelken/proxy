// 规则层：内联规则集必须按预期匹配。不需要特权。
//
// 只断言测试覆盖层里内联定义的两个规则集。生产 .srs 的正确性由
// scripts/singbox_rules.test.js 保证，在这里重复断言会把沙箱测试
// 与「是否跑过生成器」绑在一起。
//
// sing-box rule-set match 的退出码恒为 0，命中信息以 "match rules.[i]"
// 打印到 stderr，所以判定必须看输出内容，不能看退出码。

import { describe, expect, test, beforeAll } from "bun:test";
import { SING_BOX, WORK } from "./lib/sandbox.js";

const OVERLAY = `${WORK}/tests/overlay.json`;
const CONF = `${WORK}/conf.d`;

/** 把内联规则集导出成独立源文件，供 rule-set match 使用。 */
async function exportRuleSet(tag) {
  const mergedPath = `/tmp/rs-merge-${tag}.json`;
  const merge = Bun.spawnSync([SING_BOX, "merge", mergedPath, "-C", CONF, "-c", OVERLAY]);
  if (merge.exitCode !== 0) {
    throw new Error(`merge failed: ${merge.stderr.toString()}`);
  }
  const merged = JSON.parse(await Bun.file(mergedPath).text());
  const rs = merged.route.rule_set.find((item) => item.tag === tag);
  if (!rs) throw new Error(`rule_set not found: ${tag}`);

  const sourcePath = `/tmp/rs-${tag}.json`;
  await Bun.write(sourcePath, JSON.stringify({ version: 3, rules: rs.rules }, null, 2));
  return sourcePath;
}

/** 返回是否命中（依据输出内容，不看退出码）。 */
function matches(sourcePath, value) {
  const proc = Bun.spawnSync([SING_BOX, "rule-set", "match", sourcePath, value]);
  return `${proc.stdout}${proc.stderr}`.includes("match rules.");
}

const FILES = {};

beforeAll(async () => {
  for (const tag of ["zone-internal", "ChinaMax"]) {
    FILES[tag] = await exportRuleSet(tag);
  }
});

describe("zone-internal", () => {
  test("matches an internal domain", () => {
    expect(matches(FILES["zone-internal"], "foo.zone.test")).toBe(true);
  });

  test("does not match a public domain", () => {
    expect(matches(FILES["zone-internal"], "example.com")).toBe(false);
  });
});

describe("ChinaMax", () => {
  test("matches a .cn domain", () => {
    expect(matches(FILES["ChinaMax"], "example.cn")).toBe(true);
  });

  test("does not match a non-.cn domain", () => {
    expect(matches(FILES["ChinaMax"], "example.org")).toBe(false);
  });
});
