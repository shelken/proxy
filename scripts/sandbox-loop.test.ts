import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractRealInput } from "./sandbox-loop.ts";

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
    writeFileSync(join(root, "scripts/sbtools-rs/src/main.rs"), "fn main() {}\n");
    writeFileSync(join(root, "config/sing-box/template.json"), JSON.stringify({
      route: { rule_set: [{ tag: "fixture" }] },
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
