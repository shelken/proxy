// 中国移动签到有礼 capture.js 测试（bun:test）
// seams: shouldUpdateToken
// 运行: just test capture  或  bun test config/loon/plugins/cmcc-sign/capture.test.js

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 从同目录 capture.js 提取纯函数（不执行 Loon 环境代码）
// 纯函数在 "===== Loon 环境适配 =====" 注释之前
const src = readFileSync(join(__dirname, "capture.js"), "utf8");
const pure = src.split("// ===== Loon 环境适配 =====")[0];

const factory = new Function(pure + "\nreturn { shouldUpdateToken };");
const { shouldUpdateToken } = factory();

// ===== shouldUpdateToken: token 去重（防重复提取/通知） =====
test("shouldUpdateToken: 首次（无旧值）需要更新", () => {
  expect(shouldUpdateToken("TOKEN1", null)).toBe(true);
});

test("shouldUpdateToken: 与旧值相同则不更新（静默）", () => {
  expect(shouldUpdateToken("TOKEN1", "TOKEN1")).toBe(false);
});

test("shouldUpdateToken: 与旧值不同则更新（重新登录）", () => {
  expect(shouldUpdateToken("TOKEN2", "TOKEN1")).toBe(true);
});

test("shouldUpdateToken: 空 token 不更新", () => {
  expect(shouldUpdateToken("", "TOKEN1")).toBe(false);
  expect(shouldUpdateToken(null, "TOKEN1")).toBe(false);
  expect(shouldUpdateToken(undefined, "TOKEN1")).toBe(false);
});
