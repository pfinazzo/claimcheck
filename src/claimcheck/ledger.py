"""Append-only JSONL ledger: line formats, validation, atomic append.

@author Patrick Finazzo
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from pathlib import Path
from typing import Any

from . import ClaimcheckError, LedgerError, config

CLAIM_KEYS = frozenset(
    {
        "v", "type", "ts", "run_id", "repo", "base", "head", "spec_lock", "author",
        "claim_id", "claim", "confidence", "criteria", "files", "kill_condition",
        "checker", "mutation", "outcome", "outcome_source", "outcome_ts",
    }
)
OUTCOME_KEYS = frozenset({"v", "type", "ts", "run_id", "claim_id", "outcome", "outcome_source"})
ACCEPT_KEYS = frozenset({"v", "type", "ts", "claim_id", "claim_hash", "files_hash", "note", "accepted_by"})
TYPES = ("claim", "outcome", "accept")
_REQUIRED_KEYS = {"claim": CLAIM_KEYS, "outcome": OUTCOME_KEYS, "accept": ACCEPT_KEYS}


def resolve_ledger_path(repo: Path) -> Path:
    """Where the ledger lives in a repo."""
    return config.resolve_cc_dir(repo) / config.LEDGER_FILE


def validate_line(line: str) -> dict:
    """Return the parsed object or raise ClaimcheckError naming the problem."""
    try:
        parsed = json.loads(line)
    except json.JSONDecodeError as error:
        raise ClaimcheckError(f"ledger line is not JSON: {error}") from error
    if not isinstance(parsed, dict):
        raise ClaimcheckError("ledger line must be an object")
    term = parsed.get("type")
    if term not in TYPES:
        raise ClaimcheckError(f"ledger line type must be one of {TYPES} (got {term!r})")
    required = _REQUIRED_KEYS[term]
    missing = sorted(required - parsed.keys())
    if missing:
        raise ClaimcheckError(f"ledger {term} line missing keys: {missing}")
    return parsed


def build_claim_record(
    *,
    timestamp: str,
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
    accepted: str | None = None,
) -> dict:
    """One ledger line for a claim's verdict and catch rate in a run.

    `accepted` is the hash of the acceptance line that let an UNVERIFIABLE verdict pass, else None.
    """
    return {
        "v": 1,
        "type": "claim",
        "ts": timestamp,
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
        "accepted": accepted,
        "outcome": None,
        "outcome_source": None,
        "outcome_ts": None,
    }


def build_accept_record(*, timestamp: str, claim_id: str, claim_hash: str, files_hash: str, note: str, accepted_by: str) -> dict:
    """One ledger line saying a person accepted a claim the checker could not settle.

    The two hashes tie the acceptance to the claim and its files exactly as they were, so any later
    edit to either one voids it.
    """
    return {
        "v": 1,
        "type": "accept",
        "ts": timestamp,
        "claim_id": claim_id,
        "claim_hash": claim_hash,
        "files_hash": files_hash,
        "note": note,
        "accepted_by": accepted_by,
    }


def append_atomic(repo: Path, *, records: list[dict]) -> int:
    """Write all lines to a temp file first, then append that file's bytes in one write."""
    for record in records:
        validate_line(json.dumps(record))
    path = resolve_ledger_path(repo)
    path.parent.mkdir(parents=True, exist_ok=True)
    head = find_chain_head(split_ledger_lines(path.read_bytes() if path.exists() else b""))
    texts = []
    for record in records:
        text = json.dumps({**record, "prev": head}, sort_keys=True, ensure_ascii=False)
        texts.append(text)
        head = hash_line(text)
    payload = "".join(message + "\n" for message in texts)
    handle_fd, temp_path = tempfile.mkstemp(prefix=".ledger-", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(handle_fd, "w", encoding="utf-8", newline="\n") as file_path:
            file_path.write(payload)
            file_path.flush()
            os.fsync(file_path.fileno())
        raw = Path(temp_path).read_bytes()
        if _is_left_open(path):
            # A crash or an editor left the last line open: never fuse onto it.
            raw = b"\n" + raw
        with open(path, "ab") as ledger_file:
            ledger_file.write(raw)
            ledger_file.flush()
            os.fsync(ledger_file.fileno())
    finally:
        Path(temp_path).unlink(missing_ok=True)
    return len(records)


def _is_left_open(path: Path) -> bool:
    """Whether the file has content whose last line has no line break yet."""
    if not path.exists() or path.stat().st_size == 0:
        return False
    with open(path, "rb") as existing:
        existing.seek(-1, os.SEEK_END)
        return existing.read(1) != b"\n"


# ---- the hash chain ----------------------------------------------------------
#
# Every line claimcheck writes carries `prev`: the SHA-256 of the previous line's text
# (no line break). The first chained line carries the hash of ALL lines before it joined
# by newlines, so older lines written before chaining existed are sealed too, and a ledger
# that starts empty uses 64 zeros. Editing, removing or moving any line breaks the next
# line's `prev`. A chain alone cannot see the LAST line being cut off; `verify` closes that
# by checking the ledger as committed at a base ref is an unchanged beginning of this one.

ZERO_HASH = "0" * 64


def hash_line(text: str) -> str:
    """Hex SHA-256 of one ledger line's text, as the next line's `prev` carries it."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def split_ledger_lines(data: bytes) -> list[str]:
    """Non-blank lines as text. A Windows checkout may end lines in CRLF, so strip the CR."""
    return [line_text.rstrip("\r") for line_text in data.decode("utf-8").split("\n") if line_text.strip()]


def _has_prev(text: str) -> bool:
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return False
    return isinstance(parsed, dict) and parsed.get("prev") is not None


def find_chain_head(lines: list[str]) -> str:
    """The `prev` value the next line written must carry."""
    if not lines:
        return ZERO_HASH
    if _has_prev(lines[-1]):
        return hash_line(lines[-1])
    return hash_line("\n".join(lines))


def _read_prev(n: int, *, text: str) -> Any:
    """Line `n`'s `prev` value (None on a line from before chaining). Raises LedgerError if it is not an object."""
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        raise LedgerError(f"ledger line {n} is not valid JSON") from None
    if not isinstance(parsed, dict):
        raise LedgerError(f"ledger line {n} is not an object")
    return parsed.get("prev")


def check_chain(lines: list[str]) -> dict:
    """Walk the whole ledger. Raises LedgerError naming the first line that does not fit."""
    legacy = chained = 0
    for number, text in enumerate(lines, 1):
        prev = _read_prev(number, text=text)
        if prev is None and chained:
            raise LedgerError(
                f"ledger line {number} has no prev hash but follows chained lines: "
                "it was inserted, or the chain was stripped from it"
            )
        if prev is None:
            legacy += 1
            continue
        want = hash_line(lines[number - 2]) if chained else find_chain_head(lines[: number - 1])
        if prev != want:
            raise LedgerError(
                f"ledger line {number}: its prev hash does not match the lines before it, so a line "
                f"at or before line {number - 1} was removed, edited or moved"
            )
        chained += 1
    return {"lines": len(lines), "legacy": legacy, "chained": chained}


def check_grew_only(lines: list[str], *, base_lines: list[str], ref: str) -> None:
    """The ledger at `ref` must still be an unchanged beginning of the current ledger."""
    if len(lines) < len(base_lines):
        gone = len(base_lines) - len(lines)
        raise LedgerError(f"{gone} line(s) from the end of the ledger at {ref} are gone")
    for index, text in enumerate(base_lines):
        if lines[index] != text:
            raise LedgerError(f"ledger line {index + 1} differs from the ledger at {ref}")
