"""AC 1-3: packaging, help tree, init idempotence.

@author Patrick Finazzo
"""

import subprocess
import sys
import sysconfig
from pathlib import Path

import pytest

from claimcheck import cli
from conftest import SUBPROCESS_TIMEOUT_S


def test_ac1_version_via_module_and_script():
    output = subprocess.run([sys.executable, "-m", "claimcheck", "--version"], capture_output=True, text=True, timeout=SUBPROCESS_TIMEOUT_S)
    assert output.returncode == 0
    assert output.stdout.strip() == "claimcheck 0.1.0"
    # A venv keeps its scripts beside python.exe, but a normal Windows install keeps them in a Scripts
    # folder one level down. Python knows where its own scripts go, so ask it, then try the old spot too.
    folders = [Path(sysconfig.get_path("scripts")), Path(sys.executable).parent]
    script = next((folder / name for folder in folders for name in ("claimcheck.exe", "claimcheck") if (folder / name).exists()), None)
    assert script is not None, f"console script not found in {folders[0]}; run: {sys.executable} -m pip install -e ."
    out2 = subprocess.run([str(script), "--version"], capture_output=True, text=True, timeout=SUBPROCESS_TIMEOUT_S)
    assert out2.stdout.strip() == "claimcheck 0.1.0"


def test_ac1_version_in_process(capsys):
    with pytest.raises(SystemExit) as error:
        cli.main(["--version"])
    assert error.value.code == 0
    assert capsys.readouterr().out.strip() == "claimcheck 0.1.0"


def _read_help(*argv) -> str:
    proc = subprocess.run([sys.executable, "-m", "claimcheck", *argv, "--help"], capture_output=True, text=True, timeout=SUBPROCESS_TIMEOUT_S)
    assert proc.returncode == 0
    return proc.stdout


def test_ac2_help_tree():
    assert "{init,status,spec,claims,check,mutate,run,accept,verify-ledger,hook}" in _read_help()
    assert "{freeze,verify,draft}" in _read_help("spec")
    assert "{validate}" in _read_help("claims")
    assert "{pre-commit}" in _read_help("hook")


def test_ac3_init_creates_everything_and_is_idempotent(repo):
    # A repo already on the single layout gets the starter spec, claims and ledger at the top.
    repo.write(".claimcheck/config.toml", text='version = 1\nlayout = "single"\n')
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

    before = {name: ((cc / name).stat().st_mtime_ns, (cc / name).read_bytes()) for name in expected}
    hook_before = (hook.stat().st_mtime_ns, hook.read_bytes())
    # mutate one file so we can prove init does not overwrite
    (cc / "spec.md").write_text("- [ ] 1. custom\n", encoding="utf-8")
    before["spec.md"] = ((cc / "spec.md").stat().st_mtime_ns, (cc / "spec.md").read_bytes())

    assert repo.cli("init") == 0
    for key, (mtime, content) in before.items():
        assert (cc / key).stat().st_mtime_ns == mtime, key
        assert (cc / key).read_bytes() == content, key
    assert (hook.stat().st_mtime_ns, hook.read_bytes()) == hook_before
