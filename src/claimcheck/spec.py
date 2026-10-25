"""Frozen acceptance criteria: parse, freeze, verify, and the late-addition rules.

@author Patrick Finazzo
"""

from __future__ import annotations

import json
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import TypedDict

from . import ClaimcheckError, SpecError, config, gitio

CRITERION_RE = re.compile(r"^- \[[ xX]\] (\d+)\. (.+)$")


# One numbered criterion from spec.md. `sha256` is of its stripped text, as the lock records it.
Criterion = TypedDict("Criterion", {"id": int, "text": str, "sha256": str})


def make_criterion(*, id: int, text: str) -> Criterion:
    """A Criterion, with its hash worked out from the text."""
    return {"id": id, "text": text, "sha256": config.hash_text(text.strip())}


def parse_criteria(text: str) -> list[Criterion]:
    """The `- [ ] N. text` criteria in spec text. Raises SpecError when there are none."""
    found: list[Criterion] = []
    for line in text.splitlines():
        match = CRITERION_RE.match(line)
        if match:
            found.append(make_criterion(id=int(match.group(1)), text=match.group(2)))
    if not found:
        raise SpecError("spec has zero criteria (lines must match '- [ ] N. text')")
    ids = [char["id"] for char in found]
    dups = sorted({claim_id for claim_id in ids if ids.count(claim_id) > 1})
    if dups:
        raise SpecError(f"duplicate criterion ids: {dups}")
    expected = list(range(1, len(ids) + 1))
    if ids != expected:
        bad = sorted(set(ids) ^ set(expected))
        raise SpecError(f"criterion ids must be contiguous from 1; offending ids: {bad}")
    return found


def hash_spec(repo: Path) -> str:
    """sha256 of spec.md with the BOM removed and CRLF folded to LF, so Windows checkouts agree."""
    raw = resolve_spec_path(repo).read_bytes()
    if raw.startswith(b"\xef\xbb\xbf"):
        raw = raw[3:]
    return config.hash_bytes(raw.replace(b"\r\n", b"\n"))


def resolve_spec_path(repo: Path) -> Path:
    """Where spec.md lives in a repo."""
    return config.resolve_cc_dir(repo) / config.SPEC_FILE


def resolve_lock_path(repo: Path) -> Path:
    """Where spec.lock lives in a repo."""
    return config.resolve_cc_dir(repo) / config.LOCK_FILE


def read_spec(repo: Path) -> tuple[str, list[Criterion]]:
    """The spec's text and criteria. Raises SpecError, with what to run, when it is missing."""
    path = resolve_spec_path(repo)
    if not path.exists():
        raise SpecError(f"missing {config.CLAIMCHECK_DIR}/{config.SPEC_FILE}; run `claimcheck init`")
    text = path.read_text(encoding="utf-8-sig")
    return text, parse_criteria(text)


def read_lock(repo: Path) -> dict:
    """The parsed spec.lock. Raises SpecError, with what to run, when it is missing."""
    path = resolve_lock_path(repo)
    if not path.exists():
        raise SpecError(f"missing {config.CLAIMCHECK_DIR}/{config.LOCK_FILE}; run `claimcheck spec freeze`")
    return parse_lock(path.read_text(encoding="utf-8-sig"))


def parse_lock(text: str) -> dict:
    """Lock text to a dict. Raises SpecError when it is not JSON or misses a required key."""
    try:
        raw = json.loads(text)
    except json.JSONDecodeError as error:
        raise SpecError(f"invalid spec.lock: {error}") from error
    for key in ("version", "frozen_at", "git_head", "spec_sha256", "criteria"):
        if key not in raw:
            raise SpecError(f"invalid spec.lock: missing {key}")
    return raw


def list_lock_ids(lock: dict) -> set[int]:
    """The criterion ids a lock freezes."""
    return {int(criterion["id"]) for criterion in lock["criteria"]}


def build_lock(repo: Path, *, spec_text: str, criteria: list[Criterion]) -> dict:
    """The lock for the given spec text and criteria, stamped with the time and HEAD."""
    return {
        "version": 1,
        "frozen_at": config.format_utc_now(),
        "git_head": gitio.read_head_sha(repo),
        "spec_sha256": hash_spec(repo),
        "criteria": [{"id": criterion["id"], "sha256": criterion["sha256"]} for criterion in criteria],
    }


def open_code_paths(repo: Path, *, settings: config.Config, base: str) -> list[str]:
    """Product-code paths changed against `base`, committed or not. Spec and docs edits do not count.

    A diff is "open" once code exists. Before that, writing or rewriting the spec is the normal job.
    """
    try:
        names = gitio.list_changed_files(repo, base=base, worktree=True)
    except ClaimcheckError:
        # No commits yet, or no base: nothing can be open.
        names = []
    return [name for name in names if not config.is_ignored(name, globs=settings["ignore"])]


def freeze(repo: Path, *, settings: config.Config) -> dict:
    """Write spec.lock. With an existing lock, refuse unless the tree is clean and at base."""
    spec_text, criteria = read_spec(repo)
    if resolve_lock_path(repo).exists():
        open_paths = open_code_paths(repo, settings=settings, base=settings["base"])
        if open_paths:
            shown = ", ".join(open_paths[:3]) + ("..." if len(open_paths) > 3 else "")
            raise SpecError(
                f"refusing to re-freeze with an open diff: code already changed ({shown}). "
                "Start the next task on a fresh branch from the base."
            )
    lock = build_lock(repo, spec_text=spec_text, criteria=criteria)
    resolve_lock_path(repo).write_text(json.dumps(lock, indent=2, sort_keys=True) + "\n", encoding="utf-8", newline="\n")
    return lock


def check_against_lock(criteria: list[Criterion], *, lock: dict) -> dict[str, list[int]]:
    """Criterion ids added, changed or removed since the lock: {kind: [ids]}."""
    locked = {int(criterion["id"]): criterion["sha256"] for criterion in lock["criteria"]}
    current = {criterion["id"]: criterion["sha256"] for criterion in criteria}
    return {
        "late addition": sorted(criterion_id for criterion_id in current if criterion_id not in locked),
        "modified": sorted(index for index in current if index in locked and current[index] != locked[index]),
        "removed": sorted(criterion_id for criterion_id in locked if criterion_id not in current),
    }


def validate_spec(repo: Path) -> list[Criterion]:
    """Exit 0 (return criteria) when spec matches lock; raise SpecError(3) otherwise."""
    spec_text, criteria = read_spec(repo)
    lock = read_lock(repo)
    problems = check_against_lock(criteria, lock=lock)
    lines = [f"{kind}: {ids}" for kind, ids in problems.items() if ids]
    if hash_spec(repo) != lock["spec_sha256"] and not lines:
        lines.append("modified: spec file bytes differ from lock (non-criterion text changed)")
    if lines:
        raise SpecError("spec drifted from lock:\n  " + "\n  ".join(lines))
    return criteria


def check_open_diff_rules(repo: Path, *, settings: config.Config, base: str | None = None) -> None:
    """AC 7 (committed diff) and AC 8 (uncommitted diff) refusals.

    `base` is the ref the diff under test is measured against (the CLI's --base
    when given, else the config's base).
    """
    base = base or settings["base"]
    rel_lock = f"{config.CLAIMCHECK_DIR}/{config.LOCK_FILE}"
    rel_spec = f"{config.CLAIMCHECK_DIR}/{config.SPEC_FILE}"

    # AC 8 — any dirty tree: spec and lock must themselves be clean.
    if gitio.is_dirty(repo):
        dirty = [rel_path for rel_path in (rel_lock, rel_spec) if gitio.is_path_dirty(repo, path=rel_path)]
        if dirty:
            raise SpecError(
                "refusing: uncommitted change to " + ", ".join(dirty) + " while a diff is open"
            )

    # AC 7 — committed diff: lock re-frozen inside base..HEAD after the diff began.
    if gitio.count_commits_ahead(repo, base=base) > 0 and gitio.is_path_changed_in_range(repo, base=base, path=rel_lock):
        _reject_late_refreeze(repo, base=base, rel_lock=rel_lock)


def _read_criteria_hashes_at(repo: Path, *, ref: str, rel_lock: str) -> set[str]:
    """The criterion hashes in the lock as committed at `ref`; none if it was absent or unreadable."""
    old_text = gitio.show_file_at(repo, ref=ref, path=rel_lock)
    if not old_text:
        return set()
    try:
        return {criterion["sha256"] for criterion in parse_lock(old_text)["criteria"]}
    except SpecError:
        # An unreadable old lock means every current criterion counts as late.
        return set()


def _reject_late_refreeze(repo: Path, *, base: str, rel_lock: str) -> None:
    """AC 7: refuse when the lock was re-frozen after the diff's first commit, naming the late criteria."""
    lock = read_lock(repo)
    frozen_at = datetime.fromisoformat(lock["frozen_at"].replace("Z", "+00:00"))
    first = gitio.find_earliest_author_date(repo, base=base)
    if first is None or frozen_at <= first.astimezone(UTC):
        return
    old_hashes = _read_criteria_hashes_at(repo, ref=gitio.merge_base(repo, base=base), rel_lock=rel_lock)
    new_ids = sorted(int(criterion["id"]) for criterion in lock["criteria"] if criterion["sha256"] not in old_hashes)
    raise SpecError(
        f"refusing: spec.lock was re-frozen at {lock['frozen_at']} after the diff's first "
        f"commit ({first.isoformat()}); late criteria: {new_ids}"
    )
