import { describe, expect, test } from "bun:test";

import {
  isRepoArtifact,
  localizeRuleSets,
  planRuleSets,
  verifyLocalArtifacts,
} from "./rule-set-local.ts";
import { RULES_URL } from "./settings.ts";

describe("planRuleSets：tag → VM 本地文件", () => {
  test("仓库产物按 URL 真实文件名（解编码），外部 .srs 用独立序号目录", () => {
    const plan = planRuleSets({
      route: {
        rule_set: [
          { tag: "OpenAI", type: "remote", url: `${RULES_URL}/OpenAI.srs` },
          { tag: "小米追踪", type: "remote", url: `${RULES_URL}/%E5%B0%8F%E7%B1%B3%E8%BF%BD%E8%B8%AA.srs` },
          { tag: "Alias", type: "remote", url: `${RULES_URL}/Other.srs` },
          { tag: "External", type: "remote", url: "https://cdn.example.com/%E5%B0%8F%E7%B1%B3.srs" },
          { tag: "Local", type: "local", path: "/x.srs" },
        ],
      },
    });
    expect(plan.map((p) => [p.tag, p.path, p.external])).toEqual([
      ["OpenAI", "rules/OpenAI.srs", false],
      ["小米追踪", "rules/小米追踪.srs", false],
      ["Alias", "rules/Other.srs", false],
      ["External", "external/0.srs", true],
    ]);
  });

  test("目录边界：相邻与嵌套目录不算本仓库直接产物", () => {
    expect(isRepoArtifact(`${RULES_URL}/OpenAI.srs`)).toBe(true);
    expect(isRepoArtifact(`${RULES_URL}-backup/OpenAI.srs`)).toBe(false);
    expect(isRepoArtifact(`${RULES_URL}/nested/OpenAI.srs`)).toBe(false);
    expect(isRepoArtifact("https://example.com/OpenAI.srs")).toBe(false);
    const plan = planRuleSets({
      route: {
        rule_set: [
          { tag: "Adjacent", type: "remote", url: `${RULES_URL}-backup/OpenAI.srs` },
          { tag: "Nested", type: "remote", url: `${RULES_URL}/nested/OpenAI.srs` },
        ],
      },
    });
    expect(plan.every((p) => p.external)).toBe(true);
    expect(plan.map((p) => p.path)).toEqual(["external/0.srs", "external/1.srs"]);
  });

  test("同 basename 的不同来源不共享路径（外部/外部、仓库/外部）", () => {
    const plan = planRuleSets({
      route: {
        rule_set: [
          { tag: "A B", type: "remote", url: "https://example.com/one.srs" },
          { tag: "A/B", type: "remote", url: "https://example.com/two.srs" },
          { tag: "Repo", type: "remote", url: `${RULES_URL}/A_B.srs` },
        ],
      },
    });
    const paths = plan.map((p) => p.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths[0]).toBe("external/0.srs");
    expect(paths[1]).toBe("external/1.srs");
    expect(paths[2]).toBe("rules/A_B.srs");
  });
});

describe("verifyLocalArtifacts：仓库产物缺失时点名", () => {
  test("本地 generated/singbox/ 没有对应文件即报错", () => {
    expect(() =>
      verifyLocalArtifacts([
        {
          tag: "Missing",
          url: `${RULES_URL}/DefinitelyNotBuilt.srs`,
          external: false,
          path: "rules/DefinitelyNotBuilt.srs",
        },
      ]),
    ).toThrow(/检查本地规则产物/);
  });
});

describe("localizeRuleSets：远程 → 本地，缺映射报 tag", () => {
  const cfg = { route: { rule_set: [
    { type: "remote", tag: "A", format: "binary", url: "https://x/a.srs" },
    { type: "local", tag: "B", format: "binary", path: "/b.srs" },
  ] }, experimental: { clash_api: { external_controller: "127.0.0.1:9090" }, cache_file: { enabled: true } } };

  test("按映射改写远程，保留本地，去掉 clash_api", () => {
    const out = localizeRuleSets(cfg, { A: "/work/sing-box/external/0.srs" });
    expect(out.route.rule_set[0]).toEqual({ type: "local", tag: "A", format: "binary", path: "/work/sing-box/external/0.srs" });
    expect(out.route.rule_set[1]).toEqual(cfg.route.rule_set[1]);
    expect(out.experimental.clash_api).toBeUndefined();
    expect(out.experimental.cache_file).toEqual({ enabled: true });
  });

  test("缺映射时抛错并带 tag", () => {
    expect(() => localizeRuleSets(cfg, {})).toThrow(/规则集 A 没有本地映射/);
  });
});
