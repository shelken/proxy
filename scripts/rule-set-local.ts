/**
 * 规则集本地化：把底模声明的远程规则集换成 VM 内本地文件。
 *
 * 沙箱闭环引导与 verify-rules-compiler 技能共用这条准备链
 * （planRuleSets → stageRuleSets → localizeRuleSets）。
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { RULES_URL } from "./settings.ts";

function fail(stage: string, detail: string): never {
  throw new Error(`[沙箱引导] ${stage} 失败：${detail}`);
}

interface RuleSetPlan {
  tag: string;
  url: string;
  external: boolean;
  /** 相对 WORK 的落位：仓库产物进 rules/，外部 .srs 进 external/ 且按序号唯一。 */
  path: string;
}

/** URL 路径的真实文件名：先解百分号编码再取 basename，中文/空格名不被编码破坏。 */
function urlBasename(url: string): string {
  return basename(decodeURIComponent(new URL(url).pathname));
}

const RELEASE = new URL(RULES_URL);

/**
 * 是否本仓库发布的直接产物：同 origin 且 path 的直接父目录就是发布目录。
 * 相邻目录（singbox-backup/）与嵌套子目录（singbox/nested/）都算外部来源，
 * 必须按用户 URL 原样下载，不能静默复用本地产物。
 */
export function isRepoArtifact(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.origin === RELEASE.origin && dirname(parsed.pathname) === RELEASE.pathname;
  } catch {
    return false;
  }
}

/**
 * 底模声明的远程规则集 → VM 内本地文件。
 *
 * 本仓库产物用 URL 路径里的真实产物名（兼容别名引用与中文名）；外部 .srs（如小米）
 * 不编译、不反编译，放进独立目录按序号命名，避免不同来源共享 basename 互相覆盖。
 */
export function planRuleSets(template: {
  route?: { rule_set?: Array<Record<string, unknown>> };
}): RuleSetPlan[] {
  let next = 0;
  return (template.route?.rule_set ?? [])
    .filter((rs) => rs?.type === "remote" && typeof rs.url === "string")
    .map((rs) => {
      const url = rs.url as string;
      const external = !isRepoArtifact(url);
      return {
        tag: String(rs.tag),
        url,
        external,
        path: external ? `external/${next++}.srs` : `rules/${urlBasename(url)}`,
      };
    });
}

/**
 * 同步前确认本地规则产物齐备。
 *
 * `pushToGuest` 按 tag→本地文件映射拷贝规则集，缺哪个文件只有内核启动时才暴露成
 * `parse rule-set: open ...: no such file or directory`。这里当场核对仓库产物；
 * 外部 .srs 在 pushToGuest 时下载，不在预检里。
 */
export function verifyLocalArtifacts(plan: RuleSetPlan[]): void {
  const genDir = resolve(import.meta.dir, "../config/rules/generated/singbox");
  const missing = plan.filter((p) => !p.external && !existsSync(join(genDir, basename(p.path))));
  if (missing.length > 0) {
    fail(
      "检查本地规则产物",
      `底模声明了 ${plan.length} 个远程规则集，本地 generated/singbox/ 缺 ${missing.length} 个：\n` +
        `  ${missing.map((p) => basename(p.path)).join(", ")}\n` +
        `  先执行 just rules-build 生成全量产物再引导`,
    );
  }
}

/** 下载外部 .srs 到宿主 staging，返回 tag→guest 内路径映射；仓库产物直接复用生成的 .srs。 */
export function stageRuleSets(
  plan: RuleSetPlan[],
  stagingDir: string,
  guestDir: string,
): Record<string, string> {
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });
  const map: Record<string, string> = {};
  for (const item of plan) {
    if (item.external) {
      const dest = join(stagingDir, item.path);
      mkdirSync(dirname(dest), { recursive: true });
      const dl = Bun.spawnSync(["curl", "-fsSL", "--max-time", "60", item.url, "-o", dest]);
      if (dl.exitCode !== 0) fail("下载外部规则集", item.url);
    }
    map[item.tag] = `${guestDir}/${item.path}`;
  }
  writeFileSync(join(stagingDir, "rules-map.json"), JSON.stringify(map, null, 2));
  return map;
}

/** 把配置里的远程规则集按映射换成 VM 内本地文件，并去掉会联网的 clash_api。 */
export function localizeRuleSets(config: any, map: Record<string, string>) {
  const next = structuredClone(config);
  next.route = next.route ?? {};
  next.route.rule_set = (next.route.rule_set ?? []).map((rs: Record<string, any>) => {
    if (rs?.type !== "remote") return rs;
    const path = map[rs.tag];
    if (!path) throw new Error(`规则集 ${rs.tag} 没有本地映射`);
    return { type: "local", tag: rs.tag, format: "binary", path };
  });
  const experimental = { ...(next.experimental ?? {}) };
  delete experimental.clash_api;
  if (Object.keys(experimental).length > 0) next.experimental = experimental;
  else delete next.experimental;
  return next;
}
