import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cleanOwnedArtifacts, extractRealInput } from "./sandbox-loop.ts";
import { parseEnv, readSingBoxVersion } from "./sandbox.ts";

describe("cleanOwnedArtifacts：只清自己的产物", () => {
  test("保留 review/verification/rework 证据", () => {
    const dir = mkdtempSync(join(tmpdir(), "artifacts-"));
    try {
      for (const name of ["review", "verification", "rework"]) mkdirSync(join(dir, name));
      for (const name of ["sbtools", "commit", "sandbox-rules", "sbtools-aarch64-unknown-linux-musl"]) {
        mkdirSync(join(dir, name));
      }
      cleanOwnedArtifacts(dir);
      expect(readdirSync(dir).sort()).toEqual(["review", "rework", "verification"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

describe("sandbox helpers", () => {
  test("parseEnv 解析引号与注释", () => {
    expect(parseEnv('# comment\nA="hello"\nB=\'world\'\nC=plain\n')).toEqual({
      A: "hello",
      B: "world",
      C: "plain",
    });
  });

  test("readSingBoxVersion 能读取 .mise.toml 声明的内核版本", () => {
    expect(readSingBoxVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
