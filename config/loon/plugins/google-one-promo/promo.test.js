// Google One 优惠档改写 promo.js 测试（bun:test）
// seams: rewriteCatalog / SKU_MAP
// 运行: just run-test promo

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 从同目录 promo.js 提取纯函数（不执行 Loon 环境代码）
const src = readFileSync(join(__dirname, "promo.js"), "utf8");
const pure = src.split("// ===== Loon 环境适配 =====")[0];
const factory = new Function(pure + "\nreturn { rewriteCatalog, SKU_MAP };");
const { rewriteCatalog, SKU_MAP } = factory();

// ===== rewriteCatalog: 目标档存在才替换 =====
test("主档在目录: 替换为 90p", () => {
  const body = JSON.stringify({
    skus: ["g1.ios.20tb.m.v2", "g1.20tb.3months_ip_90p.acq", "g1.ios.200g.m"],
  });
  const r = rewriteCatalog(body, SKU_MAP);
  expect(r.changed).toBe(true);
  expect(r.body).toContain('["g1.20tb.3months_ip_90p.acq","g1.20tb.3months_ip_90p.acq"');
  expect(r.body).not.toContain("g1.ios.20tb.m.v2");
});

test("主档缺失且备用档在目录: 降级 75p", () => {
  const body = JSON.stringify({
    skus: ["g1.ios.30tb.ai.pro.m", "g1.ai.ultra.3months_ip_75p.acq"],
  });
  const r = rewriteCatalog(body, SKU_MAP);
  expect(r.changed).toBe(true);
  expect(r.body).toContain("g1.ai.ultra.3months_ip_75p.acq");
  expect(r.body).not.toContain("g1.ios.30tb.ai.pro.m");
});

test("目录无任何候选优惠档: 原样放行", () => {
  const body = JSON.stringify({ skus: ["g1.ios.20tb.m.v2", "g1.ios.30tb.ai.pro.m"] });
  const r = rewriteCatalog(body, SKU_MAP);
  expect(r.changed).toBe(false);
  expect(r.body).toBe(body);
  expect(r.log.some((l) => l.includes("无任何候选优惠档"))).toBe(true);
});

test("响应中不存在原始档: 跳过", () => {
  const body = JSON.stringify({ skus: ["g1.ai.ultra.3months_ip_90p.acq"] });
  const r = rewriteCatalog(body, SKU_MAP);
  expect(r.changed).toBe(false);
  expect(r.log.some((l) => l.includes("不存在该原始档"))).toBe(true);
});

// ===== 替换行为 =====
test("同一原始档多处出现全部替换并计数", () => {
  const body = 'a:"g1.ios.20tb.m.v2" b:"g1.20tb.3months_ip_90p.acq" c:"g1.ios.20tb.m.v2"';
  const r = rewriteCatalog(body, SKU_MAP);
  expect(r.changed).toBe(true);
  expect(r.body.match(/g1\.20tb\.3months_ip_90p\.acq/g).length).toBe(3);
  expect(r.log.some((l) => l.includes("x2"))).toBe(true);
});

// ===== 目录探测日志 =====
test("探测日志列出目录中所有优惠档（含 SKU_MAP 外的未知档）", () => {
  const body = '["g1.5tb.3months_ip_50p.acq","g1.ios.20tb.m.v2","g1.20tb.3months_ip_75p.acq","g1.20tb.3months_ip_90p.acq"]';
  const r = rewriteCatalog(body, SKU_MAP);
  const probe = r.log.find((l) => l.startsWith("目录探测"));
  expect(probe).toContain("g1.5tb.3months_ip_50p.acq");
  expect(probe).toContain("g1.20tb.3months_ip_75p.acq");
  // 目录同时有 75p 与 90p 时用主档
  expect(r.body).toContain(
    '"g1.20tb.3months_ip_90p.acq","g1.20tb.3months_ip_75p.acq","g1.20tb.3months_ip_90p.acq"'
  );
});

test("目录探测无优惠档时输出 无", () => {
  const r = rewriteCatalog('["g1.ios.20tb.m.v2"]', SKU_MAP);
  expect(r.log[0]).toBe("目录探测 优惠档: 无");
});

// ===== 幂等：改写后的 body 再跑一次不变 =====
test("已改写的响应再次执行不再变化", () => {
  const body = JSON.stringify({ skus: ["g1.ios.20tb.m.v2", "g1.20tb.3months_ip_90p.acq"] });
  const first = rewriteCatalog(body, SKU_MAP);
  const second = rewriteCatalog(first.body, SKU_MAP);
  expect(second.changed).toBe(false);
  expect(second.body).toBe(first.body);
});
