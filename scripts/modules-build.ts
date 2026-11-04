#!/usr/bin/env bun
// sing-box 底模装配：config/sing-box/modules.yaml + fragments/ → 三份平台模板。
// 合并顺序只在 modules.yaml 的 roles 列表里；能力开关由「条目不在列表里」表达。
// 产物形态完全由 sing-box merge 决定，本脚本只负责物化输入。
//
// 用法:
//   bun scripts/modules-build.ts            # 生成三份产物
//   bun scripts/modules-build.ts --check    # 与磁盘产物比对，不同则退出码 1

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const CONFIG = join(ROOT, "config/sing-box");
const FRAGMENTS = join(CONFIG, "fragments");
const MANIFEST = join(CONFIG, "modules.yaml");

// role → 产物文件。与 justfile/CI 现有路径一致。
const OUTPUTS: Record<string, string> = {
  mac: "template.json",
  ios: "template-ios.json",
  router: "template-router.json",
};

// SING_BOX 可能是多词命令（默认 mise exec -- sing-box），按词展开
const SING_BOX = (process.env.SING_BOX ?? "mise exec -- sing-box").split(/\s+/);

type Item = { fragment: string } | { service: string } | { catalog: string };
type Service = {
  rule_set: string;
  outbound: string;
  group: { outbounds: string[]; default: string };
};
type Manifest = {
  rule_set_url: string;
  services: Service[];
  catalog: Record<string, string[]>;
  roles: Record<string, Item[]>;
};

const manifest: Manifest = Bun.YAML.parse(await Bun.file(MANIFEST).text()) as Manifest;

const unknownRoles = Object.keys(manifest.roles).filter((r) => !(r in OUTPUTS));
if (unknownRoles.length) throw new Error(`modules.yaml 的 role 没有对应产物: ${unknownRoles.join(", ")}`);

// rule set 定义块的字段顺序必须与主线文件一致
function ruleSetBlock(tag: string) {
  return {
    type: "remote",
    tag,
    format: "binary",
    url: manifest.rule_set_url.replace("{tag}", tag),
    update_interval: "1d",
  };
}

async function materialize(role: string): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const items = manifest.roles[role];
  if (!items) throw new Error(`modules.yaml 缺少 role: ${role}`);

  const dir = await mkdtemp(join(tmpdir(), `sing-box-${role}-`));
  const cleanup = () => rm(dir, { recursive: true, force: true });
  const seen = new Set<string>();

  try {
    for (const [i, item] of items.entries()) {
      const slug =
        "fragment" in item
          ? item.fragment.split("/").pop()!.replace(/\.json$/, "")
          : "service" in item
            ? `service-${item.service}`
            : `catalog-${item.catalog}`;
      if (seen.has(slug)) throw new Error(`role ${role}: 条目 slug 重复 (${slug})，物化文件会互相覆盖`);
      seen.add(slug);

      let doc: unknown;
      if ("fragment" in item) {
        const src = join(FRAGMENTS, item.fragment);
        if (!existsSync(src)) throw new Error(`片段不存在: ${item.fragment}`);
        doc = await Bun.file(src).json();
      } else if ("service" in item) {
        const svc = manifest.services.find((s) => s.outbound === item.service);
        if (!svc) throw new Error(`服务不存在: ${item.service}`);
        doc = {
          route: {
            rules: [{ rule_set: [svc.rule_set], action: "route", outbound: svc.outbound }],
            rule_set: [ruleSetBlock(svc.rule_set)],
          },
          outbounds: [
            {
              type: "selector",
              tag: svc.outbound,
              outbounds: svc.group.outbounds,
              default: svc.group.default,
              interrupt_exist_connections: true,
            },
          ],
        };
      } else {
        const tags = manifest.catalog[item.catalog];
        if (!tags) throw new Error(`清单组不存在: ${item.catalog}`);
        doc = { route: { rule_set: tags.map(ruleSetBlock) } };
      }
      // 最终排版由 sing-box merge 决定，这里只保证 JSON 语义。
      await writeFile(join(dir, `${String(i).padStart(4, "0")}-${slug}.json`), JSON.stringify(doc, null, 2) + "\n");
    }
  } catch (e) {
    await cleanup();
    throw e;
  }

  return { dir, cleanup };
}

function firstDiff(a: Uint8Array, b: Uint8Array): string | null {
  if (a.length === b.length && a.every((v, i) => v === b[i])) return null;
  let i = 0;
  while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
  let line = 1;
  for (let j = 0; j < i; j++) if (a[j] === 0x0a) line++;
  const ctx = (buf: Uint8Array) =>
    JSON.stringify(new TextDecoder().decode(buf.subarray(Math.max(0, i - 30), i + 30)));
  return `字节 ${i} (行 ${line}): 磁盘 ${ctx(b)} != 重算 ${ctx(a)}`;
}

const check = Bun.argv.includes("--check");
let failed = false;

for (const [role, output] of Object.entries(OUTPUTS)) {
  const { dir, cleanup } = await materialize(role);
  let scratch: string | null = null;
  try {
    // 放进 try：这一步失败时也要走 cleanup，否则物化目录会残留
    scratch = check ? await mkdtemp(join(tmpdir(), "sing-box-out-")) : null;
    const out = scratch ? join(scratch, "template.json") : join(CONFIG, output);
    const proc = Bun.spawnSync([...SING_BOX, "merge", out, "-C", dir], { stdio: ["ignore", "inherit", "inherit"] });
    if (proc.exitCode !== 0) throw new Error(`sing-box merge 失败 (role ${role}): exit ${proc.exitCode}`);
    if (!scratch) {
      console.log(`${output}: 已生成`);
      continue;
    }
    const diff = firstDiff(await Bun.file(out).bytes(), await Bun.file(join(CONFIG, output)).bytes());
    if (diff) {
      failed = true;
      console.error(`${output}: 与重算结果不一致 — ${diff}`);
    } else {
      console.log(`${output}: OK`);
    }
  } finally {
    await cleanup();
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
}

if (failed) process.exit(1);
