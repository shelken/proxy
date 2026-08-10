// 中国移动签到有礼 - 凭据读取脚本
// 匹配 user/info 请求，提取 QWHD_SESSION_TOKEN 及完整请求头并持久化（供 sign.js 动态复用）
const STORE_KEY = "cmcc_sign_token";
const HEADERS_KEY = "cmcc_sign_headers";

const rawCookie = ($request.headers && $request.headers["Cookie"]) || "";
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
