// modules.yaml 是底模装配的唯一真源：合并顺序在 roles 列表里，能力开关由「条目不在列表里」表达。
// 这三份结构测试原来各自断言自己那份模块目录的文件名集合，模块目录收成一张表之后，
// 改成在这里断言角色条目：顺序（MAC_ORDER + 变体补丁）与差异面（变体片段目录）。
// 产物语义仍由读产物的断言保证，这里只守「表写成什么样」。
import { expect } from "bun:test";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

export type Item = { fragment: string } | { service: string } | { catalog: string };

export const CONFIG_DIR = resolve(import.meta.dir, "..", "..");
export const FRAGMENTS_DIR = join(CONFIG_DIR, "fragments");

export const manifest = Bun.YAML.parse(
  await Bun.file(join(CONFIG_DIR, "modules.yaml")).text(),
) as {
  services: Array<{ rule_set: string; outbound: string }>;
  catalog: Record<string, string[]>;
  roles: Record<string, Item[]>;
};

// 每条目一个稳定 key（片段带目录，服务与清单带 kind）：失败输出里直接看出错的是哪一条
export const itemKey = (item: Item): string =>
  "fragment" in item
    ? `fragment:${item.fragment}`
    : "service" in item
      ? `service:${item.service}`
      : `catalog:${item.catalog}`;

export const roleKeys = (role: string): string[] => {
  const items = manifest.roles[role];
  if (!items) throw new Error(`modules.yaml 缺少 role: ${role}`);
  return items.map(itemKey);
};

// 基准顺序 = mac 的 roles 列表，逐条照抄；任何重排都会在这里显示成测试改动，逼一次复核。
// 顺序不是排版：文件名序同时决定 route.rules（首匹配优先）与 outbounds（客户端展示顺序）。
export const MAC_ORDER = [
  "fragment:base/inbounds.json",
  "fragment:base/dns-policy.json",
  "catalog:dns",
  "fragment:base/route-globals.json",
  "fragment:base/sniff-and-dns-hijack.json",
  "fragment:base/outbound-groups.json",
  "fragment:base/private-direct.json",
  "fragment:base/reject.json",
  "catalog:reject",
  "fragment:base/quic-guard.json",
  "fragment:base/clash-mode.json",
  "fragment:base/torrent.json",
  "fragment:base/download.json",
  "catalog:download",
  "fragment:base/resolve.json",
  "fragment:base/own-lists.json",
  "catalog:own-lists",
  "service:gemini",
  "service:openai",
  "service:anthropic",
  "service:appleai",
  "service:opencode",
  "service:zai",
  "service:grok",
  "service:1024proxy",
  "service:dev",
  "service:ptcg",
  "service:japansite",
  "service:adultnsfw",
  "fragment:base/http-clients.json",
  "service:microsoft",
  "service:paypal",
  "service:apple",
  "fragment:base/route-tail.json",
  "catalog:route-tail",
  "fragment:base/experimental.json",
];

// 变体 = 基准顺序上的注册补丁。位置是语义：插错地方等于换了首匹配顺序或展示顺序。
export type VariantPatch = {
  /** 该平台片段目录下允许存在的片段（相对 fragments/ 的路径），即平台差异面 */
  fragments: string[];
  /** 变体片段顶替 base 里的同名能力 */
  replace: Array<{ from: string; to: string }>;
  /** 在锚点条目之后插入的片段 */
  insertAfter: Array<{ anchor: string; items: string[] }>;
};

export const applyPatch = (base: string[], patch: VariantPatch): string[] => {
  const out = base.map((key) => patch.replace.find((r) => r.from === key)?.to ?? key);
  for (const { anchor, items } of patch.insertAfter) {
    const at = out.indexOf(anchor);
    if (at < 0) throw new Error(`基准顺序里没有锚点: ${anchor}`);
    out.splice(at + 1, 0, ...items);
  }
  return out;
};

// 拆出来单独可测：变异验证要直接喂一份被打乱顺序的 key 列表
export const assertOrder = (actual: string[], expected: string[]) => {
  expect(actual).toEqual(expected);
};

export const assertRoleOrder = (role: string, expected: string[]) => {
  assertOrder(roleKeys(role), expected);
};

/** 变体片段目录的文件名集合必须与注册的差异面一致，防止无意扩大平台差异 */
export const assertFragmentDir = (dirname: string, registered: string[]) => {
  expect(readdirSync(join(FRAGMENTS_DIR, dirname)).sort()).toEqual(
    registered.map((rel) => rel.slice(dirname.length + 1)).sort(),
  );
};

/** 表里不得有死条目：fragments/ 下没人引用的片段、services 里没被引用的服务、catalog 里没被引用的组。
 *  与「能力开关是不列入」互为反面：删掉某个角色列表里的条目就是关掉它，表里那一行必须跟着消失 */
export const assertNoOrphanEntries = () => {
  const used = new Set(Object.values(manifest.roles).flat().map(itemKey));
  const declared = [
    ...readdirSync(FRAGMENTS_DIR, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? readdirSync(join(FRAGMENTS_DIR, entry.name)).map((f) => `fragment:${entry.name}/${f}`)
        : [`fragment:${entry.name}`],
    ),
    ...manifest.services.map((svc) => `service:${svc.outbound}`),
    ...Object.keys(manifest.catalog).map((name) => `catalog:${name}`),
  ];
  expect(declared.filter((key) => !used.has(key))).toEqual([]);
};
