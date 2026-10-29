"""Config loading, repo-root discovery, ignore-glob matching, and shared helpers.

@author Patrick Finazzo
"""

from __future__ import annotations

import fnmatch
import hashlib
import os
import re
import tomllib
from datetime import UTC, datetime
from pathlib import Path
from typing import TypedDict

from . import ClaimcheckError, SpecError, gitio

CLAIMCHECK_DIR = ".claimcheck"
CONFIG_FILE = "config.toml"
SPEC_FILE = "spec.md"
LOCK_FILE = "spec.lock"
CLAIMS_FILE = "claims.yaml"
LEDGER_FILE = "ledger.jsonl"
RUNS_DIR = "runs"
MUTATE_BACKUP_DIR = "mutate-backup"
MUTATE_SENTINEL = "mutate.lock"
# The tasks layout keeps each task's spec, lock, claims and ledger in its own folder under here.
TASKS_DIR = "tasks"
# "single": one spec, lock, claims file and ledger for the whole repo, as claimcheck always did.
# "tasks": one set per task, so two pull requests never write the same claimcheck file.
LAYOUTS = ("single", "tasks")

# Environment variables claimcheck reads. Every read goes through the functions below, so this is
# the one place to see what the environment can change.
API_KEY_ENV = "ANTHROPIC_API_KEY"
OPENAI_BASE_URL_ENV = "OPENAI_BASE_URL"
OPENAI_API_KEY_ENV = "OPENAI_API_KEY"
OPENAI_MODEL_ENV = "OPENAI_MODEL"
STUB_FILE_ENV = "CLAIMCHECK_STUB_FILE"
TASK_ENV = "CLAIMCHECK_TASK"


def has_api_key() -> bool:
    """Whether an Anthropic API key is set, which makes the `auto` provider use the API."""
    return bool(os.environ.get(API_KEY_ENV))


def read_openai_base_url() -> str | None:
    """Where the `openai` provider connects, if set. The provider falls back to OpenAI's own address."""
    return os.environ.get(OPENAI_BASE_URL_ENV) or None


def read_openai_api_key() -> str | None:
    """The key the `openai` provider sends, if set. Local servers such as Ollama need none."""
    return os.environ.get(OPENAI_API_KEY_ENV) or None


def read_openai_model() -> str | None:
    """The model the `openai` provider asks when no --model or [checker] model reaches it."""
    return os.environ.get(OPENAI_MODEL_ENV) or None


def read_stub_reply_file() -> str | None:
    """The canned-reply file the stub provider returns verbatim, if one is set (tests use this)."""
    return os.environ.get(STUB_FILE_ENV) or None


def read_task_override() -> str | None:
    """The task CLAIMCHECK_TASK names, if it is set and not empty.

    CI sets it: a pull request is checked out with no branch, so the branch cannot name the task.
    """
    return os.environ.get(TASK_ENV) or None


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


# The settings from config.toml, flattened: [checker] and [mutate] keys carry their table's prefix.
Config = TypedDict(
    "Config",
    {
        "base": str,
        "test_cmd": str,
        "ignore": list[str],
        "require_full_coverage": bool,
        "layout": str,
        "checker_provider": str,
        "checker_model": str,
        "checker_fail_on_unverifiable": bool,
        "mutate_max_mutants": int,
        "mutate_timeout_s": int,
        "mutate_min_catch_rate": float,
    },
)


def make_config(
    *,
    base: str = "main",
    test_cmd: str = "python -m pytest -q",
    ignore: list[str] | None = None,
    require_full_coverage: bool = True,
    layout: str = "single",
    checker_provider: str = "claude",
    checker_model: str = "claude-opus-5-5",
    checker_fail_on_unverifiable: bool = True,
    mutate_max_mutants: int = 50,
    mutate_timeout_s: int = 600,
    mutate_min_catch_rate: float = 0.0,
) -> Config:
    """A Config, with the defaults a repo gets when config.toml leaves a key out."""
    return {
        "base": base,
        "test_cmd": test_cmd,
        "ignore": list(DEFAULT_IGNORE) if ignore is None else ignore,
        "require_full_coverage": require_full_coverage,
        "layout": layout,
        "checker_provider": checker_provider,
        "checker_model": checker_model,
        "checker_fail_on_unverifiable": checker_fail_on_unverifiable,
        "mutate_max_mutants": mutate_max_mutants,
        "mutate_timeout_s": mutate_timeout_s,
        "mutate_min_catch_rate": mutate_min_catch_rate,
    }


def find_repo_root(start: Path | None = None) -> Path:
    """Return the git top-level directory for `start` (default: cwd)."""
    cwd = Path(start) if start else Path.cwd()
    output = gitio.run_git(cwd, "rev-parse", "--show-toplevel", check=False).strip()
    if not output:
        raise ClaimcheckError(f"not a git repository: {cwd}")
    return Path(output).resolve()


def resolve_cc_dir(repo: Path) -> Path:
    """The repo's .claimcheck folder."""
    return repo / CLAIMCHECK_DIR


_UNSAFE_TASK_CHARACTERS = re.compile(r"[^A-Za-z0-9._-]")

NO_TASK_MESSAGE = (
    "claimcheck keeps each task's files in .claimcheck/tasks/<branch>/. You are on {where}, which is not a task. "
    "Switch to a task branch, or run claimcheck spec draft to start one."
)


def to_task_name(raw: str) -> str:
    """A branch name made safe as one folder name.

    Every character outside A-Z, a-z, 0-9, '.', '_' and '-' becomes '-', so feat/login is feat-login.
    A name that would point at the folder itself or its parent is refused.
    """
    name = _UNSAFE_TASK_CHARACTERS.sub("-", raw)
    if name in ("", ".", ".."):
        raise SpecError(f"{raw!r} cannot name a task folder; use a branch name with letters or digits")
    return name


def find_task_name(repo: Path, *, settings: Config) -> str:
    """The current task's folder name in the tasks layout: CLAIMCHECK_TASK if set, else the branch.

    Raises SpecError (exit 3) on the base branch or a detached HEAD, which are not tasks.
    """
    override = read_task_override()
    if override:
        return to_task_name(override)
    branch = gitio.read_current_branch(repo)
    if branch in ("", "HEAD"):
        raise SpecError(NO_TASK_MESSAGE.format(where="detached HEAD"))
    if branch == settings["base"]:
        raise SpecError(NO_TASK_MESSAGE.format(where=branch))
    return to_task_name(branch)


def has_task(repo: Path, *, settings: Config) -> bool:
    """Whether there is a current task. The single layout always has one: the whole repo."""
    if settings["layout"] == "single":
        return True
    try:
        find_task_name(repo, settings=settings)
    except SpecError:
        return False
    return True


def resolve_task_dir(repo: Path) -> Path:
    """Where the current task's spec, lock, claims and ledger live.

    Single layout: the .claimcheck folder itself, as always.
    Tasks layout: .claimcheck/tasks/<task>/. Raises SpecError when there is no current task.
    """
    settings = load(repo)
    if settings["layout"] == "single":
        return resolve_cc_dir(repo)
    return resolve_cc_dir(repo) / TASKS_DIR / find_task_name(repo, settings=settings)


def to_repo_path(repo: Path, *, path: Path) -> str:
    """A path inside the repo the way git names it: relative to the root, with forward slashes."""
    return path.relative_to(repo).as_posix()


def _read_typed(table: dict, *, key: str, kind, where: str, default):
    """table[key] if present and of the right type, else a ClaimcheckError that names the key."""
    if key not in table:
        return default
    value = table[key]
    ok = isinstance(value, kind) and not (kind is int and isinstance(value, bool))
    if kind is float:
        ok = isinstance(value, (int, float)) and not isinstance(value, bool)
    if not ok:
        want = {str: "a string", bool: "true or false", int: "a whole number", float: "a number", list: "a list of strings"}[kind]
        raise ClaimcheckError(f"invalid config.toml: {where}{key} must be {want} (got {value!r})")
    return value


def load(repo: Path) -> Config:
    """Load `.claimcheck/config.toml`; missing file or keys fall back to defaults."""
    path = resolve_cc_dir(repo) / CONFIG_FILE
    cfg = make_config()
    if not path.exists():
        return cfg
    try:
        raw = tomllib.loads(path.read_text(encoding="utf-8-sig"))
    except tomllib.TOMLDecodeError as error:
        raise ClaimcheckError(f"invalid config.toml: {error}") from error
    cfg["base"] = _read_typed(raw, key="base", kind=str, where="", default=cfg["base"])
    cfg["test_cmd"] = _read_typed(raw, key="test_cmd", kind=str, where="", default=cfg["test_cmd"])
    ignore = _read_typed(raw, key="ignore", kind=list, where="", default=cfg["ignore"])
    if not all(isinstance(glob, str) for glob in ignore):
        raise ClaimcheckError("invalid config.toml: ignore must be a list of strings")
    cfg["ignore"] = list(ignore)
    cfg["require_full_coverage"] = _read_typed(raw, key="require_full_coverage", kind=bool, where="", default=cfg["require_full_coverage"])
    cfg["layout"] = _read_typed(raw, key="layout", kind=str, where="", default=cfg["layout"])
    if cfg["layout"] not in LAYOUTS:
        raise ClaimcheckError(f'invalid config.toml: layout must be "single" or "tasks" (got {cfg["layout"]!r})')
    for name in ("checker", "mutate"):
        if name in raw and not isinstance(raw[name], dict):
            raise ClaimcheckError(f"invalid config.toml: [{name}] must be a table (got {raw[name]!r})")
    checker = raw.get("checker", {})
    cfg["checker_provider"] = _read_typed(checker, key="provider", kind=str, where="checker.", default=cfg["checker_provider"])
    cfg["checker_model"] = _read_typed(checker, key="model", kind=str, where="checker.", default=cfg["checker_model"])
    cfg["checker_fail_on_unverifiable"] = _read_typed(
        checker, key="fail_on_unverifiable", kind=bool, where="checker.", default=cfg["checker_fail_on_unverifiable"]
    )
    mutate = raw.get("mutate", {})
    cfg["mutate_max_mutants"] = _read_typed(mutate, key="max_mutants", kind=int, where="mutate.", default=cfg["mutate_max_mutants"])
    cfg["mutate_timeout_s"] = _read_typed(mutate, key="timeout_s", kind=int, where="mutate.", default=cfg["mutate_timeout_s"])
    cfg["mutate_min_catch_rate"] = float(_read_typed(mutate, key="min_catch_rate", kind=float, where="mutate.", default=cfg["mutate_min_catch_rate"]))
    return cfg


def _list_glob_variants(g: str) -> list[str]:
    """fnmatch cannot match zero directories for `**/`, so also try the pattern without it."""
    output = [g]
    if g.startswith("**/"):
        output.append(g[3:])
    if "/**/" in g:
        output.append(g.replace("/**/", "/"))
    return output


def is_ignored(path: str, *, globs: list[str]) -> bool:
    """fnmatch a repo-relative POSIX path against the ignore globs.

    `*` and `**` both match across separators (fnmatch semantics), so `docs/**`
    covers every depth and `*.md` covers nested markdown. A leading `**/` also
    matches no directory at all, so `**/*.md` covers `README.md`.
    """
    normalized = path.replace("\\", "/")
    if normalized.startswith(CLAIMCHECK_DIR + "/"):
        return True
    return any(fnmatch.fnmatchcase(normalized, value) for glob in globs for value in _list_glob_variants(glob))


def format_utc_now() -> str:
    """Now, in UTC, to the second, as written in ledger and run files."""
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def make_run_id() -> str:
    """A run id that sorts by time: a UTC timestamp plus four random hex digits."""
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    return f"{stamp}-{os.urandom(2).hex()}"


def hash_bytes(data: bytes) -> str:
    """Hex SHA-256 of bytes."""
    return hashlib.sha256(data).hexdigest()


def hash_text(text: str) -> str:
    """Hex SHA-256 of text, encoded as UTF-8."""
    return hash_bytes(text.encode("utf-8"))


def compute_repo_id(repo: Path) -> str:
    """sha256 of the origin URL, or of the absolute path when there is no origin."""
    url = gitio.run_git(repo, "remote", "get-url", "origin", check=False).strip()
    return hash_text(url or str(repo.resolve()))
