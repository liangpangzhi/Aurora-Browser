#!/usr/bin/env python3
"""Print the release notes for a version from CHANGELOG.md.

Usage: python3 scripts/extract_changelog.py 1.0.3
If the version has no section, fall back to recent git commit logs.
"""
from __future__ import annotations

import re
import subprocess
import sys


def git_fallback_notes() -> list[str]:
    try:
        prev_tag = subprocess.check_output(
            ["git", "describe", "--tags", "--abbrev=0", "HEAD^"],
            stderr=subprocess.DEVNULL,
            text=True,
        ).strip()
        log_range = f"{prev_tag}..HEAD"
    except Exception:
        log_range = "-n 10"

    try:
        args = ["git", "log", "--no-merges", "--pretty=format:- %s (%h)"]
        args.extend(log_range.split())
        out = subprocess.check_output(args, stderr=subprocess.DEVNULL, text=True).strip()
        if out:
            return out.splitlines()
    except Exception:
        pass
    return ["- 请查看仓库提交记录获取本次变更。", "- ARM64 与 x86_64 双架构安装包已随本版本发布。"]


def main() -> None:
    version = sys.argv[1].lstrip("v") if len(sys.argv) > 1 else ""
    try:
        text = open("CHANGELOG.md", encoding="utf-8").read()
    except FileNotFoundError:
        text = ""

    pattern = re.compile(
        r"^##\s*\[?" + re.escape(version) + r"\]?[^\n]*\n(.*?)(?=^##\s|\Z)",
        re.MULTILINE | re.DOTALL,
    )
    match = pattern.search(text)
    if match and match.group(1).strip():
        print(match.group(1).strip())
        return

    print(f"极光浏览器 Aurora v{version}")
    print()
    for line in git_fallback_notes():
        print(line)


if __name__ == "__main__":
    main()
