// 跨模板契约：顺序与引用闭合，Mac 与 iOS 用同一套断言（ADR-0012）。
//
// 这份测试存在的理由：`sing-box check` 不覆盖 tag 引用与规则顺序，而这两者都决定行为。
// 单个模板自己的结构测试（template.test.ts / ios-template.test.ts）只锁本模板的细节，
// 这里锁的是「任何一侧改动都会被两侧同时检查」的那部分。

import { describe, expect, test } from "bun:test";
import {
  DNS_ORDER,
  IOS_MODULE_WHITELIST,
  ROUTE_ORDER,
  asArray,
  assertOrder,
  assertRefsClosed,
  listIosModules,
  loadTemplate,
} from "./lib/contract.ts";

const mac = await loadTemplate("template.json");
const ios = await loadTemplate("template-ios.json");

describe("引用闭合：内核 check 只做 box.New，不解析 tag 引用", () => {
  test("template.json 的每个 tag 引用都有对应声明", () => {
    expect(() => assertRefsClosed(mac, "template.json")).not.toThrow();
  });

  test("template-ios.json 的每个 tag 引用都有对应声明", () => {
    expect(() => assertRefsClosed(ios, "template-ios.json")).not.toThrow();
  });
});

describe("路由顺序契约", () => {
  test("template.json 的关键规则按契约次序排列", () => {
    expect(() =>
      assertOrder(asArray(mac.route?.rules), ROUTE_ORDER, { ios: false }),
    ).not.toThrow();
  });

  test("template-ios.json 的关键规则按契约次序排列（含 Tailscale 锚点）", () => {
    expect(() =>
      assertOrder(asArray(ios.route?.rules), ROUTE_ORDER, { ios: true }),
    ).not.toThrow();
  });
});

describe("DNS 顺序契约", () => {
  test("template.json 的 DNS 规则按契约次序排列", () => {
    expect(() =>
      assertOrder(asArray(mac.dns?.rules), DNS_ORDER, { ios: false }),
    ).not.toThrow();
  });

  test("template-ios.json 的 DNS 规则按契约次序排列（含 Tailscale 锚点）", () => {
    expect(() =>
      assertOrder(asArray(ios.dns?.rules), DNS_ORDER, { ios: true }),
    ).not.toThrow();
  });
});

describe("iOS 差异面白名单（ADR-0010）", () => {
  test("modules-ios/ 的文件集合等于已登记的白名单", () => {
    expect(listIosModules()).toEqual([...IOS_MODULE_WHITELIST].sort());
  });

  test("白名单里的文件都真实存在", () => {
    const actual = new Set(listIosModules());
    for (const name of IOS_MODULE_WHITELIST) {
      expect(actual.has(name)).toBe(true);
    }
  });
});
