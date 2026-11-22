// Google One 优惠档改写 - 商品目录响应处理脚本
// one.google.com/ai 的商品目录响应里，把 iOS 内购档 ID 替换为限时优惠档。
// 只有优惠档真实出现在目录里才替换；主档(90p)缺失时自动降级备用档(75p)。
// 每次命中都输出目录探测日志，列出响应中真实存在的所有优惠档，以此增删 SKU_MAP。

// 优惠档探测：匹配 g1.*.acq 且带 ip_NNp 促销标记的 SKU
const PROMO_PATTERN = /g1\.[\w.]*?ip_\d+p\.acq/g;

// ===== 纯函数（无 Loon 依赖，可单测） =====

// 原始 iOS 内购档 -> 优惠档（tiers 按优先级从高到低）
const SKU_MAP = [
  {
    from: "g1.ios.20tb.m.v2",
    tiers: ["g1.20tb.3months_ip_90p.acq", "g1.20tb.3months_ip_75p.acq"],
  },
  {
    from: "g1.ios.30tb.ai.pro.m",
    tiers: ["g1.ai.ultra.3months_ip_90p.acq", "g1.ai.ultra.3months_ip_75p.acq"],
  },
];

// 按映射表改写目录响应：目标优惠档必须在目录里，缺失时降级；原始档不在则跳过
function rewriteCatalog(body, map) {
  const log = [];
  const promos = Array.from(new Set(body.match(PROMO_PATTERN) || []));
  log.push("目录探测 优惠档: " + (promos.join(", ") || "无"));

  let out = body;
  for (const rule of map) {
    const target = rule.tiers.find((t) => promos.includes(t));
    if (!target) {
      log.push(`跳过 ${rule.from}: 目录中无任何候选优惠档`);
      continue;
    }
    if (out.indexOf(rule.from) === -1) {
      log.push(`跳过 ${rule.from}: 响应中不存在该原始档`);
      continue;
    }
    const count = out.split(rule.from).length - 1;
    out = out.split(rule.from).join(target);
    log.push(`替换 ${rule.from} -> ${target} x${count}`);
  }

  return { body: out, changed: out !== body, log };
}

// ===== Loon 环境适配 =====

try {
  const body = $response && $response.body ? String($response.body) : "";
  const result = rewriteCatalog(body, SKU_MAP);
  for (const line of result.log) console.log("google-one-promo: " + line);
  if (result.changed) {
    $done({ body: result.body });
  } else {
    $done({});
  }
} catch (e) {
  console.log("google-one-promo: 异常，原样放行 " + e);
  $done({});
}
