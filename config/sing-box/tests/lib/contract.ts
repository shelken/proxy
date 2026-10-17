// 底模的跨模板契约：顺序与引用闭合。
//
// 为什么需要单独一份：`sing-box check` 只做 `box.New`，不 `Start()`（cmd_check.go），
// 而 tag 引用解析发生在启动阶段（如 route/rule/rule_item_preferred_by.go 的 Start）。
// 所以 check 对悬空 outbound / rule_set / server / final 一律放行。顺序同理：
// check 不关心规则先后，而 route.rules 是首匹配优先，顺序就是行为。
//
// 顺序条目只收录「有证据证明必须如此」的：每条 why 指向 ADR、尸检或沙箱实测。
// 指不出证据的顺序属于实现自由，不写进来——否则未来合法的重排会被误判为回归。

import { readdirSync } from "node:fs";
import { resolve } from "node:path";

export type Rule = Record<string, any>;

export const asArray = <T>(v: T | T[] | undefined | null): T[] =>
  v === undefined || v === null ? [] : Array.isArray(v) ? v : [v];

/** 内核 merge 会省略取默认值的 `action: "route"`，比较动作时要补回默认值。 */
export const actionOf = (rule: Rule): string => rule.action ?? "route";

/** 底模目录。变异验证脚本把整棵目录复制到临时位置后，用这里切换被测对象。 */
export const TEMPLATE_DIR = process.env.SINGBOX_TEMPLATE_DIR
  ? resolve(process.env.SINGBOX_TEMPLATE_DIR)
  : resolve(import.meta.dir, "../..");

export async function loadTemplate(name: string): Promise<Rule> {
  const path = resolve(TEMPLATE_DIR, name);
  return JSON.parse(await Bun.file(path).text());
}

export interface Anchor {
  /** 出现在失败信息里，应当能独立说明这条规则在做什么 */
  label: string;
  pred: (rule: Rule) => boolean;
  /** 为什么这条顺序是强制的：指向 ADR、尸检或实测 */
  why: string;
  /** 只在某个模板里存在 */
  only?: "ios";
  /**
   * 锚点必须命中「第一个满足 pred 的规则」。
   *
   * 默认的按序前进允许同一谓词命中多条规则（例如两条 DNS 劫持），此时把其中一条
   * 提前到前面仍会通过——变异验证发现过这个漏洞。first 让锚点锚定首条命中，
   * 该组内任何一条越界都会被捕获。
   */
  first?: boolean;
}

export interface OrderScope {
  ios: boolean;
}

/**
 * 断言锚点按给定次序出现且全部命中。
 *
 * 用「按序前进」而不是逐个比大小：同一条谓词可能命中多条规则（例如两条 DNS 劫持），
 * 前进式匹配能容忍这种情况，同时仍拒绝逆序。
 */
export function assertOrder(rules: Rule[], anchors: Anchor[], scope: OrderScope): void {
  let cursor = -1;
  for (const anchor of anchors) {
    if (anchor.only === "ios" && !scope.ios) continue;

    if (anchor.first) {
      // 锚定首条命中：越界放到更前面的那条会被看到
      const index = rules.findIndex(anchor.pred);
      if (index < 0 || index <= cursor) {
        throw new Error(
          `顺序契约不满足：期望「${anchor.label}」的首条出现在第 ${cursor + 1} 条之后，` +
            `实际在 ${index < 0 ? "未找到" : `第 ${index} 条`}。\n依据：${anchor.why}`,
        );
      }
      cursor = index;
      continue;
    }

    const index = rules.findIndex((rule, i) => i > cursor && anchor.pred(rule));
    if (index < 0) {
      throw new Error(
        `顺序契约不满足：期望「${anchor.label}」出现在第 ${cursor + 1} 条之后，但没有找到。\n` +
          `依据：${anchor.why}`,
      );
    }
    cursor = index;
  }
}

const declaredRuleSets = (template: Rule): Set<string> =>
  new Set(asArray(template.route?.rule_set).map((rs: Rule) => rs.tag));

interface RefScope {
  outbounds: Set<string>;
  endpoints: Set<string>;
  inbounds: Set<string>;
  dnsServers: Set<string>;
  ruleSets: Set<string>;
}

function scopeOf(template: Rule): RefScope {
  return {
    outbounds: new Set(asArray(template.outbounds).map((o: Rule) => o.tag)),
    endpoints: new Set(asArray(template.endpoints).map((e: Rule) => e.tag)),
    inbounds: new Set(asArray(template.inbounds).map((i: Rule) => i.tag)),
    dnsServers: new Set(asArray(template.dns?.servers).map((s: Rule) => s.tag)),
    ruleSets: declaredRuleSets(template),
  };
}

/**
 * 断言所有 tag 引用都指向真实存在的声明。
 *
 * 覆盖 check 漏掉的每一类悬空引用（见文件头注释）。endpoint 可以同时充当出站与入站，
 * 所以 `outbound` / `preferred_by` / `inbound` 的合法目标都是 outbounds ∪ endpoints。
 */
export function assertRefsClosed(template: Rule, name: string): void {
  const scope = scopeOf(template);
  const routeTargets = new Set([...scope.outbounds, ...scope.endpoints]);
  const inboundTargets = new Set([...scope.inbounds, ...scope.endpoints]);
  const problems: string[] = [];

  const check = (
    where: string,
    field: string,
    values: string[],
    targets: Set<string>,
  ) => {
    for (const value of values) {
      if (!targets.has(value)) {
        problems.push(`${where}.${field} = ${JSON.stringify(value)} 未声明`);
      }
    }
  };

  const routeRules = asArray(template.route?.rules);
  routeRules.forEach((rule: Rule, i: number) => {
    const where = `route.rules[${i}]`;
    check(where, "outbound", asArray(rule.outbound), routeTargets);
    check(where, "preferred_by", asArray(rule.preferred_by), routeTargets);
    check(where, "inbound", asArray(rule.inbound), inboundTargets);
    check(where, "server", asArray(rule.server), scope.dnsServers);
    check(where, "rule_set", asArray(rule.rule_set), scope.ruleSets);
  });

  const dnsRules = asArray(template.dns?.rules);
  dnsRules.forEach((rule: Rule, i: number) => {
    const where = `dns.rules[${i}]`;
    check(where, "server", asArray(rule.server), scope.dnsServers);
    check(where, "preferred_by", asArray(rule.preferred_by), scope.dnsServers);
    check(where, "inbound", asArray(rule.inbound), inboundTargets);
    check(where, "rule_set", asArray(rule.rule_set), scope.ruleSets);
  });

  asArray(template.dns?.servers).forEach((server: Rule, i: number) => {
    check(`dns.servers[${i}]`, "endpoint", asArray(server.endpoint), scope.endpoints);
  });

  check("route", "final", asArray(template.route?.final), routeTargets);
  check("dns", "final", asArray(template.dns?.final), scope.dnsServers);
  check(
    "route",
    "default_domain_resolver",
    asArray(template.route?.default_domain_resolver),
    scope.dnsServers,
  );

  if (problems.length > 0) {
    throw new Error(`${name} 存在悬空引用（内核 check 不覆盖这类错误）：\n  ${problems.join("\n  ")}`);
  }
}

/**
 * 路由顺序锚点。mac 跳过 only: "ios" 的条目，其余两侧共用同一张表。
 */
export const ROUTE_ORDER: Anchor[] = [
  {
    label: "ts-ep 入站拒绝",
    pred: (r) => actionOf(r) === "reject" && asArray(r.inbound).includes("ts-ep"),
    why: "ADR-0010 决策 5：Tailnet 连入手机会被改写为 127.0.0.1，晚于私网直连就读到本机服务（尸检 014 沙箱实证）",
    only: "ios",
  },
  {
    label: "sniff",
    pred: (r) => actionOf(r) === "sniff",
    why: "内核语义：protocol / domain / client 等字段依赖嗅探结果，sniff 晚于它们则永远匹配不到",
    first: true,
  },
  {
    label: "DNS 劫持",
    pred: (r) => actionOf(r) === "hijack-dns",
    why: "尸检 001：DNS 查询包发往网关 53，若晚于 ip_is_private → direct 就被判为私网直连，绕过 TUN 造成解析黑洞",
    first: true,
  },
  {
    label: "preferred_by ts-ep 路由",
    pred: (r) => asArray(r.preferred_by).length > 0 && r.outbound !== undefined,
    why: "ADR-0010 决策 4：Tailscale 已认领的子网必须先于私网直连被接管，否则子网路由失效",
    only: "ios",
  },
  {
    label: "私网直连",
    pred: (r) => r.ip_is_private === true,
    why: "ADR-0010 决策 4 的对偶：私网直连必须晚于 Tailscale 认领，否则前者截胡后者",
  },
  {
    label: "广告与黑名单拦截",
    pred: (r) => actionOf(r) === "reject" && asArray(r.rule_set).includes("Advertising"),
    why: "ADR-0008：拦截必须先于模式开关与服务分流，global 模式下黑名单才仍然被拦",
    first: true,
  },
  {
    label: "MyProxy 的 QUIC 拒绝",
    pred: (r) => actionOf(r) === "reject" && asArray(r.rule_set).includes("MyProxy"),
    why: "ADR-0011：MyProxy 与 ChinaMax 重叠的域名不能被国内豁免直连，必须先降级为 TCP 再由服务规则走代理",
  },
  {
    label: "QUIC 国内豁免",
    pred: (r) =>
      r.outbound === "direct" && asArray(r.port).includes(443) && asArray(r.network).includes("udp"),
    why: "ADR-0008 / CODING_STANDARDS：单留 reject 会让国内 CDN 的 HTTP/3 无差别降级",
  },
  {
    label: "QUIC 兜底拒绝",
    pred: (r) =>
      actionOf(r) === "reject" && asArray(r.port).includes(443) && asArray(r.rule_set).length === 0,
    why: "ADR-0008 / CODING_STANDARDS：豁免之后仍需兜底拒绝境外 QUIC，避免打进承载差的机场 UDP",
  },
  {
    label: "clash_mode 模式开关",
    pred: (r) => r.clash_mode !== undefined,
    why: "ADR-0008：模式只能决定业务走哪条线路，不能顺手放行广告与黑名单",
  },
  {
    label: "resolve",
    pred: (r) => actionOf(r) === "resolve",
    why: "CODING_STANDARDS：代理流量必须在本机按 v4 解析后再交给节点，晚于出站规则则不生效",
  },
  {
    label: "MyProxy 服务规则",
    pred: (r) => r.outbound === "proxy" && asArray(r.rule_set).includes("MyProxy"),
    why: "CODING_STANDARDS / ADR-0007：自有清单排在外部清单与服务规则之前，避免被宽泛上游清单抢占",
  },
];

/**
 * DNS 顺序锚点。
 */
export const DNS_ORDER: Anchor[] = [
  {
    label: "dns.rules 的 ts-ep 入站拒绝",
    pred: (r) => actionOf(r) === "reject" && asArray(r.inbound).includes("ts-ep"),
    why: "ADR-0010 决策 5：Peer 的 DNS 查询直接进 dnsRouter（endpoint.go HandlePeerDNSQuery），不经 route.rules，DNS 层必须独立拒绝",
    only: "ios",
  },
  {
    label: "MagicDNS",
    pred: (r) => asArray(r.preferred_by).length > 0,
    why: "ADR-0010 决策 4：Tailnet 域名必须先被 MagicDNS 接住，晚于 FakeIP 会拿到假地址",
    only: "ios",
  },
  {
    label: "内部域静态应答",
    pred: (r) => actionOf(r) === "predefined",
    why: "内部域必须零出站应答，晚于 FakeIP 会拿到假地址",
  },
  {
    label: "MyReject-dns 拦截",
    pred: (r) => actionOf(r) === "reject" && asArray(r.rule_set).includes("MyReject-dns"),
    why: "拦截必须早于 FakeIP，否则被拦域名先拿到假地址放行",
  },
  {
    label: "MyProxy-dns",
    pred: (r) => asArray(r.rule_set).includes("MyProxy-dns"),
    why: "ADR-0011：与 ChinaMax 重叠的域名不能被国内解析抢先",
  },
  {
    label: "ChinaMax-dns",
    pred: (r) => asArray(r.rule_set).includes("ChinaMax-dns"),
    why: "ADR-0011 的对偶：国内解析必须晚于 MyProxy-dns，否则重叠域名被判成国内",
  },
  {
    label: "FakeIP 兜底",
    pred: (r) => r.server === "dns-fakeip" && asArray(r.rule_set).length === 0,
    why: "first match wins：FakeIP 兜底必须在所有具名分流之后",
  },
];

/** modules-ios/ 的文件白名单：新增 iOS 模块必须同步登记，防止差异面无声扩大。 */
export const IOS_MODULE_WHITELIST = [
  "00-inbounds.json",
  "09-tailscale-dns.json",
  "15-tailscale-endpoint.json",
  "29-tailscale-inbound-reject.json",
  "30-tailscale-route.json",
];

export function listIosModules(): string[] {
  return readdirSync(resolve(TEMPLATE_DIR, "modules-ios"))
    .filter((f) => f.endsWith(".json"))
    .sort();
}
