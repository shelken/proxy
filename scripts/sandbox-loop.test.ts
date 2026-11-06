import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractRealInput, planRuleSets, localizeRuleSets, isRepoArtifact } from "./sandbox-loop.ts";
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

describe("extractRealInput", () => {
  test("提取带引号与不带引号的 nodes/subs 列表项", () => {
    const input = [
      "subs:",
      '  - "https://sub.example.com/token"',
      "nodes:",
      '  - "hy2://pass@192.0.2.1:8388?sni=example.com#selfhost-jp"',
      "  - hy2://pass@192.0.2.2:8388#selfhost-hk",
      "overlay: |",
      '  {"log":{"level":"debug"}}',
    ].join("\n");
    const r = extractRealInput(input);
    expect(r.subs).toEqual(["https://sub.example.com/token"]);
    expect(r.nodes).toHaveLength(2);
    expect(r.nodes[0]).toContain("#selfhost-jp");
  });

  test("无 nodes/subs 键时返回空列表，不误收 overlay 内容", () => {
    const r = extractRealInput('overlay: |\n  {"nodes":["fake"]}');
    expect(r.nodes).toEqual([]);
    expect(r.subs).toEqual([]);
  });

  test("列表项含非字符串（畸形配置）时过滤掉", () => {
    const r = extractRealInput("nodes:\n  - \"hy2://ok#tag\"\n  - 42\n  - null");
    expect(r.nodes).toEqual(["hy2://ok#tag"]);
  });
});

test("沙箱引导拒绝无法核对的二进制输入", () => {
  const root = mkdtempSync(join(tmpdir(), "sandbox-inputs-"));
  try {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
    );
    const git = (...args: string[]): string => {
      const result = Bun.spawnSync(
        ["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
        { cwd: root, env },
      );
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      return result.stdout.toString().trim();
    };
    mkdirSync(join(root, "scripts/sbtools-rs/src"), { recursive: true });
    mkdirSync(join(root, "config/sing-box"), { recursive: true });
    copyFileSync(join(import.meta.dir, "sandbox-loop.ts"), join(root, "scripts/sandbox-loop.ts"));
    copyFileSync(join(import.meta.dir, "settings.ts"), join(root, "scripts/settings.ts"));
    writeFileSync(join(root, "scripts/sbtools-rs/src/main.rs"), "fn main() {}\n");
    writeFileSync(join(root, "config/sing-box/template.json"), JSON.stringify({
      route: { rule_set: [{ tag: "fixture", type: "remote", url: "https://raw.githubusercontent.com/shelken/proxy/sing-box-rules/singbox/fixture.srs" }] },
    }));
    git("init", "-q");
    git("add", ".");
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture");
    mkdirSync(join(root, ".sandbox-artifacts"));
    writeFileSync(join(root, ".sandbox-artifacts/commit"), git("rev-parse", "HEAD"));
    writeFileSync(join(root, ".sandbox-artifacts/sbtools"), "unused fixture\n");

    const run = () => Bun.spawnSync(
      [process.execPath, "run", "scripts/sandbox-loop.ts"], { cwd: root, env },
    );
    mkdirSync(join(root, "scripts/sbtools-rs/tests"));
    writeFileSync(join(root, "scripts/sbtools-rs/README.md"), "documentation\n");
    writeFileSync(join(root, "scripts/sbtools-rs/CHANGELOG.md"), "changes\n");
    writeFileSync(join(root, "scripts/sbtools-rs/tests/check.rs"), "#[test]\nfn check() {}\n");
    const docs = run();
    expect(docs.exitCode).toBe(1);
    expect(docs.stderr.toString()).toContain("检查本地规则产物");

    git("add", "scripts/sbtools-rs/README.md", "scripts/sbtools-rs/CHANGELOG.md", "scripts/sbtools-rs/tests");
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "docs and tests");
    const committedDocs = run();
    expect(committedDocs.exitCode).toBe(1);
    expect(committedDocs.stderr.toString()).toContain("检查本地规则产物");

    const source = join(root, "scripts/sbtools-rs/src/extra.rs");
    writeFileSync(source, "pub const EXTRA: bool = true;\n");
    const dirtySource = run();
    expect(dirtySource.exitCode).toBe(1);
    expect(dirtySource.stderr.toString()).toContain("二进制输入未提交");
    expect(dirtySource.stderr.toString()).toContain("src/extra.rs");
    rmSync(source);

    writeFileSync(join(root, ".git/index"), "invalid index\n");
    const result = run();
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("检查二进制输入");
    expect(result.stdout.toString()).not.toContain("复用已下载产物");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
