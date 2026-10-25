"""Frozen acceptance criteria: parse, freeze, verify, and the late-addition rules.

@author Patrick Finazzo
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from . import ClaimcheckError, SpecError, gitio
from . import config as C

CRITERION_RE = re.compile(r"^- \[[ xX]\] (\d+)\. (.+)$")


@dataclass(frozen=True)
class Criterion:
    id: int
    text: str

    @property
    def sha256(self) -> str:
        return C.sha256_text(self.text.strip())


def parse_criteria(text: str) -> list[Criterion]:
    found: list[Criterion] = []
    for line in text.splitlines():
        m = CRITERION_RE.match(line)
        if m:
            found.append(Criterion(int(m.group(1)), m.group(2)))
    if not found:
        raise SpecError("spec has zero criteria (lines must match '- [ ] N. text')")
    ids = [c.id for c in found]
    dups = sorted({i for i in ids if ids.count(i) > 1})
    if dups:
        raise SpecError(f"duplicate criterion ids: {dups}")
    expected = list(range(1, len(ids) + 1))
    if ids != expected:
        bad = sorted(set(ids) ^ set(expected))
        raise SpecError(f"criterion ids must be contiguous from 1; offending ids: {bad}")
    return found


def spec_digest(repo: Path) -> str:
    """sha256 of spec.md with the BOM removed and CRLF folded to LF, so Windows checkouts agree."""
    raw = spec_path(repo).read_bytes()
    if raw.startswith(b"\xef\xbb\xbf"):
        raw = raw[3:]
    return C.sha256_bytes(raw.replace(b"\r\n", b"\n"))


def spec_path(repo: Path) -> Path:
    return C.cc_dir(repo) / C.SPEC_FILE


def lock_path(repo: Path) -> Path:
    return C.cc_dir(repo) / C.LOCK_FILE


def read_spec(repo: Path) -> tuple[str, list[Criterion]]:
    p = spec_path(repo)
    if not p.exists():
        raise SpecError(f"missing {C.CLAIMCHECK_DIR}/{C.SPEC_FILE}; run `claimcheck init`")
    text = p.read_text(encoding="utf-8-sig")
    return text, parse_criteria(text)


def read_lock(repo: Path) -> dict:
    p = lock_path(repo)
    if not p.exists():
        raise SpecError(f"missing {C.CLAIMCHECK_DIR}/{C.LOCK_FILE}; run `claimcheck spec freeze`")
    return parse_lock(p.read_text(encoding="utf-8-sig"))


def parse_lock(text: str) -> dict:
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        raise SpecError(f"invalid spec.lock: {e}") from e
    for key in ("version", "frozen_at", "git_head", "spec_sha256", "criteria"):
        if key not in data:
            raise SpecError(f"invalid spec.lock: missing {key}")
    return data


def lock_ids(lock: dict) -> set[int]:
    return {int(c["id"]) for c in lock["criteria"]}


def build_lock(repo: Path, spec_text: str, criteria: list[Criterion]) -> dict:
    return {
        "version": 1,
        "frozen_at": C.utc_now_iso(),
        "git_head": gitio.head_sha(repo),
        "spec_sha256": spec_digest(repo),
        "criteria": [{"id": c.id, "sha256": c.sha256} for c in criteria],
    }


def open_code_paths(repo: Path, cfg: C.Config, base: str) -> list[str]:
    """Product-code paths changed against `base`, committed or not. Spec and docs edits do not count.

    A diff is "open" once code exists. Before that, writing or rewriting the spec is the normal job.
    """
    try:
        names = gitio.changed_files(repo, base, worktree=True)
    except ClaimcheckError:
        names = []  # no commits yet, or no base: nothing can be open
    return [n for n in names if not C.is_ignored(n, cfg.ignore)]


def freeze(repo: Path, cfg: C.Config) -> dict:
    """Write spec.lock. With an existing lock, refuse unless the tree is clean and at base."""
    spec_text, criteria = read_spec(repo)
    if lock_path(repo).exists():
        open_paths = open_code_paths(repo, cfg, cfg.base)
        if open_paths:
            shown = ", ".join(open_paths[:3]) + ("..." if len(open_paths) > 3 else "")
            raise SpecError(
                f"refusing to re-freeze with an open diff: code already changed ({shown}). "
                "Start the next task on a fresh branch from the base."
            )
    lock = build_lock(repo, spec_text, criteria)
    lock_path(repo).write_text(json.dumps(lock, indent=2, sort_keys=True) + "\n", encoding="utf-8", newline="\n")
    return lock


def diff_against_lock(criteria: list[Criterion], lock: dict) -> dict[str, list[int]]:
    locked = {int(c["id"]): c["sha256"] for c in lock["criteria"]}
    current = {c.id: c.sha256 for c in criteria}
    return {
        "late addition": sorted(i for i in current if i not in locked),
        "modified": sorted(i for i in current if i in locked and current[i] != locked[i]),
        "removed": sorted(i for i in locked if i not in current),
    }


def verify(repo: Path) -> list[Criterion]:
    """Exit 0 (return criteria) when spec matches lock; raise SpecError(3) otherwise."""
    spec_text, criteria = read_spec(repo)
    lock = read_lock(repo)
    problems = diff_against_lock(criteria, lock)
    lines = [f"{kind}: {ids}" for kind, ids in problems.items() if ids]
    if spec_digest(repo) != lock["spec_sha256"] and not lines:
        lines.append("modified: spec file bytes differ from lock (non-criterion text changed)")
    if lines:
        raise SpecError("spec drifted from lock:\n  " + "\n  ".join(lines))
    return criteria


def enforce_open_diff_rules(repo: Path, cfg: C.Config, base: str | None = None) -> None:
    """AC 7 (committed diff) and AC 8 (uncommitted diff) refusals.

    `base` is the ref the diff under test is measured against (the CLI's --base
    when given, else the config's base).
    """
    base = base or cfg.base
    rel_lock = f"{C.CLAIMCHECK_DIR}/{C.LOCK_FILE}"
    rel_spec = f"{C.CLAIMCHECK_DIR}/{C.SPEC_FILE}"

    # AC 8 — any dirty tree: spec and lock must themselves be clean.
    if gitio.is_dirty(repo):
        dirty = [p for p in (rel_lock, rel_spec) if gitio.path_dirty(repo, p)]
        if dirty:
            raise SpecError(
                "refusing: uncommitted change to " + ", ".join(dirty) + " while a diff is open"
            )

    # AC 7 — committed diff: lock re-frozen inside base..HEAD after the diff began.
    if gitio.commits_ahead(repo, base) > 0 and gitio.path_changed_in_range(repo, base, rel_lock):
        lock = read_lock(repo)
        frozen_at = datetime.fromisoformat(lock["frozen_at"].replace("Z", "+00:00"))
        first = gitio.earliest_author_date(repo, base)
        if first is not None and frozen_at > first.astimezone(UTC):
            base_sha = gitio.merge_base(repo, base)
            old_text = gitio.show_file_at(repo, base_sha, rel_lock)
            old_hashes = set()
            if old_text:
                try:
                    old_hashes = {c["sha256"] for c in parse_lock(old_text)["criteria"]}
                except SpecError:
                    old_hashes = set()
            new_ids = sorted(int(c["id"]) for c in lock["criteria"] if c["sha256"] not in old_hashes)
            raise SpecError(
                f"refusing: spec.lock was re-frozen at {lock['frozen_at']} after the diff's first "
                f"commit ({first.isoformat()}); late criteria: {new_ids}"
            )
