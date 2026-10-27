"""Work out a repo's test command and which paths are tests, so `init` can write a usable config.

Detection is a best guess from marker files. It never runs anything and never reads `.env`.

@author Patrick Finazzo
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import TypedDict

from . import gitio, redact

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


# A project type: its name, the command that runs its tests, and where its tests live.
Stack = TypedDict("Stack", {"name": str, "test_cmd": str, "test_globs": list[str]})

# The stack `init` found (first match), the other stacks also present, and what follows from
# the stack: its test command (None when nothing matched) and the ignore globs for config.toml.
Detection = TypedDict("Detection", {"stack": Stack | None, "others": list[str], "test_cmd": str | None, "ignore": list[str]})


def make_stack(name: str, *, test_cmd: str, test_globs: list[str]) -> Stack:
    """A Stack from its parts."""
    return {"name": name, "test_cmd": test_cmd, "test_globs": test_globs}


def make_detection(*, stack: Stack | None, others: list[str]) -> Detection:
    """A Detection, with the test command and ignore globs worked out from the stack."""
    extra = stack["test_globs"] if stack else list(_TEST_DIRS)
    return {
        "stack": stack,
        "others": others,
        "test_cmd": stack["test_cmd"] if stack else None,
        "ignore": BASE_IGNORE + [glob for glob in extra if glob not in BASE_IGNORE],
    }


def _detect_node(repo: Path) -> Stack | None:
    pkg = repo / "package.json"
    if not pkg.is_file():
        return None
    try:
        raw = json.loads(pkg.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        raw = {}
    script = ((raw.get("scripts") or {}).get("test") or "") if isinstance(raw, dict) else ""
    if not script or _NPM_DEFAULT_TEST in script:
        return None
    runner = "npm test"
    if (repo / "pnpm-lock.yaml").is_file():
        runner = "pnpm test"
    elif (repo / "yarn.lock").is_file():
        runner = "yarn test"
    return make_stack("node", test_cmd=runner, test_globs=_TEST_DIRS + ["__tests__/**", "**/__tests__/**", "*.test.*", "*.spec.*"])


def _detect_python(repo: Path) -> Stack | None:
    markers = ("pyproject.toml", "setup.cfg", "setup.py", "pytest.ini", "tox.ini", "requirements.txt")
    if not any((repo / marker).is_file() for marker in markers):
        return None
    cmd = "python -m unittest" if _has_unittest_only(repo) else "python -m pytest -q"
    return make_stack(
        "python",
        test_cmd=cmd,
        test_globs=_TEST_DIRS + ["test_*.py", "*/test_*.py", "*_test.py", "conftest.py", "*/conftest.py"],
    )


def _read_test_text(path: Path) -> str:
    """A test file's text. An unreadable file counts as empty, because it cannot name a framework."""
    try:
        return path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return ""


def _has_unittest_only(repo: Path) -> bool:
    """True only when the tests import unittest and nothing mentions pytest."""
    folders = [repo / name for name in ("tests", "test") if (repo / name).is_dir()]
    texts = [_read_test_text(path) for folder in folders for path in list(folder.rglob("*.py"))[:50]]
    if any("pytest" in text for text in texts):
        return False
    return any("unittest" in text for text in texts)


def _go(repo: Path) -> Stack | None:
    if (repo / "go.mod").is_file():
        return make_stack("go", test_cmd="go test ./...", test_globs=["*_test.go"])
    return None


def _detect_rust(repo: Path) -> Stack | None:
    if (repo / "Cargo.toml").is_file():
        return make_stack("rust", test_cmd="cargo test", test_globs=["tests/**", "**/tests/**"])
    return None


def _detect_jvm(repo: Path) -> Stack | None:
    if (repo / "pom.xml").is_file():
        return make_stack("maven", test_cmd="mvn -q test", test_globs=["src/test/**", "**/src/test/**"])
    for name in ("build.gradle", "build.gradle.kts"):
        if (repo / name).is_file():
            wrapper = "gradlew.bat" if (repo / "gradlew.bat").is_file() and not (repo / "gradlew").is_file() else "./gradlew"
            return make_stack("gradle", test_cmd=f"{wrapper} test", test_globs=["src/test/**", "**/src/test/**"])
    return None


_DETECTORS = (_detect_node, _detect_python, _go, _detect_rust, _detect_jvm)


def detect(repo: Path) -> Detection:
    """First match wins. Other stacks found are named so `init` can mention them."""
    found = [text for text in (detector(repo) for detector in _DETECTORS) if text is not None]
    return make_detection(stack=found[0] if found else None, others=[message["name"] for message in found[1:]])


def render_config(det: Detection) -> str:
    """The config.toml text `init` writes. Falls back to the stock pytest command when nothing matched."""
    test_cmd = det["test_cmd"] or "python -m pytest -q"
    ignore = ", ".join(json.dumps(glob) for glob in det["ignore"])
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
    missing = [line_text for line_text in GITIGNORE_LINES if line_text not in have]
    if not missing:
        return []
    sep = "" if not existing or existing.endswith("\n") else "\n"
    block = sep + ("\n" if existing and not existing.endswith("\n\n") else "") + "# claimcheck scratch output\n" + "\n".join(missing) + "\n"
    with open(path, "a", encoding="utf-8", newline="\n") as file:
        file.write(block)
    return missing


# What `init` does FIRST, before it touches anything else: make sure secrets cannot be committed.
SECRET_IGNORE_LINES = [".env", ".env.*", "!.env.example", "*.pem", "*.key", "*.p12", "id_rsa*", "id_ed25519*"]
_ENV_LINES = (".env", ".env.*", "!.env.example")


def _make_separator_after(text: str) -> str:
    """The blank line new lines need after existing text: none for an empty file."""
    if not text:
        return ""
    return "\n" if text.endswith("\n") else "\n\n"


def ensure_secrets_ignored(repo: Path) -> dict:
    """Create .gitignore if it is missing and make sure .env and key files are in it.

    Returns {"created": bool, "added": [...], "tracked": [...]}. `tracked` lists secret-looking files
    that git already tracks: ignoring them now does not untrack them, so the person has to be told.
    """
    path = repo / ".gitignore"
    existed = path.is_file()
    text = path.read_text(encoding="utf-8-sig") if existed else ""
    have = {line.strip() for line in text.splitlines()}
    missing = [line_text for line_text in SECRET_IGNORE_LINES if line_text not in have]
    # Already covered, perhaps by a pattern like .env* or a global rule.
    if gitio.is_ignored(repo, path=".env"):
        missing = [line_text for line_text in missing if line_text not in _ENV_LINES]
    added: list[str] = []
    if missing or not existed:
        sep = _make_separator_after(text)
        block = ("\n" if text and sep == "\n" else "") + "# secrets: never commit these\n" + "\n".join(missing) + "\n" if missing else ""
        with open(path, "a" if existed else "w", encoding="utf-8", newline="\n") as file:
            file.write(sep + block if existed else block)
        added = missing
    tracked = [tracked_file for tracked_file in gitio.list_tracked_files(repo) if redact.is_secret_path(tracked_file)]
    return {"created": not existed, "added": added, "tracked": tracked}
