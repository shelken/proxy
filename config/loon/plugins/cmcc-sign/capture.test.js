// 中国移动签到有礼 capture.js 测试（bun:test）
// seams: extractAutoLoginSnapshot / shouldUpdateSnapshot
// 运行: just test capture  或  bun test config/loon/plugins/cmcc-sign/capture.test.js

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 从同目录 capture.js 提取纯函数（不执行 Loon 环境代码）
// 纯函数在 "===== Loon 环境适配 =====" 注释之前
const src = readFileSync(join(__dirname, "capture.js"), "utf8");
const pure = src.split("// ===== Loon 环境适配 =====")[0];

const factory = new Function(pure + "\nreturn { extractAutoLoginSnapshot, shouldUpdateSnapshot };");
const { extractAutoLoginSnapshot, shouldUpdateSnapshot } = factory();

// ===== extractAutoLoginSnapshot: 从请求上下文提取可重放快照 =====
test("extractAutoLoginSnapshot: 保留关键签名头与 body", () => {
  const snap = extractAutoLoginSnapshot(
    "https://client.app.coc.10086.cn/biz-orange/LN/uamonekeylogin/autoLogin",
    {
      "Content-Type": "application/Json",
      "x-qen": "14",
      "xs": "abc",
      "x-sign": "def",
      "x-nonce": "1234",
      "x-token": "TOKEN",
      "x-time": "1786525834070",
      "User-Agent": "ChinaMobile/12.5.2",
      "Cookie": "JSESSIONID=abc; UID=def",
      "Content-Length": "1496",
      "Accept-Encoding": "deflate",
    },
    "ENCRYPTED_BODY"
  );
  expect(snap.url).toBe("https://client.app.coc.10086.cn/biz-orange/LN/uamonekeylogin/autoLogin");
  expect(snap.headers["x-sign"]).toBe("def");
  expect(snap.headers["x-token"]).toBe("TOKEN");
  expect(snap.headers["Cookie"]).toBe("JSESSIONID=abc; UID=def");
  expect(snap.body).toBe("ENCRYPTED_BODY");
  // 干扰头被剔除
  expect(snap.headers["Content-Length"]).toBeUndefined();
  expect(snap.headers["Accept-Encoding"]).toBeUndefined();
});

test("extractAutoLoginSnapshot: 无 url 或 headers 返回 null", () => {
  expect(extractAutoLoginSnapshot(null, {}, "")).toBeNull();
  expect(extractAutoLoginSnapshot("https://x.com", null, "")).toBeNull();
});

// ===== shouldUpdateSnapshot: 去重（防重复通知） =====
test("shouldUpdateSnapshot: 首次（无旧快照）需要更新", () => {
  const snap = { url: "https://x.com", headers: {}, body: "b" };
  expect(shouldUpdateSnapshot(snap, null)).toBe(true);
});

test("shouldUpdateSnapshot: 与旧快照相同则不更新（静默）", () => {
  const snap = { url: "https://x.com", headers: { "x-sign": "s" }, body: "b" };
  expect(shouldUpdateSnapshot(snap, JSON.parse(JSON.stringify(snap)))).toBe(false);
});

test("shouldUpdateSnapshot: 与旧快照不同则更新（重新登录）", () => {
  const snap = { url: "https://x.com", headers: { "x-sign": "s2" }, body: "b" };
  const old = { url: "https://x.com", headers: { "x-sign": "s1" }, body: "b" };
  expect(shouldUpdateSnapshot(snap, old)).toBe(true);
});

test("shouldUpdateSnapshot: 空快照不更新", () => {
  expect(shouldUpdateSnapshot(null, {})).toBe(false);
  expect(shouldUpdateSnapshot({ url: "", headers: {}, body: "" }, {})).toBe(false);
});
