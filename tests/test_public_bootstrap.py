import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile


ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


bootstrap = load("public_bootstrap", ROOT / "bootstrap.py")
audit = load("public_audit", ROOT / "scripts" / "audit_public.py")


class PublicBootstrapTests(unittest.TestCase):
    def test_major_version_gate(self):
        self.assertEqual(bootstrap.major("20.1.0"), 20)
        self.assertEqual(bootstrap.major(None), -1)

    def test_vsix_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            archive_path = Path(directory) / "candidate.vsix"
            with zipfile.ZipFile(archive_path, "w") as archive:
                archive.writestr("extension/package.json", json.dumps({"publisher": "sample", "name": "guide", "version": "1.2.3"}))
            metadata = bootstrap.package_metadata(archive_path)
            self.assertEqual(metadata["id"], "sample.guide")
            self.assertEqual(metadata["version"], "1.2.3")
            self.assertGreater(metadata["bytes"], 0)

    def test_ci_skip_allows_missing_vscode_only(self):
        versions = {
            "pwsh": ("7.5.0", "7.5.0"),
            "node": ("20.1.0", "v20.1.0"),
            "npm": ("10.0.0", "10.0.0"),
            "git": ("2.43.0", "git version 2.43.0"),
            "code": (None, "not found"),
        }

        def fake_version(name, _args, _pattern):
            return versions[name]

        with patch.object(bootstrap, "command_version", side_effect=fake_version), patch.object(bootstrap.shutil, "which", side_effect=lambda name: name if name == "pwsh" else None), patch.object(bootstrap.os, "name", "nt"):
            ok, checks = bootstrap.prerequisites(require_vscode=False)
        self.assertTrue(ok)
        self.assertEqual(checks["VS Code CLI"]["status"], "MANUAL")


class PublicAuditTests(unittest.TestCase):
    def test_forbidden_path_classes(self):
        self.assertTrue(audit.path_forbidden(".claude/STATUS.md"))
        self.assertTrue(audit.path_forbidden("research/user-tests/result.json"))
        self.assertTrue(audit.path_forbidden("src/research/experimentState.ts"))
        self.assertTrue(audit.path_forbidden("src/view/sessionWidget.ts"))

    def test_secret_values_are_redacted_as_findings(self):
        findings = []
        sample = b"-----BEGIN " + b"PRIVATE KEY-----"
        audit.scan_bytes("fixture.txt", sample, findings)
        self.assertEqual(findings, [("private-key", "fixture.txt")])


if __name__ == "__main__":
    unittest.main()
