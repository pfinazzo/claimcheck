"""Append-only JSONL ledger: line formats, validation, atomic append.

@author Patrick Finazzo
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

from . import ClaimcheckError
from . import config as C

CLAIM_KEYS = frozenset(
    {
        "v", "type", "ts", "run_id", "repo", "base", "head", "spec_lock", "author",
        "claim_id", "claim", "confidence", "criteria", "files", "kill_condition",
        "checker", "mutation", "outcome", "outcome_source", "outcome_ts",
    }
)
OUTCOME_KEYS = frozenset({"v", "type", "ts", "run_id", "claim_id", "outcome", "outcome_source"})
TYPES = ("claim", "outcome")


def ledger_path(repo: Path) -> Path:
    return C.cc_dir(repo) / C.LEDGER_FILE


def validate_line(s: str) -> dict:
    """Return the parsed object or raise ClaimcheckError naming the problem."""
    try:
        obj = json.loads(s)
    except json.JSONDecodeError as e:
        raise ClaimcheckError(f"ledger line is not JSON: {e}")
    if not isinstance(obj, dict):
        raise ClaimcheckError("ledger line must be an object")
    t = obj.get("type")
    if t not in TYPES:
        raise ClaimcheckError(f"ledger line type must be one of {TYPES} (got {t!r})")
    required = CLAIM_KEYS if t == "claim" else OUTCOME_KEYS
    missing = sorted(required - obj.keys())
    if missing:
        raise ClaimcheckError(f"ledger {t} line missing keys: {missing}")
    return obj


def claim_record(
    *,
    ts: str,
    run_id: str,
    repo_id: str,
    base: str,
    head: str,
    spec_lock: str,
    author: str,
    claim_id: str,
    claim: str,
    confidence: float,
    criteria: list[int],
    files: list[str],
    kill_condition: str,
    checker: dict,
    mutation: dict,
) -> dict:
    return {
        "v": 1,
        "type": "claim",
        "ts": ts,
        "run_id": run_id,
        "repo": repo_id,
        "base": base,
        "head": head,
        "spec_lock": spec_lock,
        "author": author,
        "claim_id": claim_id,
        "claim": claim,
        "confidence": float(confidence),
        "criteria": list(criteria),
        "files": list(files),
        "kill_condition": kill_condition,
        "checker": checker,
        "mutation": mutation,
        "outcome": None,
        "outcome_source": None,
        "outcome_ts": None,
    }


def append_atomic(repo: Path, records: list[dict]) -> int:
    """Write all lines to a temp file first, then append that file's bytes in one write."""
    for r in records:
        validate_line(json.dumps(r))
    path = ledger_path(repo)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = "".join(json.dumps(r, sort_keys=True, ensure_ascii=False) + "\n" for r in records)
    fd, tmp = tempfile.mkstemp(prefix=".ledger-", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            f.write(payload)
            f.flush()
            os.fsync(f.fileno())
        data = Path(tmp).read_bytes()
        if path.exists() and path.stat().st_size > 0:
            with open(path, "rb") as existing:
                existing.seek(-1, os.SEEK_END)
                if existing.read(1) != b"\n":
                    data = b"\n" + data  # a crash or an editor left the last line open: never fuse onto it
        with open(path, "ab") as out:
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass
    return len(records)
