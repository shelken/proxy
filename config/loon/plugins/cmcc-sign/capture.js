// 中国移动签到有礼 - 凭据读取脚本
// 匹配 user/info 请求，提取 QWHD_SESSION_TOKEN 及完整请求头并持久化（供 sign.js 动态复用）
const STORE_KEY = "cmcc_sign_token";
const HEADERS_KEY = "cmcc_sign_headers";

// 调试：打印 Loon 实际给的请求头键名，确认 Cookie 字段形态
console.log("cmcc-sign: 请求头 keys=" + JSON.stringify(Object.keys($request.headers || {})));

// 大小写不敏感查找 Cookie（Loon 键名可能为小写 cookie）
const rawCookie = (() => {
  const headers = $request.headers || {};
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === "cookie") return headers[k] || "";
  }
  return "";
})();

const m = rawCookie.match(/QWHD_SESSION_TOKEN=([^;\s]+)/);
if (m && m[1]) {
  const token = m[1];
  $persistentStore.write(token, STORE_KEY);
  // 存完整请求头（去掉 Cookie，token 单独维护；去空值键）
  const headers = {};
  if ($request.headers) {
    for (const k of Object.keys($request.headers)) {
      const v = $request.headers[k];
      if (v !== undefined && v !== null && v !== "" && k.toLowerCase() !== "cookie") {
        headers[k] = String(v);
      }
    }
  }
  $persistentStore.write(JSON.stringify(headers), HEADERS_KEY);
  const nick = ($response && $response.body) ? (() => {
    try {
      const obj = JSON.parse($response.body);
      return obj.data && obj.data.nickName ? obj.data.nickName : "";
    } catch (e) { return ""; }
  })() : "";
  $notification.post(
    "中国移动签到有礼",
    "凭据已更新",
    (nick ? nick + " 已" : "") + "自动提取最新凭据，每日将自动签到"
  );
  console.log("cmcc-sign: 提取凭据成功 token=" + token + " nick=" + nick);
} else {
  console.log("cmcc-sign: user/info 请求头中未找到 QWHD_SESSION_TOKEN，跳过");
}

// 原样放行
$done({});
