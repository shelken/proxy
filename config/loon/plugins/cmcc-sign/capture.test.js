// 中国移动签到有礼 capture.js 测试（bun:test）
// seams: extractAppCookie / shouldUpdateCookie
// 运行: just test capture  或  bun test config/loon/plugins/cmcc-sign/capture.test.js

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 从同目录 capture.js 提取纯函数（不执行 Loon 环境代码）
// 纯函数在 "===== Loon 环境适配 =====" 注释之前
const src = readFileSync(join(__dirname, "capture.js"), "utf8");
const pure = src.split("// ===== Loon 环境适配 =====")[0];

const factory = new Function(pure + "\nreturn { extractAppCookie, shouldUpdateCookie };");
const { extractAppCookie, shouldUpdateCookie } = factory();

// ===== extractAppCookie: 从请求头提取 app 域登录态 cookie =====
test("extractAppCookie: 合并多个 cookie 行且只保留登录态 cookie", () => {
  const headers = {
    "cookie": "JSESSIONID=abc; UID=def; yx=999; gdp_session_id=xyz",
    "Cookie": "Comment=SessionServer-unity; ticketID=POD9",
  };
  const c = extractAppCookie(headers);
  expect(c).toContain("JSESSIONID=abc");
  expect(c).toContain("UID=def");
  expect(c).toContain("Comment=SessionServer-unity");
  expect(c).toContain("ticketID=POD9");
  // 无关 cookie 被过滤
  expect(c).not.toContain("yx");
  expect(c).not.toContain("gdp_session_id");
});

test("extractAppCookie: 按固定顺序输出，顺序无关时结果恒定", () => {
  const h1 = { "cookie": "ticketID=POD9; JSESSIONID=abc; UID=def" };
  const h2 = { "cookie": "UID=def; JSESSIONID=abc; ticketID=POD9" };
  expect(extractAppCookie(h1)).toBe(extractAppCookie(h2));
});

test("extractAppCookie: 无关键 cookie 时返回空串", () => {
  expect(extractAppCookie({ "cookie": "yx=123" })).toBe("");
  expect(extractAppCookie({})).toBe("");
  expect(extractAppCookie(null)).toBe("");
});

// ===== shouldUpdateCookie: 去重（防重复通知） =====
test("shouldUpdateCookie: 首次（无旧值）需要更新", () => {
  expect(shouldUpdateCookie("COOKIE1", null)).toBe(true);
});

test("shouldUpdateCookie: 与旧值相同则不更新（静默）", () => {
  expect(shouldUpdateCookie("COOKIE1", "COOKIE1")).toBe(false);
});

test("shouldUpdateCookie: 与旧值不同则更新（重新登录）", () => {
  expect(shouldUpdateCookie("COOKIE2", "COOKIE1")).toBe(true);
});

test("shouldUpdateCookie: 空 cookie 不更新", () => {
  expect(shouldUpdateCookie("", "COOKIE1")).toBe(false);
  expect(shouldUpdateCookie(null, "COOKIE1")).toBe(false);
  expect(shouldUpdateCookie(undefined, "COOKIE1")).toBe(false);
});
