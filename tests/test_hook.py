"""AC 10-13: hook installer, staged-diff rules, real git commit.

@author Patrick Finazzo
"""

import sys
from pathlib import Path

import pytest

from claimcheck import ClaimsError, config, hook
from conftest import CLAIMS_FOR_CALC


def _resolve_hook_path(repo) -> Path:
    return repo.path / ".git" / "hooks" / "pre-commit"


# ---- AC 10 ---------------------------------------------------------------

def test_ac10_fresh_hook_content(repo):
    repo.cli("init")
    text = _resolve_hook_path(repo).read_text(encoding="utf-8")
    exe = Path(sys.executable).as_posix()
    assert text.startswith("#!/bin/sh\n")
    assert f'"{exe}" -m claimcheck hook pre-commit || exit 1\n' in text


def test_ac10_existing_hook_is_appended_and_preserved(repo):
    file_path = _resolve_hook_path(repo)
    file_path.parent.mkdir(parents=True, exist_ok=True)
    original = b"#!/bin/sh\necho existing-hook\n"
    file_path.write_bytes(original)
    assert hook.install(repo.path) is True
    raw = file_path.read_bytes()
    assert raw.startswith(original)
    assert b"claimcheck hook pre-commit" in raw


def test_ac10_hook_with_marker_untouched(repo):
    file_path = _resolve_hook_path(repo)
    file_path.parent.mkdir(parents=True, exist_ok=True)
    file_path.write_bytes(b"#!/bin/sh\n# my own claimcheck wrapper\n")
    before = file_path.read_bytes()
    assert hook.install(repo.path) is False
    assert file_path.read_bytes() == before


# ---- AC 11 ---------------------------------------------------------------

def _write_and_stage(repo, *, rel_path, text):
    repo.write(rel_path, text=text)
    repo.git("add", rel_path)


def test_ac11_only_ignored_paths_exit_0(cc_repo):
    _write_and_stage(cc_repo, rel_path="docs/guide.md", text="# hi\n")
    _write_and_stage(cc_repo, rel_path="notes.txt", text="x\n")
    assert hook.run_pre_commit(cc_repo.path, settings=config.load(cc_repo.path)) == 0


def test_ac11_code_without_claims_staged_fails(cc_repo):
    _write_and_stage(cc_repo, rel_path="src/calc.py", text="x = 1\n")
    with pytest.raises(ClaimsError) as error:
        hook.run_pre_commit(cc_repo.path, settings=config.load(cc_repo.path))
    assert "claims.yaml is not staged" in str(error.value)


def test_ac11_claims_files_must_be_subset_of_staged(cc_repo):
    _write_and_stage(cc_repo, rel_path="src/other.py", text="x = 1\n")
    # Claims src/calc.py, not staged.
    _write_and_stage(cc_repo, rel_path=".claimcheck/claims.yaml", text=CLAIMS_FOR_CALC)
    with pytest.raises(ClaimsError) as error:
        hook.run_pre_commit(cc_repo.path, settings=config.load(cc_repo.path))
    assert "files not in the diff under test: ['src/calc.py']" in str(error.value)


def test_ac11_staged_version_of_claims_is_what_counts(cc_repo):
    _write_and_stage(cc_repo, rel_path="src/calc.py", text="x = 1\n")
    _write_and_stage(cc_repo, rel_path=".claimcheck/claims.yaml", text=CLAIMS_FOR_CALC)
    # working tree copy is now garbage, but the staged copy is valid
    cc_repo.write(".claimcheck/claims.yaml", text="version: 1\nclaims: {}\n")
    assert hook.run_pre_commit(cc_repo.path, settings=config.load(cc_repo.path)) == 0


def test_ac11_invalid_staged_claims_fails(cc_repo):
    _write_and_stage(cc_repo, rel_path="src/calc.py", text="x = 1\n")
    _write_and_stage(cc_repo, rel_path=".claimcheck/claims.yaml", text="version: 1\nclaims: {}\n")
    with pytest.raises(ClaimsError):
        hook.run_pre_commit(cc_repo.path, settings=config.load(cc_repo.path))


def test_ac11_staged_deletion_needs_a_claim(cc_repo):
    cc_repo.write("src/gone.py", text="x = 1\n")
    cc_repo.commit("add gone")
    cc_repo.git("rm", "-q", "src/gone.py")
    with pytest.raises(ClaimsError) as error:
        hook.run_pre_commit(cc_repo.path, settings=config.load(cc_repo.path))
    assert "claims.yaml is not staged" in str(error.value)
    _write_and_stage(cc_repo, rel_path=".claimcheck/claims.yaml", text=CLAIMS_FOR_CALC.replace('"src/calc.py"', '"src/gone.py"'))
    assert hook.run_pre_commit(cc_repo.path, settings=config.load(cc_repo.path)) == 0


def test_ac11_rename_needs_both_paths_covered(cc_repo):
    cc_repo.write("src/old.py", text="x = 1\n")
    cc_repo.commit("add old")
    cc_repo.git("mv", "src/old.py", "src/new.py")
    _write_and_stage(cc_repo, rel_path=".claimcheck/claims.yaml", text=CLAIMS_FOR_CALC.replace('"src/calc.py"', '"src/new.py"'))
    with pytest.raises(ClaimsError) as error:
        hook.run_pre_commit(cc_repo.path, settings=config.load(cc_repo.path))
    assert "src/old.py" in str(error.value)


# ---- AC 12 ---------------------------------------------------------------

def test_ac12_coverage_required_by_default(cc_repo):
    _write_and_stage(cc_repo, rel_path="src/calc.py", text="x = 1\n")
    _write_and_stage(cc_repo, rel_path="src/uncovered.py", text="y = 2\n")
    _write_and_stage(cc_repo, rel_path=".claimcheck/claims.yaml", text=CLAIMS_FOR_CALC)
    with pytest.raises(ClaimsError) as error:
        hook.run_pre_commit(cc_repo.path, settings=config.load(cc_repo.path))
    assert "src/uncovered.py" in str(error.value)


def test_ac12_coverage_warning_when_disabled(cc_repo, *, capsys):
    cfg_text = cc_repo.read(".claimcheck/config.toml").replace(
        "require_full_coverage = true", "require_full_coverage = false"
    )
    cc_repo.write(".claimcheck/config.toml", text=cfg_text)
    _write_and_stage(cc_repo, rel_path="src/calc.py", text="x = 1\n")
    _write_and_stage(cc_repo, rel_path="src/uncovered.py", text="y = 2\n")
    _write_and_stage(cc_repo, rel_path=".claimcheck/claims.yaml", text=CLAIMS_FOR_CALC)
    assert hook.run_pre_commit(cc_repo.path, settings=config.load(cc_repo.path)) == 0
    assert "src/uncovered.py" in capsys.readouterr().err


# ---- AC 13 ---------------------------------------------------------------

def test_ac13_real_git_commit_blocked_then_allowed(cc_repo):
    cc_repo.write("src/a.py", text="a = 1\n")
    proc = cc_repo.try_commit("add a")
    assert proc.returncode != 0
    assert "claims.yaml is not staged" in (proc.stderr + proc.stdout)

    cc_repo.write(
        ".claimcheck/claims.yaml",
        text=CLAIMS_FOR_CALC.replace('"src/calc.py"', '"src/a.py"'),
    )
    proc = cc_repo.try_commit("add a with claims")
    assert proc.returncode == 0, proc.stderr
    assert "src/a.py" in cc_repo.git("show", "--name-only", "--format=", "HEAD")
