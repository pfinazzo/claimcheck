"""Pre-commit hook: installer and the staged-diff rules.

@author Patrick Finazzo
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

from . import ClaimcheckError, ClaimsError, SpecError, claims, config, gitio, spec

HOOK_MARKER = "claimcheck"


def build_hook_line() -> str:
    """The line the pre-commit hook runs: this Python, so the hook works without claimcheck on PATH."""
    exe = Path(sys.executable).as_posix()
    return f'"{exe}" -m claimcheck hook pre-commit || exit 1\n'


def resolve_hook_file(repo: Path) -> Path:
    """Where git will actually look for pre-commit: honors core.hooksPath (husky and friends)
    and linked worktrees, which share the main repository's hooks."""
    hooks = gitio.run_git(repo, "rev-parse", "--git-path", "hooks").strip()
    return (repo / hooks).resolve() / "pre-commit"


_TRAILING_EXIT = re.compile(r"^\s*exit(\s+\d+)?\s*$")
_SHELLS = ("sh", "bash", "zsh", "dash", "ksh")


def install(repo: Path) -> bool:
    """Install or add the hook line. Returns True when the file changed.

    An existing hook is kept: our line goes in before a trailing `exit` (otherwise it would never
    run), and a hook written in another language is refused rather than corrupted.
    """
    path = resolve_hook_file(repo)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        existing = path.read_bytes().decode("utf-8", errors="replace")
        if HOOK_MARKER in existing:
            return False
        first = existing.splitlines()[0] if existing.strip() else ""
        if first.startswith("#!") and not any(shell in first for shell in _SHELLS):
            raise ClaimcheckError(
                f"{path} is not a shell script ({first.strip()}), so claimcheck will not edit it. "
                f"Add this line to it yourself: {build_hook_line().strip()}"
            )
        lines = existing.splitlines(keepends=True)
        last = next((index for index in range(len(lines) - 1, -1, -1) if lines[index].strip()), None)
        line = build_hook_line()
        if last is not None and _TRAILING_EXIT.match(lines[last]):
            lines.insert(last, line)
            new = "".join(lines)
        else:
            sep = "" if not existing or existing.endswith("\n") else "\n"
            new = existing + sep + line
        path.write_bytes(new.encode("utf-8"))
    else:
        path.write_bytes(("#!/bin/sh\n" + build_hook_line()).encode("utf-8"))
    try:
        path.chmod(path.stat().st_mode | 0o111)
    except OSError as error:
        # Without the execute bit git skips the hook without a word, so claims would go unchecked.
        raise ClaimcheckError(f"wrote {path} but could not make it executable ({error}); run chmod +x on it") from error
    return True


def run_pre_commit(repo: Path, *, settings: config.Config) -> int:
    """Return the exit code; messages go to stderr."""
    staged = gitio.list_staged_paths(repo)
    # Deletions count: removing code is a change a claim must cover too.
    code_paths = sorted({staged_path for _status, staged_path in staged if not config.is_ignored(staged_path, globs=settings["ignore"])})
    if not code_paths:
        return 0

    rel_claims = f"{config.CLAIMCHECK_DIR}/{config.CLAIMS_FILE}"
    staged_claims = next((message for message, p in staged if p == rel_claims), None)
    if staged_claims not in ("A", "M"):
        raise ClaimsError(
            f"staged code paths {code_paths} but {rel_claims} is not staged (added or modified)"
        )
    text = gitio.read_staged_file(repo, path=rel_claims) or ""

    lock_ids: set[int] | None
    try:
        lock_ids = spec.list_lock_ids(spec.read_lock(repo))
    except SpecError:
        # No lock: any cited criterion is a violation.
        lock_ids = None
    claims_file = claims.load_and_validate(text, lock_ids=lock_ids)

    staged_set = set(code_paths)
    problems: list[str] = []
    for claim in claims_file["claims"]:
        extra = [file_path for file_path in claim["files"] if file_path not in staged_set]
        if extra:
            problems.append(f"claim {claim['id']}: files not in the staged diff: {extra}")
    if problems:
        raise ClaimsError("\n  ".join(["claims do not match the staged diff:"] + problems))

    covered = {file for claim in claims_file["claims"] for file in claim["files"]}
    uncovered = [code_path for code_path in code_paths if code_path not in covered]
    if uncovered:
        msg = "staged paths with no claim covering them: " + ", ".join(uncovered)
        if settings["require_full_coverage"]:
            raise ClaimsError(msg)
        print(f"claimcheck warning: {msg}", file=sys.stderr)
    return 0
