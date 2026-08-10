// 中国移动签到有礼 sign.js 测试（bun:test）
// seams: parseUserInfo / parseDomark / parseMarkstatus / runSign / shouldSign / markSigned
// 运行: just test sign  或  bun test config/loon/plugins/cmcc-sign/sign.test.js

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 从同目录 sign.js 提取纯函数（不执行 Loon 环境代码）
// 纯函数在 "===== Loon 环境适配 =====" 注释之前
const src = readFileSync(join(__dirname, "sign.js"), "utf8");
const pure = src.split("// ===== Loon 环境适配 =====")[0];

// 供测试使用的依赖注入环境
global.$notification = { post: () => {} };
global.$done = () => {};
// eval 声明在模块作用域不暴露，用 new Function 求值并返回函数
const factory = new Function(pure + "\nreturn { parseUserInfo, parseDomark, parseMarkstatus, runSign, buildHeaders, shouldSign, markSigned };");
const { parseUserInfo, parseDomark, parseMarkstatus, runSign, buildHeaders, shouldSign, markSigned } = factory();

// ===== parseUserInfo: user/info 响应解析 + 登录态判断 =====
test("parseUserInfo: SUCCESS 返回已登录+昵称", () => {
  const r = parseUserInfo('{"code":"SUCCESS","data":{"nickName":"138****8888"}}');
  expect(r.ok).toBe(true);
  expect(r.nick).toBe("138****8888");
});

test("parseUserInfo: FAILED 返回未登录", () => {
  const r = parseUserInfo('{"code":"FAILED","msg":"登录失效","success":false}');
  expect(r.ok).toBe(false);
});

test("parseUserInfo: 解析异常返回未登录不抛错", () => {
  const r = parseUserInfo("not json");
  expect(r.ok).toBe(false);
});

test("parseUserInfo: 无 nickName 时 ok 仍为 true", () => {
  const r = parseUserInfo('{"code":"SUCCESS","data":{}}');
  expect(r.ok).toBe(true);
  expect(r.nick).toBe("");
});

// ===== parseDomark: domark 响应解析 =====
test("parseDomark: SUCCESS 返回 success", () => {
  expect(parseDomark('{"code":"SUCCESS","msg":"成功"}')).toBe("success");
});

test("parseDomark: HAVE_MARKED 返回 marked", () => {
  expect(
    parseDomark('{"code":"FAILED","msg":"今日已签到过","status":"HAVE_MARKED"}')
  ).toBe("marked");
});

test("parseDomark: 其他 FAILED 返回 fail", () => {
  expect(parseDomark('{"code":"FAILED","msg":"错误"}')).toBe("fail");
});

test("parseDomark: 解析异常返回 fail 不抛错", () => {
  expect(parseDomark("not json")).toBe("fail");
});

// ===== parseMarkstatus: 本月已签天数 =====
test("parseMarkstatus: status=1 计数为已签天数", () => {
  const body = JSON.stringify({
    code: "SUCCESS",
    data: { markstatus: [
      { date: "20260801", status: "0" },
      { date: "20260802", status: "1" },
      { date: "20260803", status: "1" },
    ]},
  });
  expect(parseMarkstatus(body)).toBe(2);
});

test("parseMarkstatus: 无 markstatus 或解析失败返回 0", () => {
  expect(parseMarkstatus('{"code":"SUCCESS","data":{}}')).toBe(0);
  expect(parseMarkstatus("bad")).toBe(0);
});

// ===== buildHeaders: 动态 header 优先 + fallback + token 覆盖 =====
test("buildHeaders: 动态 header 存在时优先使用", () => {
  const saved = { "User-Agent": "UA-FROM-CAPTURE", "Origin": "https://wx.10086.cn", "login-check": "1" };
  const h = buildHeaders("TOKEN1", saved);
  expect(h["User-Agent"]).toBe("UA-FROM-CAPTURE");
  expect(h["login-check"]).toBe("1");
});

test("buildHeaders: 动态 header 缺失时 fallback 写死值", () => {
  const h = buildHeaders("TOKEN1", null);
  expect(h["User-Agent"]).toContain("iPhone");
  expect(h["login-check"]).toBe("1");
});

test("buildHeaders: fallback UA 不含真实设备信息（无 iOS 版本号）", () => {
  const h = buildHeaders("TOKEN1", null);
  expect(h["User-Agent"]).not.toMatch(/iOS \d+_\d+/);
  expect(h["User-Agent"]).not.toContain("leadeon");
  expect(h["User-Agent"]).not.toContain("CMCCIT");
});

test("buildHeaders: 动态 header 中 Cookie 被最新 token 覆盖", () => {
  const saved = { "Cookie": "QWHD_SESSION_TOKEN=OLD; yx=1", "User-Agent": "UA" };
  const h = buildHeaders("NEWTOKEN", saved);
  expect(h["Cookie"]).toBe("QWHD_SESSION_TOKEN=NEWTOKEN");
});

test("buildHeaders: 部分缺字段时合并 fallback", () => {
  const saved = { "User-Agent": "UA2" };
  const h = buildHeaders("T", saved);
  expect(h["User-Agent"]).toBe("UA2");
  expect(h["login-check"]).toBe("1");
  expect(h["Content-Type"]).toContain("json");
});

// ===== runSign: 编排（domark 调用次数）=====
function makeApi() {
  const calls = [];
  return {
    calls,
    api: (url, headers, body, cb) => {
      calls.push({ url, headers, body });
      // 默认响应：按 url 路由
      if (url.includes("user/info")) cb(null, {}, '{"code":"SUCCESS","data":{"nickName":"测试"}}');
      else if (url.includes("domark")) cb(null, {}, '{"code":"SUCCESS","msg":"成功"}');
      else if (url.includes("markstatus")) cb(null, {}, '{"code":"SUCCESS","data":{"markstatus":[]}}');
      else cb("unknown", null, "");
    },
  };
}

test("runSign: 成功时 domark 恰好调用 1 次", (done) => {
  const { api, calls } = makeApi();
  const notifs = [];
  runSign(api, "TOKEN", "20260810", { notify: (t, s, c) => notifs.push([t, s, c]) }, () => {
    const domarks = calls.filter((c) => c.url.includes("domark"));
    expect(domarks.length).toBe(1);
    expect(domarks[0].body.date).toBe("20260810");
    done();
  });
});

test("runSign: user/info 失败时 domark 调用 0 次", (done) => {
  let domarkCalls = 0;
  const api = (url, h, b, cb) => {
    if (url.includes("user/info")) cb(null, {}, '{"code":"FAILED","msg":"登录失效"}');
    else if (url.includes("domark")) { domarkCalls++; cb(null, {}, '{"code":"SUCCESS"}'); }
    else cb(null, {}, "{}");
  };
  const notifs = [];
  runSign(api, "TOKEN", "20260810", { notify: (t, s, c) => notifs.push([t, s, c]) }, () => {
    expect(domarkCalls).toBe(0);
    done();
  });
});

test("runSign: 成功时通知包含本月已签天数", (done) => {
  const api = (url, h, b, cb) => {
    if (url.includes("user/info")) cb(null, {}, '{"code":"SUCCESS","data":{"nickName":"测试"}}');
    else if (url.includes("domark")) cb(null, {}, '{"code":"SUCCESS"}');
    else if (url.includes("markstatus")) cb(null, {}, '{"code":"SUCCESS","data":{"markstatus":[{"status":"1"},{"status":"1"},{"status":"0"}]}}');
    else cb(null, {}, "{}");
  };
  const notifs = [];
  runSign(api, "TOKEN", "20260810", { notify: (t, s, c) => notifs.push([t, s, c]) }, () => {
    expect(notifs.length).toBe(1);
    expect(notifs[0][2]).toContain("本月已签 2 天");
    done();
  });
});

// ===== shouldSign / markSigned: 同日幂等去重 =====
function makeStore(init) {
  const data = { ...init };
  return {
    read: (k) => (k in data ? data[k] : null),
    write: (v, k) => { data[k] = v; },
    data,
  };
}

test("shouldSign: 首次（无记录）不跳过", () => {
  const store = makeStore({});
  const r = shouldSign("20260810", store);
  expect(r.skip).toBe(false);
});

test("shouldSign: 同日已签则跳过", () => {
  const store = makeStore({ cmcc_sign_last: "20260810" });
  const r = shouldSign("20260810", store);
  expect(r.skip).toBe(true);
});

test("shouldSign: 非同日（跨天）不跳过", () => {
  const store = makeStore({ cmcc_sign_last: "20260809" });
  const r = shouldSign("20260810", store);
  expect(r.skip).toBe(false);
});

test("markSigned: 写入当日日期", () => {
  const store = makeStore({});
  markSigned("20260810", store);
  expect(store.read("cmcc_sign_last")).toBe("20260810");
});
