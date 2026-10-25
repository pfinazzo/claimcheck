"""Config loading, repo-root discovery, ignore-glob matching, and shared helpers.

@author Patrick Finazzo
"""

from __future__ import annotations

import fnmatch
import hashlib
import os
import tomllib
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from . import ClaimcheckError, gitio

CLAIMCHECK_DIR = ".claimcheck"
CONFIG_FILE = "config.toml"
SPEC_FILE = "spec.md"
LOCK_FILE = "spec.lock"
CLAIMS_FILE = "claims.yaml"
LEDGER_FILE = "ledger.jsonl"
RUNS_DIR = "runs"
MUTATE_BACKUP_DIR = "mutate-backup"
MUTATE_SENTINEL = "mutate.lock"

DEFAULT_IGNORE = ["*.md", "docs/**", ".claimcheck/**", "*.lock", "*.txt", ".gitignore", ".github/**", "package-lock.json", "pnpm-lock.yaml"]

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
    out = gitio.git(cwd, "rev-parse", "--show-toplevel", check=False).strip()
    if not out:
        raise ClaimcheckError(f"not a git repository: {cwd}")
    return Path(out).resolve()


def cc_dir(repo: Path) -> Path:
    return repo / CLAIMCHECK_DIR


def _want(table: dict, key: str, kind, where: str, default):
    """table[key] if present and of the right type, else a ClaimcheckError that names the key."""
    if key not in table:
        return default
    v = table[key]
    ok = isinstance(v, kind) and not (kind is int and isinstance(v, bool))
    if kind is float:
        ok = isinstance(v, (int, float)) and not isinstance(v, bool)
    if not ok:
        want = {str: "a string", bool: "true or false", int: "a whole number", float: "a number", list: "a list of strings"}[kind]
        raise ClaimcheckError(f"invalid config.toml: {where}{key} must be {want} (got {v!r})")
    return v


def load(repo: Path) -> Config:
    """Load `.claimcheck/config.toml`; missing file or keys fall back to defaults."""
    path = cc_dir(repo) / CONFIG_FILE
    cfg = Config()
    if not path.exists():
        return cfg
    try:
        data = tomllib.loads(path.read_text(encoding="utf-8-sig"))
    except tomllib.TOMLDecodeError as e:
        raise ClaimcheckError(f"invalid config.toml: {e}") from e
    cfg.base = _want(data, "base", str, "", cfg.base)
    cfg.test_cmd = _want(data, "test_cmd", str, "", cfg.test_cmd)
    ignore = _want(data, "ignore", list, "", cfg.ignore)
    if not all(isinstance(g, str) for g in ignore):
        raise ClaimcheckError("invalid config.toml: ignore must be a list of strings")
    cfg.ignore = list(ignore)
    cfg.require_full_coverage = _want(data, "require_full_coverage", bool, "", cfg.require_full_coverage)
    for name in ("checker", "mutate"):
        if name in data and not isinstance(data[name], dict):
            raise ClaimcheckError(f"invalid config.toml: [{name}] must be a table (got {data[name]!r})")
    checker = data.get("checker", {})
    cfg.checker_provider = _want(checker, "provider", str, "checker.", cfg.checker_provider)
    cfg.checker_model = _want(checker, "model", str, "checker.", cfg.checker_model)
    mutate = data.get("mutate", {})
    cfg.mutate_max_mutants = _want(mutate, "max_mutants", int, "mutate.", cfg.mutate_max_mutants)
    cfg.mutate_timeout_s = _want(mutate, "timeout_s", int, "mutate.", cfg.mutate_timeout_s)
    cfg.mutate_min_catch_rate = float(_want(mutate, "min_catch_rate", float, "mutate.", cfg.mutate_min_catch_rate))
    return cfg


def _glob_variants(g: str) -> list[str]:
    """fnmatch cannot match zero directories for `**/`, so also try the pattern without it."""
    out = [g]
    if g.startswith("**/"):
        out.append(g[3:])
    if "/**/" in g:
        out.append(g.replace("/**/", "/"))
    return out


def is_ignored(path: str, globs: list[str]) -> bool:
    """fnmatch a repo-relative POSIX path against the ignore globs.

    `*` and `**` both match across separators (fnmatch semantics), so `docs/**`
    covers every depth and `*.md` covers nested markdown. A leading `**/` also
    matches no directory at all, so `**/*.md` covers `README.md`.
    """
    p = path.replace("\\", "/")
    if p.startswith(CLAIMCHECK_DIR + "/"):
        return True
    return any(fnmatch.fnmatchcase(p, v) for g in globs for v in _glob_variants(g))


def utc_now_iso() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def new_run_id() -> str:
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    return f"{stamp}-{os.urandom(2).hex()}"


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_text(text: str) -> str:
    return sha256_bytes(text.encode("utf-8"))


def repo_id(repo: Path) -> str:
    """sha256 of the origin URL, or of the absolute path when there is no origin."""
    url = gitio.git(repo, "remote", "get-url", "origin", check=False).strip()
    return sha256_text(url or str(repo.resolve()))
