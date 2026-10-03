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

  const topLevel: Record<string, unknown> = {};
  const inbounds: unknown[] = [];
  const httpClients: unknown[] = [];
  const outbounds: unknown[] = [];
  const experimental: Record<string, unknown> = {};

  const dnsProps: Record<string, unknown> = {};
  const dnsServers: unknown[] = [];
  const dnsRules: unknown[] = [];

  const routeProps: Record<string, unknown> = {};
  const routeRules: unknown[] = [];
  const routeRuleSet: unknown[] = [];

  for (const file of fileNames) {
    const raw = readFileSync(join(modulesDir, file), "utf-8");
    const mod: Record<string, any> = JSON.parse(raw);

    // 处理顶层字段
    for (const [key, value] of Object.entries(mod)) {
      if (value === undefined) continue;

      if (key === "inbounds" && Array.isArray(value)) {
        inbounds.push(...value);
      } else if (key === "http_clients" && Array.isArray(value)) {
        httpClients.push(...value);
      } else if (key === "outbounds" && Array.isArray(value)) {
        outbounds.push(...value);
      } else if (key === "experimental" && typeof value === "object" && value !== null) {
        Object.assign(experimental, value);
      } else if (key === "dns" && typeof value === "object" && value !== null) {
        for (const [dKey, dVal] of Object.entries(value)) {
          if (dVal === undefined) continue;
          if (dKey === "servers" && Array.isArray(dVal)) {
            dnsServers.push(...dVal);
          } else if (dKey === "rules" && Array.isArray(dVal)) {
            dnsRules.push(...dVal);
          } else {
            dnsProps[dKey] = dVal;
          }
        }
      } else if (key === "route" && typeof value === "object" && value !== null) {
        for (const [rKey, rVal] of Object.entries(value)) {
          if (rVal === undefined) continue;
          if (rKey === "rules" && Array.isArray(rVal)) {
            routeRules.push(...rVal);
          } else if (rKey === "rule_set" && Array.isArray(rVal)) {
            routeRuleSet.push(...rVal);
          } else {
            routeProps[rKey] = rVal;
          }
        }
      } else {
        // 其余任意顶层字段（如 log, ntp 等）保留
        topLevel[key] = value;
      }
    }
  }

  // 组装 DNS 对象（遵循标准字段次序，保留未列出的任意合法字段）
  const finalDns: Record<string, unknown> = {};
  if ("strategy" in dnsProps) finalDns.strategy = dnsProps.strategy;
  if ("optimistic" in dnsProps) finalDns.optimistic = dnsProps.optimistic;
  finalDns.servers = dnsServers;
  finalDns.rules = dnsRules;
  if ("final" in dnsProps) finalDns.final = dnsProps.final;
  for (const [k, v] of Object.entries(dnsProps)) {
    if (!(k in finalDns)) {
      finalDns[k] = v;
    }
  }

  // 组装 Route 对象（遵循标准字段次序，保留未列出的任意合法字段）
  const finalRoute: Record<string, unknown> = {};
  if ("auto_detect_interface" in routeProps) finalRoute.auto_detect_interface = routeProps.auto_detect_interface;
  finalRoute.rules = routeRules;
  if ("final" in routeProps) finalRoute.final = routeProps.final;
  if ("default_domain_resolver" in routeProps) finalRoute.default_domain_resolver = routeProps.default_domain_resolver;
  if ("default_http_client" in routeProps) finalRoute.default_http_client = routeProps.default_http_client;
  finalRoute.rule_set = routeRuleSet;
  for (const [k, v] of Object.entries(routeProps)) {
    if (!(k in finalRoute)) {
      finalRoute[k] = v;
    }
  }

  // 组装顶层输出对象（标准键前置，其余未列出的顶层键保留在末尾）
  const output: Record<string, unknown> = {
    inbounds,
    dns: finalDns,
    route: finalRoute,
    http_clients: httpClients,
    outbounds,
    experimental,
    ...topLevel
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
