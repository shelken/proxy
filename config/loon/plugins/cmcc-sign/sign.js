// 中国移动签到有礼 - 每日签到脚本
// 流程：重放 autoLogin 请求拿全新会话 → 动态获取 sid → appTokenLogin 换会话 → GET 活动页拿 QWHD_SESSION_TOKEN/yx → user/info 校验 → domark 签到 → markstatus 统计 → 通知
// autoLogin 快照（cmcc_autologin，含 x-token 长期设备凭据）由 capture.js 捕获，原样重放即可换取新会话，无需手动打开 APP。
// 纯函数部分（parseSid/parseAppToken/parseUserInfo/parseDomark/parseMarkstatus/runSign/parseSessionCookie）可被同目录 sign.test.js 直接提取测试

const SNAPSHOT_KEY = "cmcc_autologin";
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

// 从 autoLogin 响应 Set-Cookie 提取全新会话 cookie 串（JSESSIONID/UID/Comment/ticketID，按固定顺序）
// 兼容数组（Loon 多行 Set-Cookie）与单字符串（每段以 ; 或 , 分隔）两种形态
function parseSessionCookie(setCookieHeader) {
  if (!setCookieHeader) return "";
  const map = {};
  const list = Array.isArray(setCookieHeader) ? setCookieHeader : String(setCookieHeader).split(",");
  for (const part of list) {
    const segs = String(part).split(";");
    for (const seg of segs) {
      const m = seg.trim().match(/^([^=]+)=(.+)$/);
      if (m && ["JSESSIONID", "UID", "Comment", "ticketID"].includes(m[1].trim())) {
        map[m[1].trim()] = m[1].trim() + "=" + m[2].trim();
      }
    }
  }
  return ["JSESSIONID", "UID", "Comment", "ticketID"]
    .filter((n) => map[n])
    .map((n) => map[n])
    .join("; ");
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

// 编排：重放 autoLogin 换会话 → 校验登录态 → 签到 → 统计天数 → 通知。
// api 为注入的请求函数 (url, headers, body, cb)，便于测试；notify 注入通知函数；onDone 收尾（参数 { signed } 表示本次是否完成签到）。
// snapshot 为 capture.js 捕获的 autoLogin 请求快照 { url, headers, body }。
function runSign(api, snapshot, dateStr, env, onDone) {
  const notify = env.notify;

  // 统一失败处理：console 打印完整诊断（含状态码/响应体片段），通知只发简洁提示
  const fail = (step, err, resp, data, hint) => {
    const status = resp && resp.status;
    const body = data ? String(data).slice(0, 200) : "";
    console.log("cmcc-sign: [" + step + "] 失败 err=" + (err || "-") + " status=" + (status || "-") + " resp=" + body);
    notify("中国移动签到有礼", step + "失败", hint || "请查看 Loon 日志定位问题");
    onDone({ signed: false });
  };

  // 0. 原样重放 autoLogin 请求，拿全新会话（Set-Cookie）
  api(snapshot.url, snapshot.headers, snapshot.body, (err0, resp0, data0) => {
    if (err0) return fail("自动续期", err0, resp0, data0, "网络异常");
    const sc = resp0 && resp0.headers && (resp0.headers["Set-Cookie"] || resp0.headers["set-cookie"]);
    const appCookie = parseSessionCookie(sc);
    if (!appCookie) {
      console.log("cmcc-sign: [autoLogin 重放] 未返回会话 cookie Set-Cookie=" + String(sc || "").slice(0, 200));
      return fail("自动续期", null, resp0, data0, "未返回会话 cookie，请重新打开中国移动APP");
    }

    // 1. GET 登录页拿 sid
    api(LOGIN_URL, null, null, (err1, resp1, data1) => {
    if (err1) return fail("获取登录票据", err1, resp1, data1, "网络异常");
    const sid = parseSid(data1);
    if (!sid) {
      console.log("cmcc-sign: [解析 sid] 失败，登录页响应=" + String(data1 || "").slice(0, 200) + " status=" + (resp1 && resp1.status));
      return fail("自动续期", null, resp1, data1, "无法获取登录票据");
    }

    // 2. appTokenLogin 用 app 域登录态换会话（url）
    api(APP_TOKEN_URL + "?sid=" + sid,
      { "Content-Type": "application/json;charset=UTF-8", "Origin": "https://wx.10086.cn", "User-Agent": DEFAULT_UA },
      { token: appCookie },
      (err2, resp2, data2) => {
        if (err2) return fail("自动续期", err2, resp2, data2, "网络异常");
        const at = parseAppToken(data2);
        if (!at.ok) {
          // 打印响应体前 200 字符（不含 cookie 值），定位失败原因
          console.log("cmcc-sign: [appTokenLogin] 失败 resp=" + String(data2).slice(0, 200) + " status=" + (resp2 && resp2.status));
          return fail("自动续期", null, resp2, data2, "登录态已失效");
        }

        // 3. GET 活动页（拼 channelId + yx，拿 Set-Cookie 的 yx + QWHD_SESSION_TOKEN）
        const yx = Date.now();
        const sep = at.url.includes("?") ? "&" : "?";
        const fullUrl = at.url + sep + "channelId=" + CHANNEL_ID + "&yx=" + yx;
        api(fullUrl, null, null, (err3, resp3, data3) => {
          if (err3) return fail("自动续期", err3, resp3, data3, "网络异常");
          // 从响应头提取 Set-Cookie（yx + QWHD_SESSION_TOKEN）。Loon 的 set-cookie 可能是字符串或数组。
          let sessionCookie = "";
          let rawSc = "";
          if (resp3 && resp3.headers) {
            const sc = resp3.headers["Set-Cookie"] || resp3.headers["set-cookie"] || "";
            rawSc = String(Array.isArray(sc) ? sc.join(" | ") : sc);
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
            console.log("cmcc-sign: [活动页] 未获取完整会话 cookie status=" + (resp3 && resp3.status) + " Set-Cookie=" + rawSc.slice(0, 200));
            return fail("自动续期", null, resp3, data3, "未获取到会话");
          }

          // 4. user/info 校验登录态 + 拿昵称
          api(API_BASE + "/mark/user/info", buildHeaders(sessionCookie, fullUrl),
            { appVersion: "", miniVersion: "" },
            (err4, resp4, data4) => {
              if (err4) return fail("签到", err4, resp4, data4, "网络异常");
              const info = parseUserInfo(data4);
              if (!info.ok) {
                console.log("cmcc-sign: [user/info] 登录态校验失败 resp=" + String(data4 || "").slice(0, 200));
                return fail("凭据校验", null, resp4, data4, "登录态校验失败");
              }

              // 5. 签到（恰好一次）
              api(API_BASE + "/mark/mark31/domark", buildHeaders(sessionCookie, fullUrl),
                { date: dateStr },
                (err5, resp5, data5) => {
                  if (err5) return fail("签到", err5, resp5, data5, "网络异常");
                  const signResult = parseDomark(data5);
                  if (signResult === "fail") {
                    console.log("cmcc-sign: [domark] 失败 resp=" + String(data5 || "").slice(0, 200));
                  }

                  // 6. 统计本月已签天数
                  api(API_BASE + "/mark/mark31/markstatus", buildHeaders(sessionCookie, fullUrl),
                    {},
                    (err6, resp6, data6) => {
                      if (err6) {
                        // 签到已发生，仅统计失败：仍算已完成签到
                        console.log("cmcc-sign: [markstatus] 网络失败 err=" + err6 + " status=" + (resp6 && resp6.status));
                        notify("中国移动签到有礼", signResult === "success" ? "签到成功" : signResult === "marked" ? "今日已签到" : "签到失败", "统计失败｜HTTP " + (resp6 && resp6.status || "-") + "｜" + (err6 || ""));
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
  if (body !== null && body !== undefined) {
    // autoLogin 重放时 body 是原始加密串，必须原样发送；业务接口传对象时序列化为 JSON
    opts.body = typeof body === "string" ? body : JSON.stringify(body);
  }
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
  const snapshotRaw = $persistentStore.read(SNAPSHOT_KEY);
  let snapshot = null;
  try { snapshot = snapshotRaw ? JSON.parse(snapshotRaw) : null; } catch (e) { snapshot = null; }
  if (!snapshot || !snapshot.url || !snapshot.body) {
    if (notifyEnabled)
      $notification.post("中国移动签到有礼", "未获取到凭据", "请打开中国移动APP进入「签到有礼」活动页后重试");
    console.log("cmcc-sign: 无 autoLogin 快照");
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
    snapshot,
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
