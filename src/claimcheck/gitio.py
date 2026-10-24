"""Thin subprocess wrappers around git. Never stash, reset, or checkout.

@author Patrick Finazzo
"""

from __future__ import annotations

import subprocess
from datetime import datetime
from pathlib import Path

from . import ClaimcheckError


def git(repo: Path, *args: str, check: bool = True) -> str:
    proc = subprocess.run(
        ["git", *args], cwd=repo, capture_output=True, text=True, encoding="utf-8", errors="replace"
    )
    if check and proc.returncode != 0:
        raise ClaimcheckError(f"git {' '.join(args)} failed: {proc.stderr.strip()}")
    return proc.stdout


def head_sha(repo: Path) -> str:
    return git(repo, "rev-parse", "HEAD").strip()


def rev_parse(repo: Path, ref: str) -> str:
    return git(repo, "rev-parse", "--verify", f"{ref}^{{commit}}").strip()


def staged_paths(repo: Path) -> list[tuple[str, str]]:
    """[(status, path)] for the index vs HEAD. Status is A/M/D/R/C... (first letter).

    A rename or copy yields two entries: the old path as D (rename) or unchanged
    (copy) and the new path as the given status, so both sides need a claim.
    """
    out = git(repo, "diff", "--cached", "--name-status", "-M", check=False)
    result: list[tuple[str, str]] = []
    for line in out.splitlines():
        if not line.strip():
            continue
        parts = line.split("\t")
        status = parts[0][0]
        if status in ("R", "C") and len(parts) >= 3:
            if status == "R":
                result.append(("D", parts[1].replace("\\", "/")))
            result.append((status, parts[2].replace("\\", "/")))
            continue
        result.append((status, parts[-1].replace("\\", "/")))
    return result


def is_dirty(repo: Path, paths: list[str] | None = None) -> bool:
    """True when any staged or unstaged change exists (optionally limited to `paths`)."""
    args = ["status", "--porcelain", "--untracked-files=no"]
    if paths:
        args += ["--", *paths]
    return bool(git(repo, *args).strip())


def path_dirty(repo: Path, path: str) -> bool:
    return is_dirty(repo, [path])


def commits_ahead(repo: Path, base: str) -> int:
    out = git(repo, "rev-list", "--count", f"{base}..HEAD").strip()
    return int(out or 0)


def diff_text(repo: Path, base: str, worktree: bool) -> str:
    if worktree:
        return git(repo, "diff", base, "--")
    return git(repo, "diff", f"{base}...HEAD", "--")


def changed_files(repo: Path, base: str, worktree: bool) -> list[str]:
    if worktree:
        out = git(repo, "diff", "--name-only", base, "--")
    else:
        out = git(repo, "diff", "--name-only", f"{base}...HEAD", "--")
    return [l.strip().replace("\\", "/") for l in out.splitlines() if l.strip()]


def path_changed_in_range(repo: Path, base: str, path: str) -> bool:
    out = git(repo, "diff", "--name-only", f"{base}...HEAD", "--", path)
    return bool(out.strip())


def earliest_author_date(repo: Path, base: str) -> datetime | None:
    out = git(repo, "log", "--format=%aI", "--reverse", f"{base}..HEAD").strip()
    if not out:
        return None
    first = out.splitlines()[0].strip()
    return datetime.fromisoformat(first)


def merge_base(repo: Path, base: str) -> str:
    return git(repo, "merge-base", base, "HEAD").strip()


def show_file_at(repo: Path, ref: str, path: str) -> str | None:
    proc = subprocess.run(
        ["git", "show", f"{ref}:{path}"], cwd=repo, capture_output=True, text=True, encoding="utf-8"
    )
    return proc.stdout if proc.returncode == 0 else None


def staged_file_content(repo: Path, path: str) -> str | None:
    return show_file_at(repo, "", path)
