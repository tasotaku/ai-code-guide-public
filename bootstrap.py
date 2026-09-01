#!/usr/bin/env python3
"""Build, package, install, and verify the public AI Code Guide source edition."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import zipfile


ROOT = Path(__file__).resolve().parent
VSIX = ROOT / "ai-code-guide.vsix"
EXTENSION_ID = "neoai-research.ai-code-guide"


def command_version(name: str, args: list[str], pattern: str) -> tuple[str | None, str]:
    executable = shutil.which(name)
    if not executable:
        return None, "not found"
    result = subprocess.run([executable, *args], capture_output=True, text=True, check=False)
    output = (result.stdout or result.stderr).strip()
    match = re.search(pattern, output)
    return (match.group(1) if match else None), output or f"exit {result.returncode}"


def major(version: str | None) -> int:
    if not version:
        return -1
    return int(version.split(".", 1)[0])


def prerequisites(require_vscode: bool = True) -> tuple[bool, dict[str, dict[str, object]]]:
    shell_name = "pwsh" if shutil.which("pwsh") else "powershell"
    shell, shell_raw = command_version(shell_name, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], r"(\d+(?:\.\d+)+)")
    node, node_raw = command_version("node", ["--version"], r"v?(\d+(?:\.\d+)+)")
    npm, npm_raw = command_version("npm", ["--version"], r"(\d+(?:\.\d+)+)")
    git, git_raw = command_version("git", ["--version"], r"(\d+(?:\.\d+)+)")
    code, code_raw = command_version("code", ["--version"], r"(\d+(?:\.\d+)+)")
    py = platform.python_version()
    checks = {
        "PowerShell": {"status": "PASS" if os.name == "nt" and shell else "FAIL", "version": shell or shell_raw, "required": "Windows PowerShell or pwsh"},
        "Git": {"status": "PASS" if git else "FAIL", "version": git or git_raw, "required": "Git"},
        "Node.js": {"status": "PASS" if major(node) >= 20 else "FAIL", "version": node or node_raw, "required": ">=20"},
        "npm": {"status": "PASS" if npm else "FAIL", "version": npm or npm_raw, "required": "installed with Node.js"},
        "Python": {"status": "PASS" if sys.version_info >= (3, 12) else "FAIL", "version": py, "required": ">=3.12"},
        "VS Code CLI": {"status": "PASS" if code else ("MANUAL" if not require_vscode else "FAIL"), "version": code or code_raw, "required": "code in PATH"},
    }
    for name, item in checks.items():
        print(f"  [{item['status']}] {name}: {item['version']} (required: {item['required']})")
    blocking = {"PASS"} if require_vscode else {"PASS", "MANUAL"}
    return all(item["status"] in blocking for item in checks.values()), checks


def run_stage(label: str, command: list[str]) -> None:
    print(f"\n== {label} ==")
    if label in {"Dependency setup", "VSIX package"}:
        print("Public dependency source: https://registry.npmjs.org/")
    print("Running: " + " ".join(command))
    result = subprocess.run(command, cwd=ROOT, check=False)
    if result.returncode:
        raise RuntimeError(f"{label} failed with exit code {result.returncode}. Fix the command output above, then rerun: python bootstrap.py install")


def package_metadata(vsix: Path) -> dict[str, object]:
    with zipfile.ZipFile(vsix) as archive:
        manifest = json.loads(archive.read("extension/package.json"))
    return {"id": f"{manifest['publisher']}.{manifest['name']}", "version": manifest["version"], "bytes": vsix.stat().st_size}


def install(skip_vscode_install: bool) -> int:
    print("== Prerequisite report ==")
    ok, _ = prerequisites(require_vscode=not skip_vscode_install)
    if not ok:
        print("\nFAILED: prerequisite check. Install the required public tools and rerun: python bootstrap.py install", file=sys.stderr)
        return 1
    try:
        run_stage("Dependency setup", [shutil.which("npm") or "npm", "ci"])
        run_stage("Compile", [shutil.which("npm") or "npm", "run", "compile"])
        run_stage("Bundle", [shutil.which("npm") or "npm", "run", "bundle"])
        run_stage("VSIX package", [shutil.which("npm") or "npm", "exec", "--yes", "--package=@vscode/vsce@3.9.2", "--", "vsce", "package", "--no-dependencies", "-o", str(VSIX)])
        metadata = package_metadata(VSIX)
        if not skip_vscode_install:
            run_stage("VS Code install", [shutil.which("code") or "code", "--install-extension", str(VSIX), "--force"])
            listing = subprocess.run([shutil.which("code") or "code", "--list-extensions", "--show-versions"], capture_output=True, text=True, check=False)
            expected = f"{metadata['id']}@{metadata['version']}".lower()
            if listing.returncode or expected not in listing.stdout.lower():
                raise RuntimeError(f"VS Code did not report the installed extension {expected}")
    except (OSError, RuntimeError, KeyError, zipfile.BadZipFile) as exc:
        print(f"\nFAILED: {exc}", file=sys.stderr)
        print("Recovery: fix the reported public prerequisite or stage, then rerun: python bootstrap.py install", file=sys.stderr)
        return 1
    print("\nSUCCESS: AI Code Guide public source build is ready")
    print(f"VSIX: {VSIX} ({metadata['bytes']} bytes)")
    print(f"Extension: {metadata['id']}@{metadata['version']}")
    print("Installed in VS Code: " + ("skipped by explicit flag" if skip_vscode_install else "yes"))
    print("Next check: python bootstrap.py check")
    return 0


def check() -> int:
    print("== Prerequisite report ==")
    ok, checks = prerequisites()
    required_files = [ROOT / "package.json", ROOT / "package-lock.json", ROOT / "src" / "extension.ts", ROOT / "python" / "ast_parser.py"]
    for path in required_files:
        status = "PASS" if path.exists() else "FAIL"
        print(f"  [{status}] source: {path.relative_to(ROOT)}")
        ok = ok and path.exists()
    if VSIX.exists():
        try:
            metadata = package_metadata(VSIX)
            print(f"  [PASS] VSIX: {VSIX} ({metadata['bytes']} bytes, {metadata['id']}@{metadata['version']})")
        except (OSError, KeyError, zipfile.BadZipFile) as exc:
            print(f"  [FAIL] VSIX: {exc}")
            ok = False
    else:
        print("  [MANUAL] VSIX: not built yet; run python bootstrap.py install")
        ok = False
    print("\nCHECK " + ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    install_parser = sub.add_parser("install", help="check, build, package, and install the extension")
    install_parser.add_argument("--skip-vscode-install", action="store_true", help="CI-only: build the VSIX without changing the VS Code profile")
    sub.add_parser("check", help="verify prerequisites, source, and built VSIX")
    args = parser.parse_args()
    return install(args.skip_vscode_install) if args.command == "install" else check()


if __name__ == "__main__":
    raise SystemExit(main())
