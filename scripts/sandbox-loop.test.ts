import { describe, expect, test } from "bun:test";

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
