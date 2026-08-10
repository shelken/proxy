// 中国移动签到有礼 - 每日签到脚本
// 流程：读凭据 → user/info 校验登录态 → mark31/domark 签到 → mark31/markstatus 统计本月已签天数 → 通知
// 纯函数部分（parseUserInfo/parseDomark/parseMarkstatus/runSign）可被同目录 sign.test.js 直接提取测试

const STORE_KEY = "cmcc_sign_token";
const HEADERS_KEY = "cmcc_sign_headers";
const LAST_SIGN_KEY = "cmcc_sign_last";

// ===== 纯函数（无 Loon 依赖，可单测） =====

// 幂等判断：同一天已签则跳过本次签到。
// store 注入读写接口 { read(key), write(value, key) }，便于测试；返回 { skip, reason }。
function shouldSign(dateStr, store) {
  const last = store.read(LAST_SIGN_KEY);
  if (last === dateStr) return { skip: true, reason: "今日已签到，跳过" };
  return { skip: false, reason: "" };
}

// 记录本次已签日期
function markSigned(dateStr, store) {
  store.write(dateStr, LAST_SIGN_KEY);
}

// 解析 user/info 响应：返回 { ok: 是否已登录, nick: 昵称 }
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

// 组装请求头：优先用提取的动态 headers，缺失字段 fallback 写死值；Cookie 永远用最新 token
function buildHeaders(token, savedHeaders) {
  const fallback = {
    "Content-Type": "application/json;charset=UTF-8",
    "Origin": "https://wx.10086.cn",
    "login-check": "1",
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
    "Referer": "https://wx.10086.cn/qwhdhub/qwhdmark/1021122301",
    "x-requested-with": "XMLHttpRequest",
  };
  const merged = Object.assign({}, fallback, savedHeaders || {});
  merged["Cookie"] = "QWHD_SESSION_TOKEN=" + token;
  return merged;
}

// 编排：校验登录态 → 签到 → 统计天数 → 通知。
// api 为注入的请求函数 (url, headers, body, cb)，便于测试；notify 注入通知函数；onDone 收尾。
function runSign(api, token, dateStr, env, onDone) {
  const notify = env.notify;
  const headers = buildHeaders(token, env.savedHeaders);

  // 1. 校验登录态 + 拿昵称
  api(
    "https://wx.10086.cn/qwhdhub/api/mark/user/info",
    headers,
    { appVersion: "", miniVersion: "" },
    (err1, resp1, data1) => {
      const info = parseUserInfo(data1);
      if (!info.ok) {
        notify("中国移动签到有礼", "凭据已失效", "请打开中国移动APP重新进入活动页更新凭据");
        console.log("cmcc-sign: user/info 登录态校验失败: " + data1);
        return onDone();
      }

      // 2. 签到（恰好一次）
      api(
        "https://wx.10086.cn/qwhdhub/api/mark/mark31/domark",
        headers,
        { date: dateStr },
        (err2, resp2, data2) => {
          const signResult = parseDomark(data2);
          if (signResult === "fail") console.log("cmcc-sign: domark 失败: " + data2);

          // 3. 统计本月已签天数
          api(
            "https://wx.10086.cn/qwhdhub/api/mark/mark31/markstatus",
            headers,
            {},
            (err3, resp3, data3) => {
              const markedCount = parseMarkstatus(data3);
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
              onDone();
            }
          );
        }
      );
    }
  );
}

// ===== Loon 环境适配 =====

const notifyEnabled = $argument && $argument.notify !== false;

function requestPost(url, headers, body, cb) {
  $httpClient.post(
    { url: url, headers: headers, body: JSON.stringify(body), timeout: 20000 },
    (err, resp, data) => cb(err, resp, data)
  );
}

function today() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return "" + d.getFullYear() + mm + dd;
}

function main() {
  const token = $persistentStore.read(STORE_KEY);
  if (!token) {
    if (notifyEnabled)
      $notification.post("中国移动签到有礼", "未获取到凭据", "请打开中国移动APP进入「签到有礼」活动页后重试");
    console.log("cmcc-sign: 无凭据");
    return $done();
  }
  const dateStr = today();
  // 幂等：同一天已签则直接跳过，避免 cron 重复触发造成重复签到
  const guard = shouldSign(dateStr, { read: (k) => $persistentStore.read(k), write: (v, k) => $persistentStore.write(v, k) });
  if (guard.skip) {
    if (notifyEnabled) $notification.post("中国移动签到有礼", "今日已签到", "无需重复签到");
    console.log("cmcc-sign: " + guard.reason);
    return $done();
  }
  // 读提取时存的完整请求头（无则 fallback 写死）
  let savedHeaders = null;
  try {
    savedHeaders = JSON.parse($persistentStore.read(HEADERS_KEY) || "null");
  } catch (e) {
    console.log("cmcc-sign: headers 解析失败，使用 fallback: " + e);
  }
  runSign(
    requestPost,
    token,
    dateStr,
    { notify: (t, s, c) => { if (notifyEnabled) $notification.post(t, s, c); }, savedHeaders: savedHeaders },
    () => {
      // 无论签到成功/已签/失败，都记录当日已执行，避免 cron 重复触发
      markSigned(dateStr, { read: (k) => $persistentStore.read(k), write: (v, k) => $persistentStore.write(v, k) });
      $done();
    }
  );
}

main();
