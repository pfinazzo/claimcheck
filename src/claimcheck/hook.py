"""Pre-commit hook: installer and the staged-diff rules.

@author Patrick Finazzo
"""

from __future__ import annotations

import sys
from pathlib import Path

from . import ClaimsError, SpecError
from . import claims as CL
from . import config as C
from . import gitio
from . import spec as S

HOOK_MARKER = "claimcheck"


def hook_line() -> str:
    exe = Path(sys.executable).as_posix()
    return f'"{exe}" -m claimcheck hook pre-commit || exit 1\n'


def hook_file(repo: Path) -> Path:
    git_dir = gitio.git(repo, "rev-parse", "--git-dir").strip()
    return (repo / git_dir).resolve() / "hooks" / "pre-commit"


def install(repo: Path) -> bool:
    """Install or append the hook line. Returns True when the file changed."""
    path = hook_file(repo)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        existing = path.read_bytes()
        if HOOK_MARKER.encode() in existing:
            return False
        sep = b"" if existing.endswith(b"\n") or not existing else b"\n"
        path.write_bytes(existing + sep + hook_line().encode("utf-8"))
    else:
        path.write_bytes(("#!/bin/sh\n" + hook_line()).encode("utf-8"))
    try:
        path.chmod(path.stat().st_mode | 0o111)
    except OSError:
        pass
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
        lock_ids = None  # no lock: any cited criterion is a violation
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
