"""Pre-commit hook: installer and the staged-diff rules.

@author Patrick Finazzo
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

from . import ClaimcheckError, ClaimsError, SpecError, gitio
from . import claims as CL
from . import config as C
from . import spec as S

HOOK_MARKER = "claimcheck"


def hook_line() -> str:
    """The line the pre-commit hook runs: this Python, so the hook works without claimcheck on PATH."""
    exe = Path(sys.executable).as_posix()
    return f'"{exe}" -m claimcheck hook pre-commit || exit 1\n'


def hook_file(repo: Path) -> Path:
    """Where git will actually look for pre-commit: honors core.hooksPath (husky and friends)
    and linked worktrees, which share the main repository's hooks."""
    hooks = gitio.git(repo, "rev-parse", "--git-path", "hooks").strip()
    return (repo / hooks).resolve() / "pre-commit"


_TRAILING_EXIT = re.compile(r"^\s*exit(\s+\d+)?\s*$")
_SHELLS = ("sh", "bash", "zsh", "dash", "ksh")


def install(repo: Path) -> bool:
    """Install or add the hook line. Returns True when the file changed.

    An existing hook is kept: our line goes in before a trailing `exit` (otherwise it would never
    run), and a hook written in another language is refused rather than corrupted.
    """
    path = hook_file(repo)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        existing = path.read_bytes().decode("utf-8", errors="replace")
        if HOOK_MARKER in existing:
            return False
        first = existing.splitlines()[0] if existing.strip() else ""
        if first.startswith("#!") and not any(s in first for s in _SHELLS):
            raise ClaimcheckError(
                f"{path} is not a shell script ({first.strip()}), so claimcheck will not edit it. "
                f"Add this line to it yourself: {hook_line().strip()}"
            )
        lines = existing.splitlines(keepends=True)
        last = next((i for i in range(len(lines) - 1, -1, -1) if lines[i].strip()), None)
        line = hook_line()
        if last is not None and _TRAILING_EXIT.match(lines[last]):
            lines.insert(last, line)
            new = "".join(lines)
        else:
            sep = "" if not existing or existing.endswith("\n") else "\n"
            new = existing + sep + line
        path.write_bytes(new.encode("utf-8"))
    else:
        path.write_bytes(("#!/bin/sh\n" + hook_line()).encode("utf-8"))
    try:
        path.chmod(path.stat().st_mode | 0o111)
    except OSError as error:
        # Without the execute bit git skips the hook without a word, so claims would go unchecked.
        raise ClaimcheckError(f"wrote {path} but could not make it executable ({error}); run chmod +x on it") from error
    return True


def pre_commit(repo: Path, cfg: C.Config) -> int:
    """Return the exit code; messages go to stderr."""
    staged = gitio.staged_paths(repo)
    # Deletions count: removing code is a change a claim must cover too.
    code_paths = sorted({p for _status, p in staged if not C.is_ignored(p, cfg.ignore)})
    if not code_paths:
        return 0

    rel_claims = f"{C.CLAIMCHECK_DIR}/{C.CLAIMS_FILE}"
    staged_claims = next((s for s, p in staged if p == rel_claims), None)
    if staged_claims not in ("A", "M"):
        raise ClaimsError(
            f"staged code paths {code_paths} but {rel_claims} is not staged (added or modified)"
        )
    text = gitio.staged_file_content(repo, rel_claims) or ""

    lock_ids: set[int] | None
    try:
        lock_ids = S.lock_ids(S.read_lock(repo))
    except SpecError:
        # No lock: any cited criterion is a violation.
        lock_ids = None
    cf = CL.load_and_validate(text, lock_ids)

    staged_set = set(code_paths)
    problems: list[str] = []
    for c in cf.claims:
        extra = [f for f in c.files if f not in staged_set]
        if extra:
            problems.append(f"claim {c.id}: files not in the staged diff: {extra}")
    if problems:
        raise ClaimsError("\n  ".join(["claims do not match the staged diff:"] + problems))

    covered = {f for c in cf.claims for f in c.files}
    uncovered = [p for p in code_paths if p not in covered]
    if uncovered:
        msg = "staged paths with no claim covering them: " + ", ".join(uncovered)
        if cfg.require_full_coverage:
            raise ClaimsError(msg)
        print(f"claimcheck warning: {msg}", file=sys.stderr)
    return 0
