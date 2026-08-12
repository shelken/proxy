// 中国移动签到有礼 - 自动登录请求捕获脚本
// 捕获 client.app.coc.10086.cn 的 uamonekeylogin/autoLogin 请求（含 x-token 长期设备凭据与加密 body），
// 完整快照持久化。sign.js 签到前原样重放该请求，服务端返回全新会话 Set-Cookie（JSESSIONID/UID/ticketID），
// 实现登录态自动续期，无需打开 APP。
// 幂等：快照未变化时静默，变化（重新登录/新设备凭据）才通知。

const SNAPSHOT_KEY = "cmcc_autologin";

// 重放时需要保留的请求头（其余如 Content-Length/Accept-Encoding 由 Loon 自动处理或去掉避免干扰）
const KEEP_HEADERS = [
  "content-type", "x-qen", "accept", "xs", "x-sign", "x-nonce",
  "x-token", "x-time", "user-agent", "cookie", "origin", "referer",
];

// ===== 纯函数（无 Loon 依赖，可单测） =====

// 从 http-request 上下文提取可重放的 autoLogin 请求快照（仅保留关键头 + 原样 body）
function extractAutoLoginSnapshot(url, headers, body) {
  if (!url || !headers) return null;
  const keep = {};
  for (const k of Object.keys(headers)) {
    const lk = k.toLowerCase();
    if (KEEP_HEADERS.includes(lk)) keep[k] = String(headers[k]);
  }
  return { url: url, headers: keep, body: body ? String(body) : "" };
}

// 判断快照是否值得更新：非空且与旧快照 JSON 不同
function shouldUpdateSnapshot(newSnap, oldSnap) {
  if (!newSnap || !newSnap.url) return false;
  return JSON.stringify(newSnap) !== JSON.stringify(oldSnap);
}

// ===== Loon 环境适配 =====

const snap = extractAutoLoginSnapshot($request.url, $request.headers, $request.body);
if (snap) {
  const oldSnap = (() => {
    try { return JSON.parse($persistentStore.read(SNAPSHOT_KEY) || "null"); } catch (e) { return null; }
  })();
  if (shouldUpdateSnapshot(snap, oldSnap)) {
    $persistentStore.write(JSON.stringify(snap), SNAPSHOT_KEY);
    $notification.post("中国移动签到有礼", "凭据已更新", "已保存自动登录凭据，签到将自动续期，无需频繁打开APP");
    console.log("cmcc-sign: 捕获 autoLogin 快照成功");
  } else {
    console.log("cmcc-sign: autoLogin 快照未变化，静默");
  }
} else {
  console.log("cmcc-sign: 非 autoLogin 请求，跳过");
}

// 原样放行
$done({});
