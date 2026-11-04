#!/usr/bin/env bash
# 变体底模的终态装配：底模 + 该变体的 overlay 夹具（config/sing-box/tests/fixtures/<变体>-overlay.json）。
#
# 路由变体把本网解析器地址、部署域名与内网入口、放行（不被改写）的解析器清单
# 交给设备 overlay（ADR-0012 的设计约束），所以 template-router.json 引用不到
# dns-lan 这些 tag：route.default_domain_resolver 指向不存在的 tag 时，配了出站的
# 配置在内核 check 阶段就 FATAL（initialize outbound[0]: default domain resolver
# not found），单份底模不可 check，必须装配出终态。没有夹具的变体原样输出底模。
#
# 文件名的前缀是承重设计：merge 的优先级由路径字典序决定（docs/sbtools.md §6），
# 夹具排在底模之前，overlay 的规则才会先命中。
set -euo pipefail

usage="用法: merge-variant-fixture.sh <ios|router> <输出文件>"
variant="${1:?$usage}"
out="${2:?$usage}"
root="$(cd "$(dirname "$0")/.." && pwd)"
base="$root/config/sing-box/template-$variant.json"
fixture="$root/config/sing-box/tests/fixtures/$variant-overlay.json"
[ -f "$base" ] || {
  echo "缺少底模: $base" >&2
  exit 2
}

if [ ! -f "$fixture" ]; then
  cp "$base" "$out"
  exit 0
fi

d="$(mktemp -d "${TMPDIR:-/tmp}/sing-box-$variant-final.XXXXXX")"
trap 'rm -rf "$d"' EXIT
cp "$fixture" "$d/00-overlay.json"
cp "$base" "$d/01-base.json"
# SING_BOX 可能是多词命令（默认 mise exec -- sing-box），按词展开
${SING_BOX:-mise exec -- sing-box} merge "$out" -c "$d/00-overlay.json" -c "$d/01-base.json"
