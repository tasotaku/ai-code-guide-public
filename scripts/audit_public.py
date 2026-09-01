#!/usr/bin/env python3
"""Redacted safety audit for the public worktree, Git history, or VSIX."""

from __future__ import annotations

import argparse
from pathlib import Path
import re
import subprocess
import sys
import zipfile


ROOT = Path(__file__).resolve().parents[1]
SKIP_DIRS = {".git", "node_modules", "out", "__pycache__"}
FORBIDDEN_PATHS = (
    ".agents/", ".claude/", ".loop-engineering/", "research/", "output/", "outputs/",
    "docs/decisions/", "agents.md", "user-test-method", "acceptance/",
    "src/research/", "src/view/sessionwidget.ts", "tests/experimentstate.test.js",
    "tests/taskmarkdown.test.js",
)
PATTERNS = {
    "private-development-repository": re.compile(rb"github\.com[/:]tasotaku/ai-code-guide(?:\.git)?(?:[\s\"']|$)", re.I),
    "private-agent-dependency": re.compile(b"tasotaku/" + b"agent-lab", re.I),
    "developer-absolute-path": re.compile(b"(?:C:\\\\Users\\\\" + b"tasog|/Users/(?:miyauchi[^/]*|tasog)/|C:/Users/" + b"tasog/)", re.I),
    "private-key": re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----"),
    "github-token": re.compile(rb"(?:github_pat_[A-Za-z0-9_]{10,}|gh[pousr]_[A-Za-z0-9]{20,})"),
    "cloud-api-key": re.compile(rb"(?:sk-ant-[A-Za-z0-9_-]{10,}|sk-(?:proj|live)-[A-Za-z0-9_-]{10,}|AKIA[0-9A-Z]{16})"),
}


def path_forbidden(name: str) -> bool:
    normalized = name.replace("\\", "/").lower()
    if normalized.startswith("./"):
        normalized = normalized[2:]
    return any(normalized == marker.rstrip("/") or normalized.startswith(marker) for marker in FORBIDDEN_PATHS)


def scan_bytes(name: str, data: bytes, findings: list[tuple[str, str]]) -> None:
    if path_forbidden(name):
        findings.append(("forbidden-path", name))
    for label, pattern in PATTERNS.items():
        if pattern.search(data):
            findings.append((label, name))


def scan_worktree() -> tuple[int, list[tuple[str, str]]]:
    files = 0
    findings: list[tuple[str, str]] = []
    for path in ROOT.rglob("*"):
        if not path.is_file() or any(part in SKIP_DIRS for part in path.relative_to(ROOT).parts):
            continue
        if path.suffix.lower() == ".vsix":
            continue
        files += 1
        scan_bytes(path.relative_to(ROOT).as_posix(), path.read_bytes(), findings)
    return files, findings


def git(*args: str, input_data: bytes | None = None) -> bytes:
    result = subprocess.run(["git", *args], cwd=ROOT, input=input_data, capture_output=True, check=False)
    if result.returncode:
        raise RuntimeError(result.stderr.decode("utf-8", "replace").strip() or "git command failed")
    return result.stdout


def scan_history() -> tuple[int, list[tuple[str, str]]]:
    findings: list[tuple[str, str]] = []
    scanned = 0
    for line in git("rev-list", "--objects", "--all").decode("utf-8", "surrogateescape").splitlines():
        object_id, _, name = line.partition(" ")
        if git("cat-file", "-t", object_id).strip() != b"blob":
            continue
        scanned += 1
        data = git("cat-file", "blob", object_id)
        scan_bytes(name or f"object:{object_id[:12]}", data, findings)
    return scanned, findings


def scan_vsix(path: Path) -> tuple[int, list[tuple[str, str]]]:
    findings: list[tuple[str, str]] = []
    with zipfile.ZipFile(path) as archive:
        names = [item for item in archive.infolist() if not item.is_dir()]
        for item in names:
            scan_bytes(item.filename, archive.read(item), findings)
    return len(names), findings


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("worktree", "history", "vsix"))
    parser.add_argument("path", nargs="?")
    args = parser.parse_args()
    try:
        if args.mode == "worktree":
            count, findings = scan_worktree()
        elif args.mode == "history":
            count, findings = scan_history()
        else:
            if not args.path:
                parser.error("vsix mode requires a path")
            count, findings = scan_vsix((ROOT / args.path).resolve())
    except (OSError, RuntimeError, zipfile.BadZipFile) as exc:
        print(f"AUDIT ERROR: {exc}", file=sys.stderr)
        return 2
    for label, name in findings:
        print(f"FORBIDDEN {label}: {name}")
    print(f"AUDIT {'PASS' if not findings else 'FAIL'}: mode={args.mode} scanned={count} findings={len(findings)}")
    return 0 if not findings else 1


if __name__ == "__main__":
    raise SystemExit(main())
