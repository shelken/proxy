// 中国移动签到有礼 - 长效凭据捕获脚本
// 捕获 client.app.coc.10086.cn 请求头中的 app 域登录态 cookie（JSESSIONID/UID/ticketID），持久化供 sign.js 自动刷新会话使用。
// app 域 cookie 是长效登录态（与 APP 登录态同寿命），sign.js 每次签到前用它换新的 QWHD_SESSION_TOKEN。
// 幂等：cookie 串未变化时静默，变化（重新登录）才通知。

const APP_COOKIE_KEY = "cmcc_app_cookie";

// 关键登录态 cookie 名（app 域登录所需。实测 Comment=SessionServer-unity 必需，Secure/Path/HTTPOnly 可去）
const KEY_COOKIES = ["JSESSIONID", "UID", "Comment", "ticketID"];

// ===== 纯函数（无 Loon 依赖，可单测） =====

// 从请求头对象提取 app 域登录态 cookie 串（仅保留 JSESSIONID/UID/ticketID，按固定顺序，其余无关 cookie 丢弃）
function extractAppCookie(headers) {
  if (!headers) return "";
  const map = {};
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === "cookie") {
      const v = String(headers[k] || "");
      // 按 "; " 拆分成独立 cookie（避免误拆 Path=/;HttpOnly 这类无空格分号）
      for (const seg of v.split("; ")) {
        const s = seg.trim();
        const eq = s.indexOf("=");
        if (eq > 0) {
          const name = s.slice(0, eq).trim();
          if (KEY_COOKIES.includes(name)) map[name] = s;
        }
      }
    }
  }
  // 按固定顺序组装，保证相同登录态的 cookie 串恒定（语义幂等）
  return KEY_COOKIES.filter((n) => map[n]).map((n) => map[n]).join("; ");
}

// 判断是否值得更新：cookie 非空且与旧值不同
function shouldUpdateCookie(newCookie, oldCookie) {
  return !!newCookie && newCookie !== oldCookie;
}

// ===== Loon 环境适配 =====

const cookie = extractAppCookie($request.headers);
if (cookie) {
  const oldCookie = $persistentStore.read(APP_COOKIE_KEY);
  if (shouldUpdateCookie(cookie, oldCookie)) {
    $persistentStore.write(cookie, APP_COOKIE_KEY);
    $notification.post("中国移动签到有礼", "凭据已更新", "已保存登录凭据，签到将自动续期，无需频繁打开APP");
    console.log("cmcc-sign: 捕获 app 域登录态成功");
  } else {
    console.log("cmcc-sign: app 域登录态未变化，静默");
  }
} else {
  console.log("cmcc-sign: 请求头无 Cookie，跳过");
}

// 原样放行
$done({});
