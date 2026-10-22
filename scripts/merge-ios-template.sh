#!/usr/bin/env bash
# iOS 底模合并：modules/ 为底，modules-ios/ 同名替换、其余新增（ADR-0010）。
# justfile 的构建、校验与 CI 共用这一份，合并语义只在这里改。
# 分两次 cp：GNU cp 拒绝在同一条命令里用同名文件覆盖刚复制的文件，macOS 允许（尸检 014）。
set -euo pipefail

out="${1:?用法: merge-ios-template.sh <输出文件>}"
root="$(cd "$(dirname "$0")/.." && pwd)"
d="$(mktemp -d "${TMPDIR:-/tmp}/sing-box-ios.XXXXXX")"
trap 'rm -rf "$d"' EXIT

cp "$root"/config/sing-box/modules/*.json "$d"
cp "$root"/config/sing-box/modules-ios/*.json "$d"
# SING_BOX 可能是多词命令（默认 mise exec -- sing-box），按词展开
${SING_BOX:-mise exec -- sing-box} merge "$out" -C "$d"
