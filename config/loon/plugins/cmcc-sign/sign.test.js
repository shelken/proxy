// 中国移动签到有礼 sign.js 测试（bun:test）
// seams: parseSid / parseAppToken / parseUserInfo / parseDomark / parseMarkstatus / buildHeaders / runSign / shouldSign / markSigned
// 运行: just test sign  或  bun test config/loon/plugins/cmcc-sign/sign.test.js

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 从同目录 sign.js 提取纯函数（不执行 Loon 环境代码）
// 纯函数在 "===== Loon 环境适配 =====" 注释之前
const src = readFileSync(join(__dirname, "sign.js"), "utf8");
const pure = src.split("// ===== Loon 环境适配 =====")[0];

const factory = new Function(pure + "\nreturn { parseSid, parseAppToken, parseUserInfo, parseDomark, parseMarkstatus, buildHeaders, runSign, shouldSign, markSigned };");
const { parseSid, parseAppToken, parseUserInfo, parseDomark, parseMarkstatus, buildHeaders, runSign, shouldSign, markSigned } = factory();
// ===== parseSid: 从登录页 HTML 解析 sid =====
test("parseSid: 从 HTML 提取 sid", () => {
  const html = '<script>var loginPath = "/appTokenLogin?sid=SID20260811T004612625TEST1021122301abc123"</script>';
  expect(parseSid(html)).toBe("SID20260811T004612625TEST1021122301abc123");
});

test("parseSid: 无 sid 返回空串", () => {
  expect(parseSid("<html>no sid</html>")).toBe("");
});

// ===== parseAppToken: appTokenLogin 响应解析 =====
test("parseAppToken: SUCCESS 返回 url", () => {
  const r = parseAppToken('{"code":"SUCCESS","data":{"url":"https://wx.10086.cn/qwhdhub/qwhdmark/1021122301?token=ABC"}}');
  expect(r.ok).toBe(true);
  expect(r.url).toContain("token=ABC");
});

test("parseAppToken: 失败/异常返回 not ok", () => {
  expect(parseAppToken('{"code":"FAILED"}').ok).toBe(false);
  expect(parseAppToken("bad").ok).toBe(false);
});

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

// ===== buildHeaders: 完整 cookie jar + leadeon UA + Referer =====
test("buildHeaders: 含 yx+session cookie、leadeon UA、完整 Referer", () => {
  const h = buildHeaders("yx=123; QWHD_SESSION_TOKEN=S1", "https://wx.10086.cn/qwhdhub/qwhdmark/1021122301?token=ABC");
  expect(h["Cookie"]).toContain("QWHD_SESSION_TOKEN=S1");
  expect(h["Cookie"]).toContain("yx=123");
  expect(h["Referer"]).toContain("token=ABC");
  expect(h["User-Agent"]).not.toMatch(/iOS \d+_\d+/);
  expect(h["User-Agent"]).not.toContain("CMCCIT/12");
  expect(h["login-check"]).toBe("1");
});

// ===== runSign: 编排（完整链路调用顺序） =====
function makeApi() {
  const calls = [];
  const api = (url, headers, body, cb) => {
    calls.push({ url, headers, body });
    if (url.includes("qwhdsso/login")) {
      cb(null, {}, '<script>loginPath="/appTokenLogin?sid=SID123"</script>');
    } else if (url.includes("appTokenLogin")) {
      cb(null, {}, '{"code":"SUCCESS","data":{"url":"https://wx.10086.cn/qwhdhub/qwhdmark/1021122301?token=QWHDSSOX"}}');
    } else if (url.includes("qwhdmark/1021122301?token=") && !url.includes("/api/")) {
      cb(null, { headers: { "set-cookie": ["yx=123;Max-Age=300;path=/", "QWHD_SESSION_TOKEN=SESSION1;Max-Age=1800;path=/;HttpOnly"] } }, "");
    } else if (url.includes("user/info")) {
      cb(null, {}, '{"code":"SUCCESS","data":{"nickName":"测试"}}');
    } else if (url.includes("domark")) {
      cb(null, {}, '{"code":"SUCCESS","msg":"成功"}');
    } else if (url.includes("markstatus")) {
      cb(null, {}, '{"code":"SUCCESS","data":{"markstatus":[]}}');
    } else {
      cb("unknown", null, "");
    }
  };
  return { calls, api };
}

test("runSign: 完整链路按序调用 login→appToken→活动页→info→domark→markstatus", (done) => {
  const { calls, api } = makeApi();
  const notifs = [];
  runSign(api, "APP_COOKIE", "20260810", { notify: (t, s, c) => notifs.push([t, s, c]) }, () => {
    const urls = calls.map((c) => c.url);
    expect(urls[0]).toContain("qwhdsso/login");
    expect(urls[1]).toContain("appTokenLogin?sid=SID123");
    expect(urls[2]).toContain("qwhdmark/1021122301?token=");
    expect(urls[3]).toContain("user/info");
    expect(urls[4]).toContain("domark");
    expect(urls[5]).toContain("markstatus");
    // appTokenLogin body 只含 token（app 域登录态）
    expect(calls[1].body.token).toBe("APP_COOKIE");
    // domark body 日期正确
    expect(calls[4].body.date).toBe("20260810");
    // 业务请求 cookie 含 yx + session
    expect(calls[3].headers.Cookie).toContain("yx=123");
    expect(calls[3].headers.Cookie).toContain("QWHD_SESSION_TOKEN=SESSION1");
    done();
  });
});

test("runSign: 解析 sid 失败时不再继续（appToken 不被调用）", (done) => {
  const calls = [];
  const api = (url, h, b, cb) => {
    calls.push(url);
    if (url.includes("qwhdsso/login")) cb(null, {}, "<html>no sid</html>");
    else cb(null, {}, "{}");
  };
  const notifs = [];
  runSign(api, "APP_COOKIE", "20260810", { notify: (t, s, c) => notifs.push([t, s, c]) }, () => {
    expect(calls.length).toBe(1);
    expect(notifs.length).toBe(1);
    expect(notifs[0][1]).toContain("自动续期失败");
    done();
  });
});

test("runSign: appToken 失败时通知登录态失效", (done) => {
  const calls = [];
  const api = (url, h, b, cb) => {
    calls.push(url);
    if (url.includes("qwhdsso/login")) cb(null, {}, '<script>loginPath="/appTokenLogin?sid=SID123"</script>');
    else if (url.includes("appTokenLogin")) cb(null, {}, '{"code":"FAILED","msg":"失败"}');
    else cb(null, {}, "{}");
  };
  const notifs = [];
  runSign(api, "APP_COOKIE", "20260810", { notify: (t, s, c) => notifs.push([t, s, c]) }, () => {
    expect(calls.length).toBe(2);
    expect(notifs[0][1]).toContain("自动续期失败");
    done();
  });
});

test("runSign: user/info 失败时 domark 调用 0 次", (done) => {
  let domarkCalls = 0;
  const api = (url, h, b, cb) => {
    if (url.includes("qwhdsso/login")) cb(null, {}, '<script>loginPath="/appTokenLogin?sid=SID123"</script>');
    else if (url.includes("appTokenLogin")) cb(null, {}, '{"code":"SUCCESS","data":{"url":"https://wx.10086.cn/qwhdhub/qwhdmark/1021122301?token=QWHDSSOX"}}');
    else if (url.includes("qwhdmark/1021122301?token=")) cb(null, { headers: { "set-cookie": ["yx=123;Max-Age=300;path=/", "QWHD_SESSION_TOKEN=SESSION1;Max-Age=1800;path=/;HttpOnly"] } }, "");
    else if (url.includes("user/info")) cb(null, {}, '{"code":"FAILED","msg":"登录失效"}');
    else if (url.includes("domark")) { domarkCalls++; cb(null, {}, '{"code":"SUCCESS"}'); }
    else cb(null, {}, "{}");
  };
  const notifs = [];
  runSign(api, "APP_COOKIE", "20260810", { notify: (t, s, c) => notifs.push([t, s, c]) }, () => {
    expect(domarkCalls).toBe(0);
    done();
  });
});

test("runSign: 成功时通知包含本月已签天数", (done) => {
  const api = (url, h, b, cb) => {
    if (url.includes("qwhdsso/login")) cb(null, {}, '<script>loginPath="/appTokenLogin?sid=SID123"</script>');
    else if (url.includes("appTokenLogin")) cb(null, {}, '{"code":"SUCCESS","data":{"url":"https://wx.10086.cn/qwhdhub/qwhdmark/1021122301?token=QWHDSSOX"}}');
    else if (url.includes("qwhdmark/1021122301?token=")) cb(null, { headers: { "set-cookie": ["yx=123;Max-Age=300;path=/", "QWHD_SESSION_TOKEN=SESSION1;Max-Age=1800;path=/;HttpOnly"] } }, "");
    else if (url.includes("user/info")) cb(null, {}, '{"code":"SUCCESS","data":{"nickName":"测试"}}');
    else if (url.includes("domark")) cb(null, {}, '{"code":"SUCCESS"}');
    else if (url.includes("markstatus")) cb(null, {}, '{"code":"SUCCESS","data":{"markstatus":[{"status":"1"},{"status":"1"},{"status":"0"}]}}');
    else cb(null, {}, "{}");
  };
  const notifs = [];
  runSign(api, "APP_COOKIE", "20260810", { notify: (t, s, c) => notifs.push([t, s, c]) }, (r) => {
    expect(notifs.length).toBe(1);
    expect(notifs[0][2]).toContain("本月已签 2 天");
    expect(r.signed).toBe(true);
    done();
  });
});

test("runSign: 网络错误（login 超时）不崩溃且不标记已签到", (done) => {
  const api = (url, h, b, cb) => {
    cb("timeout", null, undefined);  // 模拟 $httpClient 网络失败
  };
  const notifs = [];
  runSign(api, "APP_COOKIE", "20260810", { notify: (t, s, c) => notifs.push([t, s, c]) }, (r) => {
    expect(notifs.length).toBe(1);
    expect(notifs[0][1]).toContain("自动续期失败");
    expect(r.signed).toBe(false);
    done();
  });
});

test("runSign: 活动页缺 yx cookie 时终止且不标记已签到", (done) => {
  const api = (url, h, b, cb) => {
    if (url.includes("qwhdsso/login")) cb(null, {}, '<script>loginPath="/appTokenLogin?sid=SID123"</script>');
    else if (url.includes("appTokenLogin")) cb(null, {}, '{"code":"SUCCESS","data":{"url":"https://wx.10086.cn/qwhdhub/qwhdmark/1021122301?token=QWHDSSOX"}}');
    else if (url.includes("qwhdmark/1021122301?token=")) cb(null, { headers: { "set-cookie": ["QWHD_SESSION_TOKEN=SESSION1;Max-Age=1800;path=/;HttpOnly"] } }, "");  // 缺 yx
    else cb(null, {}, "{}");
  };
  const notifs = [];
  runSign(api, "APP_COOKIE", "20260810", { notify: (t, s, c) => notifs.push([t, s, c]) }, (r) => {
    expect(notifs[0][1]).toContain("自动续期失败");
    expect(r.signed).toBe(false);
    done();
  });
});

test("runSign: user/info 网络错误时终止且不标记已签到", (done) => {
  const api = (url, h, b, cb) => {
    if (url.includes("qwhdsso/login")) cb(null, {}, '<script>loginPath="/appTokenLogin?sid=SID123"</script>');
    else if (url.includes("appTokenLogin")) cb(null, {}, '{"code":"SUCCESS","data":{"url":"https://wx.10086.cn/qwhdhub/qwhdmark/1021122301?token=QWHDSSOX"}}');
    else if (url.includes("qwhdmark/1021122301?token=")) cb(null, { headers: { "set-cookie": ["yx=123;Max-Age=300;path=/", "QWHD_SESSION_TOKEN=SESSION1;Max-Age=1800;path=/;HttpOnly"] } }, "");
    else if (url.includes("user/info")) cb("timeout", null, undefined);
    else cb(null, {}, "{}");
  };
  const notifs = [];
  runSign(api, "APP_COOKIE", "20260810", { notify: (t, s, c) => notifs.push([t, s, c]) }, (r) => {
    expect(notifs[0][1]).toContain("签到失败");
    expect(r.signed).toBe(false);
    done();
  });
});

test("runSign: Set-Cookie 为字符串格式（非数组）也能解析", (done) => {
  const api = (url, h, b, cb) => {
    if (url.includes("qwhdsso/login")) cb(null, {}, '<script>loginPath="/appTokenLogin?sid=SID123"</script>');
    else if (url.includes("appTokenLogin")) cb(null, {}, '{"code":"SUCCESS","data":{"url":"https://wx.10086.cn/qwhdhub/qwhdmark/1021122301?token=QWHDSSOX"}}');
    else if (url.includes("qwhdmark/1021122301?token=")) cb(null, { headers: { "set-cookie": "yx=123;Max-Age=300;path=/, QWHD_SESSION_TOKEN=SESSION1;Max-Age=1800;path=/;HttpOnly" } }, "");
    else if (url.includes("user/info")) cb(null, {}, '{"code":"SUCCESS","data":{"nickName":"测试"}}');
    else if (url.includes("domark")) cb(null, {}, '{"code":"SUCCESS"}');
    else if (url.includes("markstatus")) cb(null, {}, '{"code":"SUCCESS","data":{"markstatus":[]}}');
    else cb(null, {}, "{}");
  };
  const notifs = [];
  runSign(api, "APP_COOKIE", "20260810", { notify: (t, s, c) => notifs.push([t, s, c]) }, (r) => {
    expect(notifs.length).toBe(1);
    expect(notifs[0][2]).toContain("本月已签 0 天");
    expect(r.signed).toBe(true);
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
