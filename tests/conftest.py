"""Throwaway git repos for every test, isolated from the developer's git config.

@author Patrick Finazzo
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

from claimcheck import cli

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


class Repo:
    def __init__(self, path: Path):
        self.path = path

    def git(self, *args: str, check: bool = True, env: dict | None = None) -> str:
        full_env = dict(os.environ)
        if env:
            full_env.update(env)
        proc = subprocess.run(
            ["git", *args], cwd=self.path, capture_output=True, text=True, env=full_env, timeout=SUBPROCESS_TIMEOUT_S
        )
        if check and proc.returncode != 0:
            raise AssertionError(f"git {' '.join(args)} failed:\n{proc.stdout}\n{proc.stderr}")
        return proc.stdout

    def write(self, rel: str, text: str) -> Path:
        p = self.path / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8", newline="\n")
        return p

    def read(self, rel: str) -> str:
        return (self.path / rel).read_text(encoding="utf-8")

    def commit(self, msg: str, *, verify: bool = False, date: str | None = None) -> str:
        self.git("add", "-A")
        args = ["commit", "-q", "-m", msg]
        if not verify:
            args.append("--no-verify")
        env = {"GIT_AUTHOR_DATE": date, "GIT_COMMITTER_DATE": date} if date else None
        self.git(*args, env=env)
        return self.sha()

    def try_commit(self, msg: str) -> subprocess.CompletedProcess:
        self.git("add", "-A")
        return subprocess.run(
            ["git", "commit", "-q", "-m", msg], cwd=self.path, capture_output=True, text=True, timeout=SUBPROCESS_TIMEOUT_S
        )

    def sha(self, ref: str = "HEAD") -> str:
        return self.git("rev-parse", ref).strip()

    def branch(self, name: str) -> None:
        self.git("checkout", "-q", "-b", name)

    @property
    def cc(self) -> Path:
        return self.path / ".claimcheck"

    def cli(self, *argv: str) -> int:
        return cli.main(list(argv))


@pytest.fixture
def repo(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Repo:
    """An empty git repo with an isolated git config and a fixed test identity."""
    empty_cfg = tmp_path / "gitconfig"
    empty_cfg.write_text("", encoding="utf-8")
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(empty_cfg))
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    for k in ("GIT_AUTHOR_NAME", "GIT_COMMITTER_NAME"):
        monkeypatch.setenv(k, "Test")
    for k in ("GIT_AUTHOR_EMAIL", "GIT_COMMITTER_EMAIL"):
        monkeypatch.setenv(k, "test@example.com")
    monkeypatch.delenv("CLAIMCHECK_STUB_FILE", raising=False)
    monkeypatch.delenv("GIT_INDEX_FILE", raising=False)
    monkeypatch.delenv("GIT_DIR", raising=False)

    path = tmp_path / "repo"
    path.mkdir()
    r = Repo(path)
    r.git("init", "-q")
    r.git("symbolic-ref", "HEAD", "refs/heads/main")
    r.git("config", "core.autocrlf", "false")
    r.write("README.md", "# test repo\n")
    r.commit("initial", date="2020-01-01T00:00:00+00:00")
    monkeypatch.chdir(path)
    return r


@pytest.fixture
def cc_repo(repo: Repo) -> Repo:
    """init + two frozen criteria committed on main; HEAD == main, tree clean."""
    assert repo.cli("init") == 0
    repo.write(".claimcheck/spec.md", TWO_CRITERIA_SPEC)
    repo.commit("add claimcheck files", date="2020-01-02T00:00:00+00:00")
    assert repo.cli("spec", "freeze") == 0
    repo.commit("freeze spec", date="2020-01-03T00:00:00+00:00")
    return repo


@pytest.fixture
def calc_repo(cc_repo: Repo) -> Repo:
    """cc_repo + tests on main, then branch `feat` adding src/calc.py and claims."""
    cc_repo.write("conftest.py", CALC_CONFTEST)
    cc_repo.write("tests/test_calc.py", CALC_TESTS)
    cc_repo.commit("tests", date="2020-01-04T00:00:00+00:00")
    cc_repo.branch("feat")
    cc_repo.write("src/calc.py", CALC_SRC)
    cc_repo.write(".claimcheck/claims.yaml", CLAIMS_FOR_CALC)
    cc_repo.commit("add calc", date="2020-01-05T00:00:00+00:00")
    return cc_repo
