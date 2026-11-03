#!/usr/bin/env bash
# 平台变体底模合并：modules/ 为底，modules-<变体>/ 同名替换、其余新增。
# 变体：ios（ADR-0010）、router（ADR-0012）。
# justfile 的构建、校验与 CI 共用这一份，合并语义只在这里改。
# 分两次 cp：GNU cp 拒绝在同一条命令里用同名文件覆盖刚复制的文件，macOS 允许（尸检 014）。
set -euo pipefail

usage="用法: merge-variant-template.sh <ios|router> <输出文件>"
variant="${1:?$usage}"
out="${2:?$usage}"
root="$(cd "$(dirname "$0")/.." && pwd)"
src="$root/config/sing-box/modules-$variant"
if [ ! -d "$src" ]; then
  echo "未知变体: $variant（缺少 $src）" >&2
  exit 2
fi
d="$(mktemp -d "${TMPDIR:-/tmp}/sing-box-$variant.XXXXXX")"
trap 'rm -rf "$d"' EXIT

cp "$root"/config/sing-box/modules/*.json "$d"
cp "$src"/*.json "$d"
# SING_BOX 可能是多词命令（默认 mise exec -- sing-box），按词展开
${SING_BOX:-mise exec -- sing-box} merge "$out" -C "$d"
