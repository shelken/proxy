// Mac 与 iOS 底模共享 modules/，两端都必须满足的顺序契约集中在这里，
// 由两份结构测试复用，变异验证也直接打这些函数，避免两处各写一份后口径漂移。
import { expect } from "bun:test";

type Rule = Record<string, any>;

// 内核 merge 的输出会把单元素数组写成标量，断言要对两种形态都成立。
export const asArray = <T>(v: T | T[] | undefined): T[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];

// ADR-0008：clash_mode 只能决定业务走哪条线路，不能顺手放行广告、黑名单与 QUIC 兜底。
export const assertRejectBeforeClashMode = (rules: Rule[]) => {
  const firstClashMode = rules.findIndex((r) => r.clash_mode !== undefined);
  expect(firstClashMode).toBeGreaterThan(-1);
  expect(rules.some((r) => r.action === "reject")).toBe(true);
  rules.forEach((r, i) => {
    if (r.action === "reject") expect(i).toBeLessThan(firstClashMode);
  });
};

// ADR-0007：分流类自有清单排在所有服务规则之前。
export const assertMyDirectAndProxyBeforeServices = (
  rules: Rule[],
  outbounds: Array<{ tag: string; type: string }>,
) => {
  const serviceOutbounds = new Set(
    outbounds
      .filter((o) => o.type === "selector" || o.type === "urltest")
      .map((o) => o.tag),
  );
  for (const generic of ["direct", "proxy", "torrent", "download", "ts-ep"])
    serviceOutbounds.delete(generic);
  const myDirect = rules.findIndex(
    (r) => r.outbound === "direct" && asArray(r.rule_set).includes("MyDirect"),
  );
  const myProxy = rules.findIndex(
    (r) => r.outbound === "proxy" && asArray(r.rule_set).includes("MyProxy"),
  );
  const firstService = rules.findIndex(
    (r) => r.outbound !== undefined && serviceOutbounds.has(r.outbound),
  );
  expect(myDirect).toBeGreaterThanOrEqual(0);
  expect(myProxy).toBeGreaterThanOrEqual(0);
  expect(firstService).toBeGreaterThan(-1);
  expect(myDirect).toBeLessThan(firstService);
  expect(myProxy).toBeLessThan(firstService);
};

// ADR-0011：MyProxy 与 ChinaMax 重叠的域名（如 minimax.io）不能被国内 QUIC 豁免直连，
// 先 reject 降级 TCP，再由服务规则走代理。
export const assertMyProxyQuicBeforeExempt = (rules: Rule[]) => {
  const quic = rules.filter((r) => r.network === "udp" && asArray(r.port).includes(443));
  const exempt = quic.find((r) => r.outbound === "direct");
  const myProxyReject = quic.find(
    (r) => r.action === "reject" && asArray(r.rule_set).includes("MyProxy"),
  );
  expect(exempt).toBeDefined();
  expect(myProxyReject?.no_drop).toBe(true);
  expect(rules.indexOf(myProxyReject!)).toBeLessThan(rules.indexOf(exempt!));
};

// ADR-0011：DNS 层同理，MyProxy-dns 先于 ChinaMax-dns 拿到 FakeIP。
export const assertMyProxyDnsBeforeChinaMax = (dnsRules: Rule[]) => {
  const mine = dnsRules.findIndex((r) => asArray(r.rule_set).includes("MyProxy-dns"));
  const china = dnsRules.findIndex((r) => asArray(r.rule_set).includes("ChinaMax-dns"));
  expect(mine).toBeGreaterThanOrEqual(0);
  expect(mine).toBeLessThan(china);
  expect(dnsRules[mine].server).toBe("dns-fakeip");
  expect(asArray(dnsRules[mine].query_type)).toEqual(["A", "AAAA"]);
};
