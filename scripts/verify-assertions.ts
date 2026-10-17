#!/usr/bin/env bun
// 变异验证：确认断言真的锁住了取值，而不是恒真。
//
// 做法：把底模目录整体复制到临时位置，对副本施加一处已知有害的改动，再跑真实测试。
// 断言必须失败——若变异被放行，说明对应的断言是恒真的，脚本报错。
//
// 两个自检，避免脚本本身空转：
//   1. 每个变异必须真的改变 JSON 内容，否则说明字段路径写错了
//   2. 未施加变异时测试必须通过，否则说明基线就是红的，后续「失败」没有意义

import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const TEMPLATE_DIR = join(REPO, "config/sing-box");
const TEST_FILE = join(TEMPLATE_DIR, "tests/order-contract.test.ts");

type Rule = Record<string, any>;
type Mutation = {
  name: string;
  /** 被破坏的底模；null 表示改动发生在目录层面而非单个文件 */
  template: "template.json" | "template-ios.json" | null;
  /** 返回改动说明，用于确认改动真的发生了 */
  apply: (template: Rule) => string;
};

const asArray = <T,>(v: T | T[] | undefined | null): T[] =>
  v === undefined || v === null ? [] : Array.isArray(v) ? v : [v];

const indexOfRule = (rules: Rule[], pred: (r: Rule) => boolean): number => {
  const i = rules.findIndex(pred);
  if (i < 0) throw new Error("变异目标规则不存在，请更新变异定义");
  return i;
};

const MUTATIONS: Mutation[] = [
  {
    name: "route.rules[].outbound 指向不存在的组",
    template: "template-ios.json",
    apply: (t) => {
      const rules = t.route.rules as Rule[];
      const i = indexOfRule(rules, (r) => r.outbound === "proxy");
      rules[i].outbound = "no-such-group";
      return `route.rules[${i}].outbound -> no-such-group`;
    },
  },
  {
    name: "route.final 悬空",
    template: "template-ios.json",
    apply: (t) => {
      t.route.final = "no-such-group";
      return "route.final -> no-such-group";
    },
  },
  {
    name: "route.rules[].rule_set 指向未声明的清单",
    template: "template-ios.json",
    apply: (t) => {
      const rules = t.route.rules as Rule[];
      const i = indexOfRule(rules, (r) => asArray(r.rule_set).includes("OpenAI"));
      rules[i].rule_set = "NoSuchRuleSet";
      return `route.rules[${i}].rule_set -> NoSuchRuleSet`;
    },
  },
  {
    name: "route.rules[].server 指向不存在的 DNS 服务器",
    template: "template-ios.json",
    apply: (t) => {
      const rules = t.route.rules as Rule[];
      const i = indexOfRule(rules, (r) => r.action === "resolve");
      rules[i].server = "no-such-dns";
      return `route.rules[${i}].server -> no-such-dns`;
    },
  },
  {
    name: "dns.servers[].endpoint 指向不存在的 endpoint",
    template: "template-ios.json",
    apply: (t) => {
      const servers = t.dns.servers as Rule[];
      const i = indexOfRule(servers, (s) => s.type === "tailscale");
      servers[i].endpoint = "no-such-endpoint";
      return `dns.servers[${i}].endpoint -> no-such-endpoint`;
    },
  },
  {
    name: "私网直连提到 Tailscale 接管之前（子网路由失效）",
    template: "template-ios.json",
    apply: (t) => {
      const rules = t.route.rules as Rule[];
      const priv = indexOfRule(rules, (r) => r.ip_is_private === true);
      const toTs = indexOfRule(rules, (r) => asArray(r.preferred_by).length > 0);
      const [moved] = rules.splice(priv, 1);
      rules.splice(toTs, 0, moved);
      return `route.rules: ip_is_private 从 ${priv} 移到 ${toTs}`;
    },
  },
  {
    name: "DNS 劫持提到 sniff 之前（域名匹配失效）",
    template: "template.json",
    apply: (t) => {
      const rules = t.route.rules as Rule[];
      const sniff = indexOfRule(rules, (r) => r.action === "sniff");
      const hijack = indexOfRule(rules, (r) => r.action === "hijack-dns");
      const [moved] = rules.splice(hijack, 1);
      rules.splice(sniff, 0, moved);
      return `route.rules: hijack-dns 从 ${hijack} 移到 ${sniff}`;
    },
  },
  {
    name: "拦截提到私网直连之前（私网流量被误拦）",
    template: "template.json",
    apply: (t) => {
      const rules = t.route.rules as Rule[];
      const priv = indexOfRule(rules, (r) => r.ip_is_private === true);
      const reject = indexOfRule(rules, (r) => asArray(r.rule_set).includes("Advertising"));
      const [moved] = rules.splice(reject, 1);
      rules.splice(priv, 0, moved);
      return `route.rules: Advertising reject 从 ${reject} 移到 ${priv}`;
    },
  },
  {
    name: "DNS 层 ts-ep 入站拒绝被删（Peer 查询进 dnsRouter）",
    template: "template-ios.json",
    apply: (t) => {
      const rules = t.dns.rules as Rule[];
      const i = indexOfRule(rules, (r) => asArray(r.inbound).includes("ts-ep"));
      rules.splice(i, 1);
      return `dns.rules[${i}] 已删除`;
    },
  },
  {
    name: "MagicDNS 排到 ChinaMax-dns 之后（Tailnet 域名被国内解析）",
    template: "template-ios.json",
    apply: (t) => {
      const rules = t.dns.rules as Rule[];
      const magic = indexOfRule(rules, (r) => asArray(r.preferred_by).length > 0);
      const china = indexOfRule(rules, (r) => asArray(r.rule_set).includes("ChinaMax-dns"));
      const [moved] = rules.splice(magic, 1);
      rules.splice(china, 0, moved);
      return `dns.rules: MagicDNS 从 ${magic} 移到 ${china}`;
    },
  },
  {
    name: "modules-ios/ 出现未登记的新模块",
    template: null,
    apply: () => {
      writeFileSync(join(WORK_DIR, "modules-ios/99-unregistered.json"), "{}\n");
      return "新增 modules-ios/99-unregistered.json";
    },
  },
];

let WORK_DIR = "";

/** 返回 true 表示测试通过。 */
function runContractTest(): { passed: boolean; output: string } {
  const proc = Bun.spawnSync(
    ["bun", "test", TEST_FILE],
    {
      cwd: REPO,
      env: { ...process.env, SINGBOX_TEMPLATE_DIR: WORK_DIR },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const output = `${proc.stdout.toString()}${proc.stderr.toString()}`;
  return { passed: proc.exitCode === 0, output };
}

function listAll(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listAll(full));
    else out.push(full);
  }
  return out;
}

function prepareWorkdir(): void {
  WORK_DIR = mkdtempSync(join(tmpdir(), "singbox-mutation-"));
  cpSync(join(TEMPLATE_DIR, "modules"), join(WORK_DIR, "modules"), { recursive: true });
  cpSync(join(TEMPLATE_DIR, "modules-ios"), join(WORK_DIR, "modules-ios"), { recursive: true });
  for (const name of ["template.json", "template-ios.json"]) {
    cpSync(join(TEMPLATE_DIR, name), join(WORK_DIR, name));
  }
}

function main(): number {
  prepareWorkdir();
  const failures: string[] = [];

  // 基线自检：没施加变异时必须通过，否则后续的「失败」不能归因于变异
  const baseline = runContractTest();
  if (!baseline.passed) {
    console.error("❌ 基线未通过，变异验证无从判断。先修好契约测试。\n");
    console.error(baseline.output);
    rmSync(WORK_DIR, { recursive: true, force: true });
    return 1;
  }
  console.log("✅ 基线：未施加变异时契约测试通过\n");

  for (const mutation of MUTATIONS) {
    // 目录级变异只还原新增文件，文件级变异按原文回写
    const created: string[] = [];
    let restore = () => {};

    if (mutation.template === null) {
      const before = new Set(listAll(WORK_DIR));
      mutation.apply({});
      for (const f of listAll(WORK_DIR)) if (!before.has(f)) created.push(f);
      if (created.length === 0) {
        failures.push(`${mutation.name}：变异未产生任何新文件`);
        console.log(`⚠️  ${mutation.name} —— 变异未生效`);
        continue;
      }
      restore = () => created.forEach((f) => rmSync(f, { force: true }));
    } else {
      const path = join(WORK_DIR, mutation.template);
      const original = readFileSync(path, "utf8");
      const template = JSON.parse(original) as Rule;
      const description = mutation.apply(template);
      const mutated = JSON.stringify(template, null, 2);

      // 自检：变异必须真的改变内容，否则字段路径写错，后面「测试失败」是假象
      if (mutated === JSON.stringify(JSON.parse(original), null, 2)) {
        failures.push(`${mutation.name}：变异未改变内容（${description}），字段路径可能已失效`);
        console.log(`⚠️  ${mutation.name} —— 变异未生效`);
        continue;
      }
      writeFileSync(path, mutated);
      restore = () => writeFileSync(path, original);
    }

    const result = runContractTest();
    restore();

    if (result.passed) {
      failures.push(`${mutation.name}：断言未捕获该破坏`);
      console.log(`❌ ${mutation.name} —— 被放行`);
    } else {
      console.log(`✅ ${mutation.name} —— 已拦截`);
    }
  }

  rmSync(WORK_DIR, { recursive: true, force: true });

  if (failures.length > 0) {
    console.error(`\n❌ ${failures.length}/${MUTATIONS.length} 个变异未被捕获：`);
    for (const f of failures) console.error(`   - ${f}`);
    return 1;
  }
  console.log(`\n✅ ${MUTATIONS.length} 个变异全部被捕获`);
  return 0;
}

process.exit(main());
