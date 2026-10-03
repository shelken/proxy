#!/usr/bin/env bun
/**
 * 模板构建器：`config/sing-box/modules/` -> `config/sing-box/template.json`
 *
 * 将按功能拆分的配置模块装配为 sing-box 标准底模。
 *
 * 用法：
 *   bun scripts/template-build.ts          # 合成并写入 template.json
 *   bun scripts/template-build.ts --check  # 校验当前 template.json 是否与模块定义一致（CI / pre-commit）
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const MODULES_DIR = join(ROOT, "config/sing-box/modules");
const TEMPLATE_PATH = join(ROOT, "config/sing-box/template.json");

export interface SingBoxTemplate {
  inbounds?: unknown[];
  dns?: {
    strategy?: string;
    optimistic?: boolean;
    servers?: unknown[];
    rules?: unknown[];
    final?: string;
    [key: string]: unknown;
  };
  route?: {
    auto_detect_interface?: boolean;
    rules?: unknown[];
    final?: string;
    default_domain_resolver?: unknown;
    default_http_client?: string;
    rule_set?: unknown[];
    [key: string]: unknown;
  };
  http_clients?: unknown[];
  outbounds?: unknown[];
  experimental?: Record<string, unknown>;
  [key: string]: unknown;
}

export function assembleTemplate(modulesDir: string = MODULES_DIR): string {
  const fileNames = readdirSync(modulesDir)
    .filter((f: string) => f.endsWith(".json"))
    .sort();

  const result: SingBoxTemplate = {
    inbounds: [],
    dns: {
      strategy: "",
      optimistic: false,
      servers: [],
      rules: [],
      final: ""
    },
    route: {
      auto_detect_interface: true,
      rules: [],
      final: "",
      default_domain_resolver: null,
      default_http_client: "",
      rule_set: []
    },
    http_clients: [],
    outbounds: [],
    experimental: {}
  };

  for (const file of fileNames) {
    const raw = readFileSync(join(modulesDir, file), "utf-8");
    const mod: SingBoxTemplate = JSON.parse(raw);

    if (mod.inbounds) {
      result.inbounds!.push(...mod.inbounds);
    }
    if (mod.dns) {
      if (mod.dns.strategy) result.dns!.strategy = mod.dns.strategy;
      if (mod.dns.optimistic !== undefined) result.dns!.optimistic = mod.dns.optimistic;
      if (mod.dns.final) result.dns!.final = mod.dns.final;
      if (mod.dns.servers) result.dns!.servers!.push(...mod.dns.servers);
      if (mod.dns.rules) result.dns!.rules!.push(...mod.dns.rules);
    }
    if (mod.route) {
      if (mod.route.auto_detect_interface !== undefined) {
        result.route!.auto_detect_interface = mod.route.auto_detect_interface;
      }
      if (mod.route.final) result.route!.final = mod.route.final;
      if (mod.route.default_domain_resolver !== undefined) {
        result.route!.default_domain_resolver = mod.route.default_domain_resolver;
      }
      if (mod.route.default_http_client) {
        result.route!.default_http_client = mod.route.default_http_client;
      }
      if (mod.route.rules) result.route!.rules!.push(...mod.route.rules);
      if (mod.route.rule_set) result.route!.rule_set!.push(...mod.route.rule_set);
    }
    if (mod.http_clients) {
      result.http_clients!.push(...mod.http_clients);
    }
    if (mod.outbounds) {
      result.outbounds!.push(...mod.outbounds);
    }
    if (mod.experimental) {
      result.experimental = { ...result.experimental, ...mod.experimental };
    }
  }

  // 严格保持底模预期的顶层与嵌套字段顺序
  const output: SingBoxTemplate = {
    inbounds: result.inbounds,
    dns: result.dns,
    route: {
      auto_detect_interface: result.route!.auto_detect_interface,
      rules: result.route!.rules,
      final: result.route!.final,
      default_domain_resolver: result.route!.default_domain_resolver,
      default_http_client: result.route!.default_http_client,
      rule_set: result.route!.rule_set
    },
    http_clients: result.http_clients,
    outbounds: result.outbounds,
    experimental: result.experimental
  };

  let json = JSON.stringify(output, null, 2);

  // 保持单行简写与既有排版完全一致
  json = json
    .replace(
      /\"domain_suffix\": \[\n\s+\"\.int\.ooooo\.space\"\n\s+\]/,
      "\"domain_suffix\": [\".int.ooooo.space\"]"
    )
    .replace(
      /\"query_type\": \[\n\s+\"A\"\n\s+\]/,
      "\"query_type\": [\"A\"]"
    )
    .replace(
      /\"answer\": \[\n\s+\"\*\. IN A 192\.168\.69\.46\"\n\s+\]/,
      "\"answer\": [\"*. IN A 192.168.69.46\"]"
    )
    .replace(
      /\"domain_suffix\": \[\n\s+\"int\.ooooo\.space\"\n\s+\]/,
      "\"domain_suffix\": [\"int.ooooo.space\"]"
    );

  return json + "\n";
}

if (import.meta.main) {
  const isCheck = process.argv.includes("--check");
  const built = assembleTemplate();

  if (isCheck) {
    const current = readFileSync(TEMPLATE_PATH, "utf-8");
    if (built !== current) {
      console.error("❌ config/sing-box/template.json 与 modules/ 不一致，请运行 just template-build 更新底模");
      process.exit(1);
    }
    console.log("✅ config/sing-box/template.json 与 modules/ 检查一致");
  } else {
    writeFileSync(TEMPLATE_PATH, built);
    console.log("✅ 成功装配 modules -> config/sing-box/template.json");
  }
}
