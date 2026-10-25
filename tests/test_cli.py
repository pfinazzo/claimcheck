"""AC 1-3: packaging, help tree, init idempotence.

@author Patrick Finazzo
"""

import subprocess
import sys
from pathlib import Path

import pytest

from claimcheck import cli


def test_ac1_version_via_module_and_script():
    out = subprocess.run([sys.executable, "-m", "claimcheck", "--version"], capture_output=True, text=True)
    assert out.returncode == 0
    assert out.stdout.strip() == "claimcheck 0.1.0"
    scripts = Path(sys.executable).parent
    script = next((scripts / n for n in ("claimcheck.exe", "claimcheck") if (scripts / n).exists()), None)
    assert script is not None, "console script not installed; run pip install -e ."
    out2 = subprocess.run([str(script), "--version"], capture_output=True, text=True)
    assert out2.stdout.strip() == "claimcheck 0.1.0"


def test_ac1_version_in_process(capsys):
    with pytest.raises(SystemExit) as e:
        cli.main(["--version"])
    assert e.value.code == 0
    assert capsys.readouterr().out.strip() == "claimcheck 0.1.0"


def _help(*argv) -> str:
    proc = subprocess.run([sys.executable, "-m", "claimcheck", *argv, "--help"], capture_output=True, text=True)
    assert proc.returncode == 0
    return proc.stdout


def test_ac2_help_tree():
    assert "{init,status,spec,claims,check,mutate,run,verify-ledger,hook}" in _help()
    assert "{freeze,verify,draft}" in _help("spec")
    assert "{validate}" in _help("claims")
    assert "{pre-commit}" in _help("hook")


def test_ac3_init_creates_everything_and_is_idempotent(repo):
    assert repo.cli("init") == 0
    cc = repo.cc
    expected = ["config.toml", "spec.md", "claims.yaml", "ledger.jsonl"]
    for name in expected:
        assert (cc / name).exists(), name
    assert (cc / "runs").is_dir()
    assert (cc / "ledger.jsonl").read_bytes() == b""
    assert "- [ ] 1. " in (cc / "spec.md").read_text(encoding="utf-8")
    assert "claims: []" in (cc / "claims.yaml").read_text(encoding="utf-8")
    hook = repo.path / ".git" / "hooks" / "pre-commit"
    assert hook.exists() and b"claimcheck" in hook.read_bytes()

    before = {n: ((cc / n).stat().st_mtime_ns, (cc / n).read_bytes()) for n in expected}
    hook_before = (hook.stat().st_mtime_ns, hook.read_bytes())
    # mutate one file so we can prove init does not overwrite
    (cc / "spec.md").write_text("- [ ] 1. custom\n", encoding="utf-8")
    before["spec.md"] = ((cc / "spec.md").stat().st_mtime_ns, (cc / "spec.md").read_bytes())

    assert repo.cli("init") == 0
    for n, (mtime, data) in before.items():
        assert (cc / n).stat().st_mtime_ns == mtime, n
        assert (cc / n).read_bytes() == data, n
    assert (hook.stat().st_mtime_ns, hook.read_bytes()) == hook_before
