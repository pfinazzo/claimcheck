"""Config loading, repo-root discovery, ignore-glob matching, and shared helpers.

@author Patrick Finazzo
"""

from __future__ import annotations

import fnmatch
import hashlib
import os
import subprocess
import tomllib
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from . import ClaimcheckError

CLAIMCHECK_DIR = ".claimcheck"
CONFIG_FILE = "config.toml"
SPEC_FILE = "spec.md"
LOCK_FILE = "spec.lock"
CLAIMS_FILE = "claims.yaml"
LEDGER_FILE = "ledger.jsonl"
RUNS_DIR = "runs"
MUTATE_BACKUP_DIR = "mutate-backup"
MUTATE_SENTINEL = "mutate.lock"

DEFAULT_IGNORE = ["*.md", "docs/**", ".claimcheck/**", "*.lock", "*.txt"]

DEFAULT_CONFIG_TOML = """\
# claimcheck configuration — written by `claimcheck init`, edit freely.
version = 1
base = "main"
test_cmd = "python -m pytest -q"
ignore = ["*.md", "docs/**", ".claimcheck/**", "*.lock", "*.txt"]
require_full_coverage = true

[checker]
provider = "claude"          # "claude" | "stub"
model = "claude-opus-5-5"

[mutate]
max_mutants = 50
timeout_s = 600
min_catch_rate = 0.0         # 0.0 = report only; raise it to make `mutate` a gate
"""

DEFAULT_SPEC_MD = """\
# Acceptance criteria

Frozen with `claimcheck spec freeze`. Add nothing after the diff starts.

- [ ] 1. Replace this placeholder with a criterion a test can check.
"""

DEFAULT_CLAIMS_YAML = """\
# claimcheck claims file — one entry per thing the author asserts about a diff.
version: 1
author: ""
base: "main"
claims: []
"""


@dataclass
class Config:
    base: str = "main"
    test_cmd: str = "python -m pytest -q"
    ignore: list[str] = field(default_factory=lambda: list(DEFAULT_IGNORE))
    require_full_coverage: bool = True
    checker_provider: str = "claude"
    checker_model: str = "claude-opus-5-5"
    mutate_max_mutants: int = 50
    mutate_timeout_s: int = 600
    mutate_min_catch_rate: float = 0.0


def find_repo_root(start: Path | None = None) -> Path:
    """Return the git top-level directory for `start` (default: cwd)."""
    cwd = Path(start) if start else Path.cwd()
    proc = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        cwd=cwd,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise ClaimcheckError(f"not a git repository: {cwd}")
    return Path(proc.stdout.strip()).resolve()


def cc_dir(repo: Path) -> Path:
    return repo / CLAIMCHECK_DIR


def load(repo: Path) -> Config:
    """Load `.claimcheck/config.toml`; missing file or keys fall back to defaults."""
    path = cc_dir(repo) / CONFIG_FILE
    cfg = Config()
    if not path.exists():
        return cfg
    try:
        data = tomllib.loads(path.read_text(encoding="utf-8"))
    except tomllib.TOMLDecodeError as e:
        raise ClaimcheckError(f"invalid config.toml: {e}")
    cfg.base = str(data.get("base", cfg.base))
    cfg.test_cmd = str(data.get("test_cmd", cfg.test_cmd))
    cfg.ignore = [str(g) for g in data.get("ignore", cfg.ignore)]
    cfg.require_full_coverage = bool(data.get("require_full_coverage", cfg.require_full_coverage))
    checker = data.get("checker", {}) or {}
    cfg.checker_provider = str(checker.get("provider", cfg.checker_provider))
    cfg.checker_model = str(checker.get("model", cfg.checker_model))
    mutate = data.get("mutate", {}) or {}
    cfg.mutate_max_mutants = int(mutate.get("max_mutants", cfg.mutate_max_mutants))
    cfg.mutate_timeout_s = int(mutate.get("timeout_s", cfg.mutate_timeout_s))
    cfg.mutate_min_catch_rate = float(mutate.get("min_catch_rate", cfg.mutate_min_catch_rate))
    return cfg


def is_ignored(path: str, globs: list[str]) -> bool:
    """fnmatch a repo-relative POSIX path against the ignore globs.

    `*` and `**` both match across separators (fnmatch semantics), so `docs/**`
    covers every depth and `*.md` covers nested markdown.
    """
    p = path.replace("\\", "/")
    if p.startswith(CLAIMCHECK_DIR + "/"):
        return True
    return any(fnmatch.fnmatchcase(p, g) for g in globs)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def new_run_id() -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return f"{stamp}-{os.urandom(2).hex()}"


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_text(text: str) -> str:
    return sha256_bytes(text.encode("utf-8"))


def repo_id(repo: Path) -> str:
    """sha256 of the origin URL, or of the absolute path when there is no origin."""
    proc = subprocess.run(
        ["git", "remote", "get-url", "origin"], cwd=repo, capture_output=True, text=True
    )
    source = proc.stdout.strip() if proc.returncode == 0 and proc.stdout.strip() else str(repo.resolve())
    return sha256_text(source)
