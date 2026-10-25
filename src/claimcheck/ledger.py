"""Append-only JSONL ledger: line formats, validation, atomic append.

@author Patrick Finazzo
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from pathlib import Path

from . import ClaimcheckError, LedgerError
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
        raise ClaimcheckError(f"ledger line is not JSON: {e}") from e
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
    head = chain_head(ledger_lines(path.read_bytes() if path.exists() else b""))
    texts = []
    for r in records:
        text = json.dumps({**r, "prev": head}, sort_keys=True, ensure_ascii=False)
        texts.append(text)
        head = line_hash(text)
    payload = "".join(t + "\n" for t in texts)
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


# ---- the hash chain ----------------------------------------------------------
#
# Every line claimcheck writes carries `prev`: the SHA-256 of the previous line's text
# (no line break). The first chained line carries the hash of ALL lines before it joined
# by newlines, so older lines written before chaining existed are sealed too, and a ledger
# that starts empty uses 64 zeros. Editing, removing or moving any line breaks the next
# line's `prev`. A chain alone cannot see the LAST line being cut off; `verify` closes that
# by checking the ledger as committed at a base ref is an unchanged beginning of this one.

ZERO_HASH = "0" * 64


def line_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def ledger_lines(data: bytes) -> list[str]:
    """Non-blank lines as text. A Windows checkout may end lines in CRLF, so strip the CR."""
    return [line_text.rstrip("\r") for line_text in data.decode("utf-8").split("\n") if line_text.strip()]


def _has_prev(text: str) -> bool:
    try:
        obj = json.loads(text)
    except json.JSONDecodeError:
        return False
    return isinstance(obj, dict) and obj.get("prev") is not None


def chain_head(lines: list[str]) -> str:
    """The `prev` value the next line written must carry."""
    if not lines:
        return ZERO_HASH
    if _has_prev(lines[-1]):
        return line_hash(lines[-1])
    return line_hash("\n".join(lines))


def verify_chain(lines: list[str]) -> dict:
    """Walk the whole ledger. Raises LedgerError naming the first line that does not fit."""
    legacy = chained = 0
    for n, text in enumerate(lines, 1):
        try:
            obj = json.loads(text)
        except json.JSONDecodeError:
            raise LedgerError(f"ledger line {n} is not valid JSON") from None
        if not isinstance(obj, dict):
            raise LedgerError(f"ledger line {n} is not an object")
        prev = obj.get("prev")
        if prev is None:
            if chained:
                raise LedgerError(
                    f"ledger line {n} has no prev hash but follows chained lines: "
                    "it was inserted, or the chain was stripped from it"
                )
            legacy += 1
            continue
        if chained:
            want = line_hash(lines[n - 2])
        else:
            want = line_hash("\n".join(lines[: n - 1])) if n > 1 else ZERO_HASH
        if prev != want:
            raise LedgerError(
                f"ledger line {n}: its prev hash does not match the lines before it, so a line "
                f"at or before line {n - 1} was removed, edited or moved"
            )
        chained += 1
    return {"lines": len(lines), "legacy": legacy, "chained": chained}


def verify_grew_only(lines: list[str], base_lines: list[str], ref: str) -> None:
    """The ledger at `ref` must still be an unchanged beginning of the current ledger."""
    if len(lines) < len(base_lines):
        gone = len(base_lines) - len(lines)
        raise LedgerError(f"{gone} line(s) from the end of the ledger at {ref} are gone")
    for i, text in enumerate(base_lines):
        if lines[i] != text:
            raise LedgerError(f"ledger line {i + 1} differs from the ledger at {ref}")
