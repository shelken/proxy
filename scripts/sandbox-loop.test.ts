#!/usr/bin/env bun
// 沙箱引导的产物选择逻辑单测。
//
// 只驱动纯函数（不碰网络、不碰 VM），因此可在宿主机直接跑。
// 用法：bun test scripts/sandbox-loop.test.ts

import { describe, expect, test } from "bun:test";
import { chooseArtifact, selectArtifactRuns } from "./sandbox-loop.ts";

/** 构造 artifacts API 的响应形状（只含被测字段）。 */
function apiResponse(
  artifacts: { runId: number; sha: string; expired?: boolean }[],
): string {
  return JSON.stringify({
    artifacts: artifacts.map((a) => ({
      expired: a.expired ?? false,
      workflow_run: { id: a.runId, head_sha: a.sha },
    })),
  });
}

describe("selectArtifactRuns", () => {
  test("取出 run id 与 sha，顺序保持 API 返回顺序（新→旧）", () => {
    const runs = selectArtifactRuns(
      apiResponse([
        { runId: 300, sha: "newest" },
        { runId: 200, sha: "middle" },
        { runId: 100, sha: "oldest" },
      ]),
    );
    expect(runs).toEqual([
      { databaseId: 300, headSha: "newest" },
      { databaseId: 200, headSha: "middle" },
      { databaseId: 100, headSha: "oldest" },
    ]);
  });

  test("过期产物被排除", () => {
    const runs = selectArtifactRuns(
      apiResponse([
        { runId: 300, sha: "expired", expired: true },
        { runId: 200, sha: "live" },
      ]),
    );
    expect(runs).toEqual([{ databaseId: 200, headSha: "live" }]);
  });

  test("无产物时返回空列表而不是抛错", () => {
    expect(selectArtifactRuns('{"artifacts":[]}')).toEqual([]);
  });

  test("响应缺少 artifacts 数组时硬失败，不当成空列表", () => {
    expect(() => selectArtifactRuns('{"message":"Not Found"}')).toThrow(/artifacts 数组/);
  });

  test("产物记录缺 workflow_run.id/head_sha 时硬失败", () => {
    expect(() => selectArtifactRuns('{"artifacts":[{"expired":false}]}')).toThrow(
      /workflow_run/,
    );
  });
});

describe("chooseArtifact", () => {
  const noDiff = () => "";

  test("有 headSha 精确相同的构建时直接选中，不看差异", () => {
    const runs = [
      { databaseId: 300, headSha: "abc" },
      { databaseId: 200, headSha: "def" },
    ];
    expect(chooseArtifact(runs, "def", noDiff)).toEqual({
      chosen: { databaseId: 200, headSha: "def" },
      exact: true,
    });
  });

  test("HEAD 无构建时回退到首个产物等价的构建，标记为非精确", () => {
    const runs = [
      { databaseId: 300, headSha: "differs" },
      { databaseId: 200, headSha: "same" },
    ];
    // 只有 "same" 与被测代码等价
    const diffOf = (from: string) => (from === "same" ? "" : "scripts/sb-sync-rs/x.rs");
    expect(chooseArtifact(runs, "head", diffOf)).toEqual({
      chosen: { databaseId: 200, headSha: "same" },
      exact: false,
    });
  });

  test("候选里没有精确也没有等价时返回 null", () => {
    const runs = [{ databaseId: 300, headSha: "differs" }];
    expect(chooseArtifact(runs, "head", () => "scripts/sb-sync-rs/x.rs")).toBeNull();
  });

  test("空候选返回 null", () => {
    expect(chooseArtifact([], "head", noDiff)).toBeNull();
  });
});
