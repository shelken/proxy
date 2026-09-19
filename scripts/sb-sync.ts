#!/usr/bin/env bun
/**
 * sb-sync — 独立设备侧配置同步 CLI（可编译为任意 arm Mac 通用的单二进制）。
 *
 * 职责：拉取通用底模 → 拉订阅/节点 → 本机装配 → 融合设备 local 覆盖 → 原子产出。
 * 不依赖本仓库工作区：底模内嵌 + 远程固定源，配置与凭据全部落在 ~/.config/sing-box/。
 *
 * 命令：
 *   sb-sync init                 初始化设备目录与 config.toml
 *   sb-sync add sub <url>        追加机场订阅
 *   sb-sync add node <uri>       追加私有节点 URI（hy2/anytls/ss）
 *   sb-sync add local <file>     安装/更新设备 local 覆盖
 *   sb-sync list                 查看当前源清单
 *   sb-sync remove sub|node <#>  按序号移除
 *   sb-sync template update      手动刷新远程底模
 *   sb-sync template reset       丢弃远程底模，回退内嵌版
 *   sb-sync sync                 拉订阅 + 自动更新底模 + 装配 + 原子写产物
 *   sb-sync output               打印产物路径
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  buildConfig,
  findSingBox,
  mergeLocalConfig,
  setReservedTagsSource,
  type SingBoxTemplate,
} from "./endpoint.ts";
import templateEmbedded from "../config/sing-box/template.json" with { type: "json" };

// ---------------------------------------------------------------------------
// 常量与布局
// ---------------------------------------------------------------------------

/** 远程底模唯一信任源：仓库 main 分支（不接受任意 URL）。 */
const TEMPLATE_REMOTE_URL =
  "https://raw.githubusercontent.com/shelken/proxy/main/config/sing-box/template.json";

/** 设备配置根目录（XDG 惯例）。 */
export const SBSYNC_DIR = join(homedir(), ".config", "sing-box");

const STORE_PATH = join(SBSYNC_DIR, "store.json");
const LOCAL_PATH = join(SBSYNC_DIR, "local.json");
const STATE_PATH = join(SBSYNC_DIR, "state.json");
const TEMPLATE_CACHE_PATH = join(SBSYNC_DIR, "template.json");
const OUTPUT_PATH = join(SBSYNC_DIR, "singbox.json");

interface Store {
  subs: string[];
  nodes: string[];
  /** 远程底模拉取间隔秒数；0 = 每次 sync 都检查（默认）。 */
  templateAutoUpdate: boolean;
  /** 产物输出路径覆盖；默认 ~/.config/sing-box/singbox.json */
  output?: string;
}

interface State {
  templateSource: "embedded" | "remote" | "cache";
  templateFetchedAt?: string;
  lastSyncAt?: string;
  lastSyncOk?: boolean;
  lastError?: string;
}

const DEFAULT_STORE: Store = { subs: [], nodes: [], templateAutoUpdate: true };

// ---------------------------------------------------------------------------
// 基础设施：JSON 读写 + 原子写
// ---------------------------------------------------------------------------

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch (e) {
    throw new Error(`配置文件损坏，请修复后重试: ${path} (${(e as Error).message})`);
  }
}

function writeJsonAtomic(path: string, data: unknown): void {
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
  renameSync(tmp, path);
}

/**
 * 产物原子写：先写临时文件，check 通过后 rename；
 * 同时保留上一份可用产物为 .bak，新产物 check 失败时自动回滚。
 */
function writeOutputAtomic(finalPath: string, content: string, validate: (path: string) => void): void {
  const dir = dirname(finalPath);
  mkdirSync(dir, { recursive: true });
  const tmp = `${finalPath}.tmp.${process.pid}`;
  const bak = `${finalPath}.bak`;
  const hadPrevious = existsSync(finalPath);

  writeFileSync(tmp, content, "utf-8");
  try {
    validate(tmp);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw new Error(`新产物校验失败，已放弃写入（保留原产物）: ${(e as Error).message}`);
  }

  if (hadPrevious) copyFileSync(finalPath, bak);
  renameSync(tmp, finalPath);
}

// ---------------------------------------------------------------------------
// 底模：内嵌 → 缓存 → 远程，三级来源
// ---------------------------------------------------------------------------

/** 拉取远程底模原文；失败返回 null（由调用方决定回退层级）。
 * 用 curl 子进程而非 Bun fetch：Bun 内置 DNS/连接复用会固定到持有旧缓存的
 * Fastly 边缘节点（raw.githubusercontent 的 CDN 对 URL 长缓存），系统栈
 * (getaddrinfo) 则随 DNS 轮询拿到新节点。curl 走系统栈，保证底模更新即时可见。 */
async function fetchRemoteTemplate(): Promise<string | null> {
  try {
    const p = Bun.spawnSync([
      "curl", "-fsSL", "--max-time", "10",
      "-H", "cache-control: no-cache",
      TEMPLATE_REMOTE_URL,
    ]);
    if (p.exitCode !== 0) return null;
    const text = p.stdout.toString();
    JSON.parse(text); // 语法门禁：坏内容视同失败
    return text;
  } catch {
    return null;
  }
}

/**
 * 底模解析顺序：
 * 1. remote 强制刷新（template update / sync 自动更新）
 * 2. 设备缓存（上次成功拉取的远程版）
 * 3. 二进制内嵌版（出厂兜底，永远可用）
 */
async function loadTemplateForSync(forceRefresh: boolean): Promise<{ template: SingBoxTemplate; source: State["templateSource"] }> {
  if (forceRefresh || !existsSync(TEMPLATE_CACHE_PATH)) {
    const remote = await fetchRemoteTemplate();
    if (remote) {
      writeJsonAtomic(TEMPLATE_CACHE_PATH, JSON.parse(remote));
      return { template: JSON.parse(remote) as SingBoxTemplate, source: "remote" };
    }
    if (existsSync(TEMPLATE_CACHE_PATH)) {
      console.warn("[sb-sync] 远程底模拉取失败，使用本地缓存");
      return { template: readJson<SingBoxTemplate>(TEMPLATE_CACHE_PATH, null!), source: "cache" };
    }
    console.warn("[sb-sync] 远程底模拉取失败且无缓存，使用内嵌底模");
    return { template: structuredClone(templateEmbedded) as SingBoxTemplate, source: "embedded" };
  }
  return { template: readJson<SingBoxTemplate>(TEMPLATE_CACHE_PATH, structuredClone(templateEmbedded)), source: "cache" };
}

// ---------------------------------------------------------------------------
// 装配
// ---------------------------------------------------------------------------

async function assemble(store: Store, opts: { refreshTemplate: boolean }): Promise<{ content: string; source: State["templateSource"]; ruleSetCount: number }> {
  const { template, source } = await loadTemplateForSync(opts.refreshTemplate);
  // 单二进制态读不到仓库底模文件，标签唯一化必须以注入底模为准
  setReservedTagsSource(template);

  // 源列表契约：私有节点在前（Index 0 保序），机场订阅按添加顺序追加
  const parts = [...store.nodes, ...store.subs];
  if (parts.length === 0) {
    throw new Error("没有任何节点来源：先执行 sb-sync add sub/node");
  }

  const config = await buildConfig(
    { sources: parts.join("|"), localConfigPath: "" },
    { template },
  );

  // 设备 local 覆盖（~/.config/sing-box/local.json），禁用 endpoint 的仓库查找链
  if (existsSync(LOCAL_PATH)) {
    mergeLocalConfig(config, JSON.parse(readFileSync(LOCAL_PATH, "utf-8")));
  }

  const content = JSON.stringify(config, null, 2) + "\n";
  return { content, source, ruleSetCount: (config.route?.rule_set as unknown[])?.length ?? 0 };
}

// ---------------------------------------------------------------------------
// 命令实现
// ---------------------------------------------------------------------------

function ensureDir(): void {
  mkdirSync(SBSYNC_DIR, { recursive: true });
}

function loadStore(): Store {
  return readJson<Store>(STORE_PATH, { ...DEFAULT_STORE });
}

function saveStore(store: Store): void {
  writeJsonAtomic(STORE_PATH, store);
}

function cmdInit(): void {
  ensureDir();
  if (!existsSync(STORE_PATH)) saveStore(DEFAULT_STORE);
  if (!existsSync(LOCAL_PATH)) {
    writeJsonAtomic(LOCAL_PATH, {
      _comment: "设备特有覆盖：dns.servers / dns.rules / route.rules。参考仓库 local.json.example",
    });
  }
  console.log(`已初始化 ${SBSYNC_DIR}`);
  console.log(`下一步: sb-sync add sub <订阅URL> && sb-sync add node <节点URI> && sb-sync sync`);
}

function cmdAdd(kind: "sub" | "node" | "local", value: string): void {
  ensureDir();
  const store = loadStore();
  if (kind === "local") {
    const src = resolve(process.cwd(), value);
    if (!existsSync(src)) throw new Error(`local 文件不存在: ${src}`);
    const parsed = JSON.parse(readFileSync(src, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("local 文件必须是 JSON 对象");
    }
    copyFileSync(src, LOCAL_PATH);
    console.log(`已安装设备 local 覆盖 → ${LOCAL_PATH}`);
    return;
  }
  const list = kind === "sub" ? store.subs : store.nodes;
  if (list.includes(value)) {
    console.log("已存在，跳过");
    return;
  }
  list.push(value);
  saveStore(store);
  console.log(`已添加 ${kind} #${list.length}`);
}

function cmdList(): void {
  const store = loadStore();
  console.log(`机场订阅 (${store.subs.length}):`);
  store.subs.forEach((s, i) => console.log(`  [${i + 1}] ${maskUrl(s)}`));
  console.log(`私有节点 (${store.nodes.length}):`);
  store.nodes.forEach((n, i) => console.log(`  [${i + 1}] ${maskUri(n)}`));
  console.log(`local 覆盖: ${existsSync(LOCAL_PATH) ? LOCAL_PATH : "(未配置)"}`);
  const state = readJson<State>(STATE_PATH, { templateSource: "embedded" });
  console.log(`底模来源: ${state.templateSource} | 上次同步: ${state.lastSyncAt ?? "从未"} ${state.lastSyncOk === false ? `(上次失败: ${state.lastError})` : ""}`);
}

function cmdRemove(kind: "sub" | "node", indexStr: string): void {
  const index = parseInt(indexStr, 10);
  if (Number.isNaN(index) || index < 1) throw new Error("序号必须是 >= 1 的整数");
  const store = loadStore();
  const list = kind === "sub" ? store.subs : store.nodes;
  if (index > list.length) throw new Error(`序号超出范围（共 ${list.length} 项）`);
  const [removed] = list.splice(index - 1, 1);
  saveStore(store);
  console.log(`已移除 ${kind} #${index}: ${kind === "sub" ? maskUrl(removed) : maskUri(removed)}`);
}

async function cmdTemplateUpdate(reset: boolean): Promise<void> {
  ensureDir();
  if (reset) {
    rmSync(TEMPLATE_CACHE_PATH, { force: true });
    console.log("已清除远程底模缓存，回退内嵌版");
    return;
  }
  const remote = await fetchRemoteTemplate();
  if (!remote) throw new Error("远程底模拉取失败（网络或源不可用），缓存未动");
  writeJsonAtomic(TEMPLATE_CACHE_PATH, JSON.parse(remote));
  const state = readJson<State>(STATE_PATH, { templateSource: "embedded" });
  state.templateSource = "remote";
  state.templateFetchedAt = new Date().toISOString();
  writeJsonAtomic(STATE_PATH, state);
  console.log(`底模已更新（${TEMPLATE_REMOTE_URL}）`);
}

async function cmdSync(): Promise<void> {
  ensureDir();
  const store = loadStore();
  const started = Date.now();

  let result: { content: string; source: State["templateSource"]; ruleSetCount: number };
  try {
    result = await assemble(store, { refreshTemplate: store.templateAutoUpdate });
    const state = readJson<State>(STATE_PATH, { templateSource: "embedded" });
    state.templateSource = result.source;
    state.templateFetchedAt = result.source === "remote" ? new Date().toISOString() : state.templateFetchedAt;
    state.lastSyncAt = new Date().toISOString();
    state.lastSyncOk = true;
    state.lastError = undefined;
    writeJsonAtomic(STATE_PATH, state);
  } catch (e) {
    const state = readJson<State>(STATE_PATH, { templateSource: "embedded" });
    state.lastSyncAt = new Date().toISOString();
    state.lastSyncOk = false;
    state.lastError = (e as Error).message;
    writeJsonAtomic(STATE_PATH, state);
    throw e;
  }

  const output = resolve(store.output ?? OUTPUT_PATH);
  const singBox = findSingBox();
  writeOutputAtomic(output, result.content, (path) => {
    const check = Bun.spawnSync([singBox, "check", "-c", path]);
    if (check.exitCode !== 0) {
      throw new Error(check.stderr.toString().trim() || check.stdout.toString().trim() || "sing-box check 未知失败");
    }
  });

  console.log(`[sb-sync] 完成 (${Date.now() - started}ms)`);
  console.log(`  底模: ${result.source} | 规则集: ${result.ruleSetCount}`);
  console.log(`  产物: ${output}`);
}

// ---------------------------------------------------------------------------
// 隐私掩码
// ---------------------------------------------------------------------------

function maskUrl(url: string): string {
  return url.replace(/([?&](?:token|key|password)\/?=?)[^&]+/gi, "$1***");
}

function maskUri(uri: string): string {
  const scheme = uri.split("://")[0];
  return `${scheme}://***${uri.includes("#") ? `#${uri.split("#")[1]}` : ""}`;
}

/** check：对本地产物做全项验证（结构、check、local 合并痕迹），零网络。 */
function cmdCheck(): void {
  const output = resolve(loadStore().output ?? OUTPUT_PATH);
  if (!existsSync(output)) {
    throw new Error(`产物不存在: ${output}（先执行 sb-sync sync）`);
  }
  const state = readJson<State>(STATE_PATH, { templateSource: "embedded" });
  const cfg = JSON.parse(readFileSync(output, "utf-8")) as SingBoxTemplate;

  // 1. 内核语法校验（不启动、不接管网络）
  const check = Bun.spawnSync([findSingBox(), "check", "-c", output]);
  if (check.exitCode !== 0) {
    throw new Error(check.stderr.toString().trim() || "sing-box check 失败");
  }

  const nodes = (cfg.outbounds ?? []).filter((o) => typeof o.server === "string");
  const selectors = (cfg.outbounds ?? []).filter((o) => o.type === "selector");
  const ruleSets = (cfg.route?.rule_set as Array<{ tag?: string }>)?.length ?? 0;
  const localApplied =
    (cfg.dns?.rules as Array<Record<string, unknown>>)?.[0]?.domain_suffix !== undefined ||
    (cfg.route?.rules as Array<Record<string, unknown>>)?.[0]?.domain_suffix !== undefined;

  console.log(`产物:     ${output}`);
  console.log(`底模来源: ${state.templateSource} | 上次同步: ${state.lastSyncAt ?? "从未"}${state.lastSyncOk === false ? " (失败!)" : " (OK)"}`);
  console.log(`节点:     ${nodes.length} 个 (首选 ${nodes[0]?.tag ?? "-"})`);
  console.log(`策略组:   ${selectors.length} 个 | 规则集: ${ruleSets} 份`);
  console.log(`local 覆盖: ${existsSync(LOCAL_PATH) ? (localApplied ? "已注入 ✓" : "存在但产物未见注入(可能为空)") : "未配置"}`);
  console.log(`sing-box check: 通过 ✓`);
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "init":
      cmdInit();
      break;
    case "add": {
      const [kind, value] = rest;
      if (kind !== "sub" && kind !== "node" && kind !== "local") {
        throw new Error("add 用法: sb-sync add sub|node|local <值>");
      }
      if (!value) throw new Error("add 缺少值");
      cmdAdd(kind, value);
      break;
    }
    case "remove": {
      const [kind, index] = rest;
      if (kind !== "sub" && kind !== "node") throw new Error("remove 用法: sb-sync remove sub|node <序号>");
      cmdRemove(kind, index ?? "");
      break;
    }
    case "list":
      cmdList();
      break;
    case "template": {
      const action = rest[0];
      if (action === "update") await cmdTemplateUpdate(false);
      else if (action === "reset") await cmdTemplateUpdate(true);
      else throw new Error("template 用法: sb-sync template update|reset");
      break;
    }
    case "sync":
      await cmdSync();
      break;
    case "output":
      console.log(resolve(loadStore().output ?? OUTPUT_PATH));
      break;
    case "check":
      cmdCheck();
      break;
    default:
      console.error(
        [
          "sb-sync — 设备侧 sing-box 配置同步器",
          "",
          "用法:",
          "  sb-sync init                  初始化设备目录",
          "  sb-sync add sub <url>         追加机场订阅",
          "  sb-sync add node <uri>        追加私有节点",
          "  sb-sync add local <file>      安装设备 local 覆盖",
          "  sb-sync list                  查看源清单与状态",
          "  sb-sync remove sub|node <#>   移除指定源",
          "  sb-sync template update|reset 手动刷新/重置远程底模",
          "  sb-sync sync                  拉订阅+自动更新底模+原子产出",
          "  sb-sync check                 验证本地产物（零网络）",
          "  sb-sync output                打印产物路径",
        ].join("\n"),
      );
      process.exit(cmd ? 1 : 0);
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`ERROR: ${(error as Error).message}`);
    process.exit(1);
  });
}
