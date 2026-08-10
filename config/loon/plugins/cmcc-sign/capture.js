// 中国移动签到有礼 - 凭据读取脚本
// 匹配 user/info 请求，提取 QWHD_SESSION_TOKEN 及完整请求头并持久化（供 sign.js 动态复用）
// 幂等：token 未变化时仅静默更新 headers，不重复写 token、不重复通知；token 变化（重新登录）才通知
const STORE_KEY = "cmcc_sign_token";
const HEADERS_KEY = "cmcc_sign_headers";

// ===== 纯函数（无 Loon 依赖，可单测） =====

// 判断是否值得更新并通知：token 为空或与旧值不同才需要（同值说明是同一会话的重复触发，静默）
function shouldUpdateToken(newToken, oldToken) {
  return !!newToken && newToken !== oldToken;
}

// ===== Loon 环境适配 =====

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
  const oldToken = $persistentStore.read(STORE_KEY);
  // 存完整请求头（去掉 Cookie，token 单独维护；去空值键）——无论 token 变没变都刷新 headers（UA 等可能更新）
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
  if (shouldUpdateToken(token, oldToken)) {
    $persistentStore.write(token, STORE_KEY);
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
    console.log("cmcc-sign: token 未变化，静默更新 headers");
  }
} else {
  console.log("cmcc-sign: user/info 请求头中未找到 QWHD_SESSION_TOKEN，跳过");
}

// 原样放行
$done({});
