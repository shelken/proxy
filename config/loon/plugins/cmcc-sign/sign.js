// 中国移动签到有礼 - 每日签到脚本
// 流程：读 app 域登录态 → 动态获取 sid → appTokenLogin 换会话 → GET 活动页拿 QWHD_SESSION_TOKEN/yx → user/info 校验 → domark 签到 → markstatus 统计 → 通知
// app 域登录态（cmcc_app_cookie）是长效凭据，每次签到前用它自动换取 30 分钟会话 token，无需手动打开 APP。
// 纯函数部分（parseSid/parseAppToken/parseUserInfo/parseDomark/parseMarkstatus/runSign）可被同目录 sign.test.js 直接提取测试

const APP_COOKIE_KEY = "cmcc_app_cookie";
const LAST_SIGN_KEY = "cmcc_sign_last";

const LOGIN_URL = "https://wx.10086.cn/qwhdsso/login?dlwmh=true&actUrl=" +
  encodeURIComponent("https://wx.10086.cn/qwhdhub/qwhdmark/1021122301");
const APP_TOKEN_URL = "https://wx.10086.cn/qwhdsso/appTokenLogin";
const API_BASE = "https://wx.10086.cn/qwhdhub/api";
const CHANNEL_ID = "P00000057578";

// 功能性 UA：登录页按 UA 特征（leadeon webview）才返回含 sid 的 HTML，普通浏览器 UA 会 302 到绑定引导页；
// 业务接口同样需要 leadeon UA 才放行（中性 UA 返回 302）。保留 leadeon/CMCCIT 特征但不含真实版本号，兼顾隐私。
const DEFAULT_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148/wkwebview leadeon/CMCCIT";

// ===== 纯函数（无 Loon 依赖，可单测） =====

// 幂等判断：同一天已签则跳过本次签到。
function shouldSign(dateStr, store) {
  const last = store.read(LAST_SIGN_KEY);
  if (last === dateStr) return { skip: true, reason: "今日已签到，跳过" };
  return { skip: false, reason: "" };
}

// 记录本次已签日期
function markSigned(dateStr, store) {
  store.write(dateStr, LAST_SIGN_KEY);
}

// 从 qwhdsso/login HTML 中解析 sid（appTokenLogin URL 参数）
function parseSid(html) {
  const m = html.match(/appTokenLogin\?sid=([A-Za-z0-9]+)/);
  return m ? m[1] : "";
}

// 解析 appTokenLogin 响应：返回 { url }（含 token 参数的活动页地址）
function parseAppToken(body) {
  try {
    const obj = JSON.parse(body);
    if (obj.code === "SUCCESS" && obj.data && obj.data.url) {
      return { ok: true, url: obj.data.url };
    }
    return { ok: false, url: "" };
  } catch (e) {
    return { ok: false, url: "" };
  }
}

// 解析 user/info 响应：返回 { ok, nick }
function parseUserInfo(body) {
  try {
    const obj = JSON.parse(body);
    if (obj.code !== "SUCCESS") return { ok: false, nick: "" };
    return { ok: true, nick: (obj.data && obj.data.nickName) || "" };
  } catch (e) {
    return { ok: false, nick: "" };
  }
}

// 解析 domark 响应：success（签成功）/ marked（今日已签）/ fail
function parseDomark(body) {
  try {
    const obj = JSON.parse(body);
    if (obj.code === "SUCCESS") return "success";
    if (obj.status === "HAVE_MARKED") return "marked";
    return "fail";
  } catch (e) {
    return "fail";
  }
}

// 解析 markstatus 响应：返回本月已签天数（status=1 的条数）
function parseMarkstatus(body) {
  try {
    const obj = JSON.parse(body);
    const ms = obj.data && obj.data.markstatus;
    if (obj.code === "SUCCESS" && Array.isArray(ms)) {
      return ms.filter((item) => item.status === "1").length;
    }
    return 0;
  } catch (e) {
    return 0;
  }
}

// 组装业务请求头：完整 cookie jar（yx + QWHD_SESSION_TOKEN）+ leadeon UA + 完整 Referer
function buildHeaders(sessionCookie, referer) {
  return {
    "Content-Type": "application/json;charset=UTF-8",
    "Origin": "https://wx.10086.cn",
    "login-check": "1",
    "User-Agent": DEFAULT_UA,
    "Referer": referer,
    "x-requested-with": "XMLHttpRequest",
    "Cookie": sessionCookie,
  };
}

// 编排：换会话 → 校验登录态 → 签到 → 统计天数 → 通知。
// api 为注入的请求函数 (url, headers, body, cb)，便于测试；notify 注入通知函数；onDone 收尾（参数 { signed } 表示本次是否完成签到）。
function runSign(api, appCookie, dateStr, env, onDone) {
  const notify = env.notify;

  // 网络失败统一处理：通知 + 收尾
  const fail = (sub, msg) => {
    notify("中国移动签到有礼", sub, msg);
    onDone({ signed: false });
  };

  // 1. GET 登录页拿 sid
  api(LOGIN_URL, null, null, (err1, resp1, data1) => {
    if (err1) return fail("自动续期失败", "网络异常，请稍后重试");
    const sid = parseSid(data1);
    if (!sid) {
      console.log("cmcc-sign: 解析 sid 失败");
      return fail("自动续期失败", "无法获取登录票据，请打开中国移动APP");
    }

    // 2. appTokenLogin 用 app 域登录态换会话（url）
    api(APP_TOKEN_URL + "?sid=" + sid,
      { "Content-Type": "application/json;charset=UTF-8", "Origin": "https://wx.10086.cn", "User-Agent": DEFAULT_UA },
      { token: appCookie },
      (err2, resp2, data2) => {
        if (err2) return fail("自动续期失败", "网络异常，请稍后重试");
        const at = parseAppToken(data2);
        if (!at.ok) {
          console.log("cmcc-sign: appTokenLogin 失败");
          return fail("自动续期失败", "登录态已失效，请打开中国移动APP重新登录");
        }

        // 3. GET 活动页（拼 channelId + yx，拿 Set-Cookie 的 yx + QWHD_SESSION_TOKEN）
        const yx = Date.now();
        const sep = at.url.includes("?") ? "&" : "?";
        const fullUrl = at.url + sep + "channelId=" + CHANNEL_ID + "&yx=" + yx;
        api(fullUrl, null, null, (err3, resp3, data3) => {
          if (err3) return fail("自动续期失败", "网络异常，请稍后重试");
          // 从响应头提取 Set-Cookie（yx + QWHD_SESSION_TOKEN）。Loon 的 set-cookie 可能是字符串或数组。
          let sessionCookie = "";
          if (resp3 && resp3.headers) {
            const sc = resp3.headers["Set-Cookie"] || resp3.headers["set-cookie"] || "";
            const scList = Array.isArray(sc) ? sc : String(sc).split(",");
            const cookies = {};
            for (const part of scList) {
              const m = String(part).trim().match(/^([^=]+)=([^;]+)/);
              if (m) cookies[m[1].trim()] = m[2];
            }
            // 必须 yx 和 QWHD_SESSION_TOKEN 同时存在，缺一不可
            if (cookies["yx"] && cookies["QWHD_SESSION_TOKEN"]) {
              sessionCookie = "yx=" + cookies["yx"] + "; QWHD_SESSION_TOKEN=" + cookies["QWHD_SESSION_TOKEN"];
            }
          }
          if (!sessionCookie) {
            console.log("cmcc-sign: 未获取完整会话 cookie（需 yx + QWHD_SESSION_TOKEN），status=" + (resp3 && resp3.status));
            return fail("自动续期失败", "未获取到会话，请打开中国移动APP");
          }

          // 4. user/info 校验登录态 + 拿昵称
          api(API_BASE + "/mark/user/info", buildHeaders(sessionCookie, fullUrl),
            { appVersion: "", miniVersion: "" },
            (err4, resp4, data4) => {
              if (err4) return fail("签到失败", "网络异常，请稍后重试");
              const info = parseUserInfo(data4);
              if (!info.ok) {
                console.log("cmcc-sign: user/info 登录态校验失败");
                return fail("凭据已失效", "请打开中国移动APP重新进入活动页");
              }

              // 5. 签到（恰好一次）
              api(API_BASE + "/mark/mark31/domark", buildHeaders(sessionCookie, fullUrl),
                { date: dateStr },
                (err5, resp5, data5) => {
                  if (err5) return fail("签到失败", "网络异常，请稍后重试");
                  const signResult = parseDomark(data5);
                  if (signResult === "fail") console.log("cmcc-sign: domark 失败");

                  // 6. 统计本月已签天数
                  api(API_BASE + "/mark/mark31/markstatus", buildHeaders(sessionCookie, fullUrl),
                    {},
                    (err6, resp6, data6) => {
                      if (err6) {
                        // 签到已发生，仅统计失败：仍算已完成签到
                        notify("中国移动签到有礼", signResult === "success" ? "签到成功" : signResult === "marked" ? "今日已签到" : "签到失败", "统计失败，详见日志");
                        console.log("cmcc-sign: markstatus 网络失败");
                        return onDone({ signed: signResult !== "fail" });
                      }
                      const markedCount = parseMarkstatus(data6);
                      const tail = "本月已签 " + markedCount + " 天";
                      const nick = info.nick;

                      let sub, content;
                      if (signResult === "success") {
                        sub = "签到成功";
                        content = (nick ? nick + "，" : "") + tail;
                      } else if (signResult === "marked") {
                        sub = "今日已签到";
                        content = (nick ? nick + "，" : "") + tail;
                      } else {
                        sub = "签到失败";
                        content = "详见日志，" + tail;
                      }
                      notify("中国移动签到有礼", sub, content);
                      console.log("cmcc-sign: result=" + signResult + " marked=" + markedCount);
                      onDone({ signed: signResult !== "fail" });
                    }
                  );
                }
              );
            }
          );
        });
      }
    );
  });
}

// ===== Loon 环境适配 =====

const notifyEnabled = $argument && $argument.notify !== false;

function requestGet(url, headers, cb) {
  const merged = Object.assign({ "User-Agent": DEFAULT_UA }, headers || {});
  $httpClient.get({ url: url, headers: merged, timeout: 20000 }, (err, resp, data) => cb(err, resp, data));
}

function requestPost(url, headers, body, cb) {
  const merged = Object.assign({ "User-Agent": DEFAULT_UA }, headers || {});
  const opts = { url: url, headers: merged, timeout: 20000 };
  if (body !== null && body !== undefined) opts.body = JSON.stringify(body);
  $httpClient.post(opts, (err, resp, data) => cb(err, resp, data));
}

// 统一请求入口：GET 无 body，POST 有 body
function request(url, headers, body, cb) {
  if (body === null || body === undefined) requestGet(url, headers, cb);
  else requestPost(url, headers, body, cb);
}

function today() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return "" + d.getFullYear() + mm + dd;
}

function main() {
  const appCookie = $persistentStore.read(APP_COOKIE_KEY);
  if (!appCookie) {
    if (notifyEnabled)
      $notification.post("中国移动签到有礼", "未获取到凭据", "请打开中国移动APP进入「签到有礼」活动页后重试");
    console.log("cmcc-sign: 无 app 域登录态");
    return $done();
  }
  const dateStr = today();
  const store = { read: (k) => $persistentStore.read(k), write: (v, k) => $persistentStore.write(v, k) };
  const guard = shouldSign(dateStr, store);
  if (guard.skip) {
    if (notifyEnabled) $notification.post("中国移动签到有礼", "今日已签到", "无需重复签到");
    console.log("cmcc-sign: " + guard.reason);
    return $done();
  }
  runSign(
    request,
    appCookie,
    dateStr,
    { notify: (t, s, c) => { if (notifyEnabled) $notification.post(t, s, c); } },
    (result) => {
      // 仅在真正完成签到（成功或已签）后记录当日，失败不记录以便当天重试
      if (result && result.signed) markSigned(dateStr, store);
      $done();
    }
  );
}

main();
