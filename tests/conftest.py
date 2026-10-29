"""Throwaway git repos for every test, isolated from the developer's git config.

@author Patrick Finazzo
"""

from __future__ import annotations

import os
import subprocess
import sys
import types
from pathlib import Path

import pytest

from claimcheck import cli, config

PY = f'"{Path(sys.executable).as_posix()}"'
# A test's git or CLI call finishes in seconds. This stops a hung one from stalling the whole suite.
SUBPROCESS_TIMEOUT_S = 120

TWO_CRITERIA_SPEC = """\
# Acceptance criteria

- [ ] 1. sub(a, b) returns a - b for ints.
- [ ] 2. is_adult(age) is True at and above 18 and False below.
"""

CLAIMS_FOR_CALC = """\
version: 1
author: "test-agent"
base: "main"
claims:
  - id: c1
    claim: "sub returns a minus b"
    confidence: 0.9
    criteria: [1]
    files: ["src/calc.py"]
    kill_condition: "test: tests/test_calc.py::test_sub"
    verified_by: ["cmd: pytest -q"]
  - id: c2
    claim: "is_adult is inclusive at 18"
    confidence: 0.6
    criteria: [2]
    files: ["src/calc.py"]
    kill_condition: "obs: is_adult(18) returns True"
    verified_by: ["obs: ran it"]
"""

CALC_SRC = "def sub(a, b):\n    return a - b\n\n\ndef is_adult(age):\n    return age >= 18\n"

CALC_TESTS = """\
from calc import sub, is_adult


def test_sub():
    assert sub(5, 3) == 2


def test_is_adult_inclusive():
    assert is_adult(18) is True


def test_is_adult_below():
    assert is_adult(17) is False
"""

CALC_CONFTEST = "import sys, pathlib\nsys.path.insert(0, str(pathlib.Path(__file__).parent / 'src'))\n"


def make_repo(path: Path) -> types.SimpleNamespace:
    """A test repo at `path`: its path plus closures for git, file writes and reads, and commits."""

    def run_git(*args: str, check: bool = True, env: dict | None = None) -> str:
        """Run git in the repo; fail the test on a non-zero exit unless check=False."""
        full_env = {**os.environ, **(env or {})}
        proc = subprocess.run(
            ["git", *args], cwd=path, capture_output=True, text=True, env=full_env, timeout=SUBPROCESS_TIMEOUT_S
        )
        if check and proc.returncode != 0:
            raise AssertionError(f"git {' '.join(args)} failed:\n{proc.stdout}\n{proc.stderr}")
        return proc.stdout

    def write(rel: str, *, text: str) -> Path:
        """Write `text` to `rel`, creating parent folders, with LF line endings."""
        file_path = path / rel
        file_path.parent.mkdir(parents=True, exist_ok=True)
        file_path.write_text(text, encoding="utf-8", newline="\n")
        return file_path

    def read(rel: str) -> str:
        """Read `rel` as UTF-8."""
        return (path / rel).read_text(encoding="utf-8")

    def sha(ref: str = "HEAD") -> str:
        """The commit sha `ref` points at."""
        return run_git("rev-parse", ref).strip()

    def make_commit(msg: str, *, verify: bool = False, date: str | None = None) -> str:
        """Stage everything and commit (hooks skipped unless verify), returning the new sha."""
        run_git("add", "-A")
        args = ["commit", "-q", "-m", msg, *([] if verify else ["--no-verify"])]
        env = {"GIT_AUTHOR_DATE": date, "GIT_COMMITTER_DATE": date} if date else None
        run_git(*args, env=env)
        return sha()

    def run_try_commit(msg: str) -> subprocess.CompletedProcess:
        """Stage everything and commit with hooks on, returning the result instead of failing."""
        run_git("add", "-A")
        return subprocess.run(
            ["git", "commit", "-q", "-m", msg], cwd=path, capture_output=True, text=True, timeout=SUBPROCESS_TIMEOUT_S
        )

    def create_branch(name: str) -> None:
        """Create and switch to branch `name`."""
        run_git("checkout", "-q", "-b", name)

    def run_cli(*argv: str) -> int:
        """Run the claimcheck CLI with `argv`, returning its exit code."""
        return cli.main(list(argv))

    return types.SimpleNamespace(
        path=path,
        cc=path / ".claimcheck",
        git=run_git,
        write=write,
        read=read,
        sha=sha,
        commit=make_commit,
        try_commit=run_try_commit,
        branch=create_branch,
        cli=run_cli,
    )


@pytest.fixture
def repo(tmp_path: Path, *, monkeypatch: pytest.MonkeyPatch) -> types.SimpleNamespace:
    """An empty git repo with an isolated git config and a fixed test identity."""
    empty_cfg = tmp_path / "gitconfig"
    empty_cfg.write_text("", encoding="utf-8")
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(empty_cfg))
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    for key in ("GIT_AUTHOR_NAME", "GIT_COMMITTER_NAME"):
        monkeypatch.setenv(key, "Test")
    for key in ("GIT_AUTHOR_EMAIL", "GIT_COMMITTER_EMAIL"):
        monkeypatch.setenv(key, "test@example.com")
    monkeypatch.delenv("CLAIMCHECK_STUB_FILE", raising=False)
    monkeypatch.delenv("GIT_INDEX_FILE", raising=False)
    monkeypatch.delenv("GIT_DIR", raising=False)

    path = tmp_path / "repo"
    path.mkdir()
    row = make_repo(path)
    row.git("init", "-q")
    row.git("symbolic-ref", "HEAD", "refs/heads/main")
    row.git("config", "core.autocrlf", "false")
    row.write("README.md", text="# test repo\n")
    row.commit("initial", date="2020-01-01T00:00:00+00:00")
    monkeypatch.chdir(path)
    return row


def use_single_layout(repo: types.SimpleNamespace) -> None:
    """Switch the config `init` wrote to the single layout: one spec, claims and ledger for the repo."""
    config_path = repo.cc / "config.toml"
    config_path.write_text(config_path.read_text(encoding="utf-8").replace('layout = "tasks"', 'layout = "single"'), encoding="utf-8", newline="\n")
    for name, content in (("spec.md", config.DEFAULT_SPEC_MD), ("claims.yaml", config.DEFAULT_CLAIMS_YAML), ("ledger.jsonl", "")):
        if not (repo.cc / name).exists():
            (repo.cc / name).write_text(content, encoding="utf-8", newline="\n")


@pytest.fixture
def cc_repo(repo: types.SimpleNamespace) -> types.SimpleNamespace:
    """init + two frozen criteria committed on main; HEAD == main, tree clean.

    These tests cover the single layout, so the config `init` writes is switched to it.
    """
    assert repo.cli("init") == 0
    use_single_layout(repo)
    repo.write(".claimcheck/spec.md", text=TWO_CRITERIA_SPEC)
    repo.commit("add claimcheck files", date="2020-01-02T00:00:00+00:00")
    assert repo.cli("spec", "freeze") == 0
    repo.commit("freeze spec", date="2020-01-03T00:00:00+00:00")
    return repo


@pytest.fixture
def calc_repo(cc_repo: types.SimpleNamespace) -> types.SimpleNamespace:
    """cc_repo + tests on main, then branch `feat` adding src/calc.py and claims."""
    cc_repo.write("conftest.py", text=CALC_CONFTEST)
    cc_repo.write("tests/test_calc.py", text=CALC_TESTS)
    cc_repo.commit("tests", date="2020-01-04T00:00:00+00:00")
    cc_repo.branch("feat")
    cc_repo.write("src/calc.py", text=CALC_SRC)
    cc_repo.write(".claimcheck/claims.yaml", text=CLAIMS_FOR_CALC)
    cc_repo.commit("add calc", date="2020-01-05T00:00:00+00:00")
    return cc_repo
