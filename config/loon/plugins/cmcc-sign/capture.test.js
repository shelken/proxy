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

const factory = new Function(pure + "\nreturn { extractAutoLoginSnapshot, addSnapshot };");
const { extractAutoLoginSnapshot, addSnapshot } = factory();

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

// ===== addSnapshot: 去重并保留最近 3 条 =====
test("addSnapshot: 新快照写入捕获时间", () => {
  const snap = { url: "https://x.com", headers: {}, body: "b" };
  const result = addSnapshot(snap, null, 3_600_000);
  expect(result.updated).toBe(true);
  expect(result.snapshots).toEqual([{ ...snap, capturedAt: 3_600_000 }]);
});

test("addSnapshot: 相同快照静默", () => {
  const snap = { url: "https://x.com", headers: { "x-sign": "s" }, body: "b" };
  const result = addSnapshot(snap, [{ ...snap, capturedAt: 1_000 }], 2_000);
  expect(result.updated).toBe(false);
  expect(result.snapshots).toEqual([{ ...snap, capturedAt: 1_000 }]);
});

test("addSnapshot: 只保留最近 3 条", () => {
  let stored = null;
  for (let i = 1; i <= 4; i++) {
    stored = addSnapshot({ url: "https://x.com", headers: {}, body: "b" + i }, stored, i * 1_000).snapshots;
  }
  expect(stored.map((item) => item.body)).toEqual(["b4", "b3", "b2"]);
});

test("addSnapshot: 兼容旧的单快照格式", () => {
  const old = { url: "https://x.com", headers: { "x-time": "1000" }, body: "old" };
  const result = addSnapshot({ url: "https://x.com", headers: {}, body: "new" }, old, 2_000);
  expect(result.snapshots.map((item) => [item.body, item.capturedAt])).toEqual([["new", 2_000], ["old", 1_000]]);
});
