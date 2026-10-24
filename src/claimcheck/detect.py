"""Work out a repo's test command and which paths are tests, so `init` can write a usable config.

Detection is a best guess from marker files. It never runs anything and never reads `.env`.

@author Patrick Finazzo
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

# Paths that are never product code, whatever the stack.
BASE_IGNORE = [
    "*.md",
    "docs/**",
    ".claimcheck/**",
    "*.lock",
    "*.txt",
    ".gitignore",
    ".github/**",
    "package-lock.json",
    "pnpm-lock.yaml",
]

# What `init` adds to .gitignore: scratch output, not history.
GITIGNORE_LINES = [
    ".claimcheck/runs/",
    ".claimcheck/mutate-backup/",
    ".claimcheck/mutate.lock",
    ".claimcheck/worktrees/",
    ".claimcheck/app-state.json",
    ".claimcheck/spec-draft.json",
]

_TEST_DIRS = ["tests/**", "**/tests/**", "test/**", "**/test/**"]
_NPM_DEFAULT_TEST = "no test specified"


@dataclass
class Stack:
    name: str
    test_cmd: str
    test_globs: list[str] = field(default_factory=list)


@dataclass
class Detection:
    stack: Stack | None
    others: list[str]

    @property
    def test_cmd(self) -> str | None:
        return self.stack.test_cmd if self.stack else None

    @property
    def ignore(self) -> list[str]:
        extra = self.stack.test_globs if self.stack else list(_TEST_DIRS)
        return BASE_IGNORE + [g for g in extra if g not in BASE_IGNORE]


def _node(repo: Path) -> Stack | None:
    pkg = repo / "package.json"
    if not pkg.is_file():
        return None
    try:
        data = json.loads(pkg.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        data = {}
    script = ((data.get("scripts") or {}).get("test") or "") if isinstance(data, dict) else ""
    if not script or _NPM_DEFAULT_TEST in script:
        return None
    runner = "npm test"
    if (repo / "pnpm-lock.yaml").is_file():
        runner = "pnpm test"
    elif (repo / "yarn.lock").is_file():
        runner = "yarn test"
    return Stack("node", runner, _TEST_DIRS + ["__tests__/**", "**/__tests__/**", "*.test.*", "*.spec.*"])


def _python(repo: Path) -> Stack | None:
    markers = ("pyproject.toml", "setup.cfg", "setup.py", "pytest.ini", "tox.ini", "requirements.txt")
    if not any((repo / m).is_file() for m in markers):
        return None
    cmd = "python -m unittest" if _has_unittest_only(repo) else "python -m pytest -q"
    return Stack(
        "python",
        cmd,
        _TEST_DIRS + ["test_*.py", "*/test_*.py", "*_test.py", "conftest.py", "*/conftest.py"],
    )


def _has_unittest_only(repo: Path) -> bool:
    """True only when the tests import unittest and nothing mentions pytest."""
    seen_unittest = False
    for d in ("tests", "test"):
        folder = repo / d
        if not folder.is_dir():
            continue
        for p in list(folder.rglob("*.py"))[:50]:
            try:
                text = p.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            if "pytest" in text:
                return False
            if "unittest" in text:
                seen_unittest = True
    return seen_unittest


def _go(repo: Path) -> Stack | None:
    if (repo / "go.mod").is_file():
        return Stack("go", "go test ./...", ["*_test.go"])
    return None


def _rust(repo: Path) -> Stack | None:
    if (repo / "Cargo.toml").is_file():
        return Stack("rust", "cargo test", ["tests/**", "**/tests/**"])
    return None


def _jvm(repo: Path) -> Stack | None:
    if (repo / "pom.xml").is_file():
        return Stack("maven", "mvn -q test", ["src/test/**", "**/src/test/**"])
    for name in ("build.gradle", "build.gradle.kts"):
        if (repo / name).is_file():
            wrapper = "gradlew.bat" if (repo / "gradlew.bat").is_file() and not (repo / "gradlew").is_file() else "./gradlew"
            return Stack("gradle", f"{wrapper} test", ["src/test/**", "**/src/test/**"])
    return None


_DETECTORS = (_node, _python, _go, _rust, _jvm)


def detect(repo: Path) -> Detection:
    """First match wins. Other stacks found are named so `init` can mention them."""
    found = [s for s in (d(repo) for d in _DETECTORS) if s is not None]
    return Detection(found[0] if found else None, [s.name for s in found[1:]])


def render_config(det: Detection) -> str:
    """The config.toml text `init` writes. Falls back to the stock pytest command when nothing matched."""
    test_cmd = det.test_cmd or "python -m pytest -q"
    ignore = ", ".join(json.dumps(g) for g in det.ignore)
    return f"""\
# claimcheck configuration — written by `claimcheck init`, edit freely.
version = 1
base = "main"
test_cmd = {json.dumps(test_cmd)}
# Paths that are not product code. Planted bugs go only into files NOT listed here,
# and the commit hook does not ask for a claim covering them.
ignore = [{ignore}]
require_full_coverage = true

[checker]
provider = "auto"            # "auto" | "claude" | "claude-cli" | "stub"
model = "claude-opus-5-5"

[mutate]
max_mutants = 50
timeout_s = 600
min_catch_rate = 0.0         # 0.0 = report only; raise it to make `mutate` a gate
"""


def ensure_gitignore(repo: Path) -> list[str]:
    """Append any missing scratch-output lines to .gitignore. Returns the lines added."""
    path = repo / ".gitignore"
    existing = path.read_text(encoding="utf-8") if path.is_file() else ""
    have = {line.strip() for line in existing.splitlines()}
    missing = [l for l in GITIGNORE_LINES if l not in have]
    if not missing:
        return []
    sep = "" if not existing or existing.endswith("\n") else "\n"
    block = sep + ("\n" if existing and not existing.endswith("\n\n") else "") + "# claimcheck scratch output\n" + "\n".join(missing) + "\n"
    with open(path, "a", encoding="utf-8", newline="\n") as f:
        f.write(block)
    return missing
