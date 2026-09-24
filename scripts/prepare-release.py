#!/usr/bin/env python3
"""准备一次 sb-sync 版本发布所需的三个文件。

用法（从仓库根执行）：
    python3 scripts/prepare-release.py --version 0.5.1 --notes "本次改动说明"

只做三件事：校验版本、把说明写进 crate 的 CHANGELOG、调用 release-plz 同步
Cargo.toml 与 Cargo.lock。不创建 PR、不打 tag、不推送——那些由工作流负责。

版本真源是 scripts/sb-sync-rs/Cargo.toml；CHANGELOG 里的新段标题先写成当前
清单版本，再由 release-plz set-version 改写成目标版本（该命令只做标题字符串
替换，所以顺序不能颠倒，且入口处必须先存在一个 release 段）。
"""

from __future__ import annotations

import argparse
import datetime
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CRATE_DIR = REPO_ROOT / "scripts" / "sb-sync-rs"
MANIFEST = CRATE_DIR / "Cargo.toml"
CHANGELOG = CRATE_DIR / "CHANGELOG.md"
CONFIG = CRATE_DIR / "release-plz.toml"

# 稳定版三段整数，且不允许前导零（0.5.01 与 01.2.3 都拒绝）
VERSION_RE = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")
TAG_RE = re.compile(r"^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")

CHANGELOG_TITLE = "# Changelog"


def parse_version(text: str) -> tuple[int, int, int]:
    match = VERSION_RE.match(text.strip())
    if not match:
        raise SystemExit(f"版本必须是 X.Y.Z 三段整数且无前导零，收到: {text!r}")
    return tuple(int(part) for part in match.groups())  # type: ignore[return-value]


def manifest_version() -> tuple[int, int, int]:
    for line in MANIFEST.read_text(encoding="utf-8").splitlines():
        if line.startswith("version"):
            value = line.split("=", 1)[1].strip().strip('"')
            return parse_version(value)
    raise SystemExit(f"无法从 {MANIFEST} 读取 version")


def released_versions() -> list[tuple[int, int, int]]:
    """远端已发布的稳定版本（靠完整 clone 的 tag 列表）。"""
    result = subprocess.run(
        ["git", "tag", "--list", "v*"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
    )
    versions = []
    for line in result.stdout.splitlines():
        match = TAG_RE.match(line.strip())
        if match:
            versions.append(tuple(int(part) for part in match.groups()))
    return versions  # type: ignore[return-value]


def insert_changelog_section(notes: str, old_version: tuple[int, int, int]) -> None:
    """在 `# Changelog` 之后插入本次新段，标题暂用旧版本号。"""
    old_text = CHANGELOG.read_text(encoding="utf-8") if CHANGELOG.exists() else ""
    if not old_text.strip():
        old_text = f"{CHANGELOG_TITLE}\n\n"
    if not old_text.startswith(CHANGELOG_TITLE):
        raise SystemExit(f"{CHANGELOG} 不以 `{CHANGELOG_TITLE}` 开头，拒绝改写")

    rest = old_text[len(CHANGELOG_TITLE):].lstrip("\n")
    title = "## [{}.{}.{}] - {}".format(
        *old_version, datetime.date.today().isoformat()
    )
    body = notes.strip()
    new_text = f"{CHANGELOG_TITLE}\n\n{title}\n\n{body}\n\n{rest}"
    if not new_text.endswith("\n"):
        new_text += "\n"
    CHANGELOG.write_text(new_text, encoding="utf-8")


def run(cmd: list[str]) -> None:
    print(f"+ {' '.join(cmd)}", flush=True)
    subprocess.run(cmd, cwd=REPO_ROOT, check=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True, help="目标版本，形如 0.5.1")
    parser.add_argument("--notes", required=True, help="本次发布说明")
    args = parser.parse_args()

    if not args.notes.strip():
        raise SystemExit("--notes 不能为空")

    target = parse_version(args.version)
    current = manifest_version()
    if target <= current:
        raise SystemExit(
            f"目标版本 {args.version} 必须大于当前清单版本 "
            f"{'.'.join(map(str, current))}"
        )
    released = released_versions()
    if released and target <= max(released):
        highest = ".".join(map(str, max(released)))
        raise SystemExit(f"目标版本 {args.version} 必须大于已发布版本 {highest}")

    print(f"准备版本 {args.version}（当前清单 {'.'.join(map(str, current))}）")

    insert_changelog_section(args.notes, current)
    run(
        [
            "release-plz",
            "set-version",
            "--manifest-path",
            str(MANIFEST.relative_to(REPO_ROOT)),
            "--config",
            str(CONFIG.relative_to(REPO_ROOT)),
            args.version,
        ]
    )
    # --locked 会校验锁文件与清单一致：set-version 没同步就会在这里失败
    run(["cargo", "tree", "--locked", "--manifest-path", str(MANIFEST.relative_to(REPO_ROOT))])

    print(f"完成：{MANIFEST.name}、Cargo.lock、{CHANGELOG.name} 已更新")


if __name__ == "__main__":
    sys.exit(main())
