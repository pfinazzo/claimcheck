"""Thin subprocess wrappers around git. Never stash, reset, or check out files (creating a new branch is allowed).

@author Patrick Finazzo
"""

from __future__ import annotations

import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any

from . import ClaimcheckError, EmptyDiffError

# Fixed settings for every call, so a person's git config cannot change what we parse:
# real UTF-8 paths (not "caf\303\251"), plain a/ b/ diff prefixes, no color codes.
_FIXED = ["-c", "core.quotepath=off", "-c", "diff.noprefix=false", "-c", "diff.mnemonicPrefix=false", "-c", "color.ui=never"]

# git answers local commands in well under a second. A credential prompt or a stalled network
# drive can make it wait forever, which would freeze the CLI with no message.
GIT_TIMEOUT_S = 120


def _run_git(repo: Path, argv: list[str], **options: Any) -> subprocess.CompletedProcess:
    """Run one git command with the timeout. A timeout becomes a ClaimcheckError that names the command."""
    try:
        return subprocess.run(argv, cwd=repo, capture_output=True, timeout=GIT_TIMEOUT_S, **options)
    except subprocess.TimeoutExpired as error:
        raise ClaimcheckError(f"{' '.join(argv)} did not finish within {GIT_TIMEOUT_S} seconds and was stopped") from error


def git(repo: Path, *args: str, check: bool = True) -> str:
    """Run git in `repo` and return stdout. Raises ClaimcheckError on failure unless `check` is off."""
    proc = _run_git(repo, ["git", *_FIXED, *args], text=True, encoding="utf-8", errors="replace")
    if check and proc.returncode != 0:
        raise ClaimcheckError(f"git {' '.join(args)} failed: {proc.stderr.strip()}")
    return proc.stdout


def head_sha(repo: Path) -> str:
    """The sha HEAD points at."""
    return git(repo, "rev-parse", "HEAD").strip()


def rev_parse(repo: Path, ref: str) -> str:
    """The commit sha `ref` names. Raises ClaimcheckError with how to fix it when the ref is missing."""
    out = git(repo, "rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}", check=False).strip()
    if not out:
        raise ClaimcheckError(
            f"base ref {ref!r} was not found. Fetch it (git fetch origin {ref}), "
            "check the name in .claimcheck/config.toml, or pass --base."
        )
    return out


def staged_paths(repo: Path) -> list[tuple[str, str]]:
    """[(status, path)] for the index vs HEAD. Status is A/M/D/R/C... (first letter).

    A rename or copy yields two entries: the old path as D (rename) or unchanged
    (copy) and the new path as the given status, so both sides need a claim.
    """
    out = git(repo, "diff", "--cached", "--name-status", "-M", check=False)
    return [entry for line in out.splitlines() if line.strip() for entry in _name_status_entries(line)]


def _name_status_entries(line: str) -> list[tuple[str, str]]:
    """One `--name-status` line as (status, path) pairs: a rename also yields its old path as D."""
    parts = line.split("\t")
    status = parts[0][0]
    if status not in ("R", "C") or len(parts) < 3:
        return [(status, parts[-1].replace("\\", "/"))]
    new_side = (status, parts[2].replace("\\", "/"))
    return [("D", parts[1].replace("\\", "/")), new_side] if status == "R" else [new_side]


def is_dirty(repo: Path, paths: list[str] | None = None) -> bool:
    """True when any staged or unstaged change exists (optionally limited to `paths`)."""
    args = ["status", "--porcelain", "--untracked-files=no"]
    if paths:
        args += ["--", *paths]
    return bool(git(repo, *args).strip())


def path_dirty(repo: Path, path: str) -> bool:
    """Whether one path has a staged or unstaged change."""
    return is_dirty(repo, [path])


def commits_ahead(repo: Path, base: str) -> int:
    # A missing base is a clear error, not a raw git one.
    """How many commits HEAD has that `base` does not."""
    rev_parse(repo, base)
    out = git(repo, "rev-list", "--count", f"{base}..HEAD").strip()
    return int(out or 0)


# The checker is blind to the author's confidence and evidence. claims.yaml (and the ledger)
# carry exactly those, and the hook makes the claims file part of every commit, so the
# claimcheck folder must never reach the checker through the diff.
_EXCLUDE_CLAIMCHECK = (".", ":(exclude).claimcheck")


_DIFF_FLAGS = ("--no-ext-diff", "--no-textconv")


def untracked_files(repo: Path) -> list[str]:
    """New files git does not track yet, as repo-relative POSIX paths (never inside .claimcheck)."""
    out = git(repo, "ls-files", "--others", "--exclude-standard", "-z", check=False)
    names = [n.replace("\\", "/") for n in out.split("\0") if n]
    return [n for n in names if not n.startswith(".claimcheck/")]


def diff_text(repo: Path, base: str, worktree: bool) -> str:
    """The change under test. In worktree mode this includes files git has not tracked yet."""
    if not worktree:
        return git(repo, "diff", *_DIFF_FLAGS, f"{base}...HEAD", "--", *_EXCLUDE_CLAIMCHECK)
    text = git(repo, "diff", *_DIFF_FLAGS, base, "--", *_EXCLUDE_CLAIMCHECK)
    for name in untracked_files(repo):
        # --no-index exits 1 when the files differ, which is the point here.
        text += git(repo, "diff", *_DIFF_FLAGS, "--no-index", "--", "/dev/null", name, check=False)
    return text


def require_diff(repo: Path, base: str, worktree: bool) -> str:
    """The diff under test, or a refusal when it is empty so no run is recorded for nothing."""
    text = diff_text(repo, base, worktree)
    if text.strip():
        return text
    if worktree:
        raise EmptyDiffError(
            f"the diff is empty: the working tree has no changes against '{base}'. Make a change first. "
            "--worktree only looks at uncommitted work, so if you already committed it, "
            "drop --worktree and run again."
        )
    raise EmptyDiffError(
        f"the diff is empty: nothing in HEAD differs from '{base}'. "
        "Commit the change first, or pass --worktree to check uncommitted work."
    )


def changed_files(repo: Path, base: str, worktree: bool) -> list[str]:
    """Files the diff under test touches: base...HEAD, or with `worktree` the working tree plus untracked files."""
    if worktree:
        out = git(repo, "diff", "--name-only", base, "--")
        extra = untracked_files(repo)
    else:
        out = git(repo, "diff", "--name-only", f"{base}...HEAD", "--")
        extra = []
    names = [line_text.strip().replace("\\", "/") for line_text in out.splitlines() if line_text.strip()]
    return names + [n for n in extra if n not in names]


def path_changed_in_range(repo: Path, base: str, path: str) -> bool:
    """Whether `path` changed between `base` and HEAD."""
    out = git(repo, "diff", "--name-only", f"{base}...HEAD", "--", path)
    return bool(out.strip())


def earliest_author_date(repo: Path, base: str) -> datetime | None:
    """The author date of the first commit after `base`, or None when HEAD has none."""
    out = git(repo, "log", "--format=%aI", "--reverse", f"{base}..HEAD").strip()
    if not out:
        return None
    first = out.splitlines()[0].strip()
    return datetime.fromisoformat(first)


def merge_base(repo: Path, base: str) -> str:
    """The commit where HEAD's history meets `base`."""
    return git(repo, "merge-base", base, "HEAD").strip()


def show_file_at(repo: Path, ref: str, path: str) -> str | None:
    """The file's text as committed at `ref`, or None when it did not exist there."""
    proc = _run_git(repo, ["git", "show", f"{ref}:{path}"], text=True, encoding="utf-8")
    return proc.stdout if proc.returncode == 0 else None


def staged_file_content(repo: Path, path: str) -> str | None:
    """The file as staged in the index, or None when it is not staged."""
    return show_file_at(repo, "", path)


def current_branch(repo: Path) -> str:
    """The checked-out branch name, "HEAD" when detached, "" when the repo has no commits yet."""
    return git(repo, "rev-parse", "--abbrev-ref", "HEAD", check=False).strip()


def branch_exists(repo: Path, name: str) -> bool:
    """Whether a local branch of that name exists."""
    return bool(git(repo, "rev-parse", "--verify", "--quiet", f"refs/heads/{name}", check=False).strip())


def switch_new_branch(repo: Path, name: str) -> None:
    """`git switch -c`: makes a branch at HEAD and moves to it. Uncommitted work comes along
    untouched, which is why this is the one branch-moving command claimcheck allows itself."""
    git(repo, "switch", "-c", name)


def stage(repo: Path, *paths: str) -> None:
    """git add the paths."""
    git(repo, "add", "--", *paths)


def commit(repo: Path, message: str) -> str:
    """Commit what is staged (the pre-commit hook runs) and return the new commit sha."""
    git(repo, "commit", "-q", "-m", message)
    return head_sha(repo)


def is_ignored(repo: Path, path: str) -> bool:
    """True when git would ignore `path` (any .gitignore, the repo's exclude file, or a global one)."""
    proc = _run_git(repo, ["git", *_FIXED, "check-ignore", "-q", "--no-index", "--", path])
    return proc.returncode == 0


def tracked_files(repo: Path) -> list[str]:
    """Every file git tracks, with forward slashes."""
    out = git(repo, "ls-files", "-z", check=False)
    return [n.replace("\\", "/") for n in out.split("\0") if n]
