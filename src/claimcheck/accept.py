"""Acceptances: a person's decision to let through a claim the checker could not settle.

Why this file exists: a run fails while any claim is UNVERIFIABLE, because "the diff can't show it"
must not quietly pass. Some claims are about runtime behavior that no diff can show. A person who
has checked such a claim another way records that with `claimcheck accept`. The acceptance is a
ledger line tied to the claim and its files exactly as they were, so editing either one voids it.

@author Patrick Finazzo
"""

from __future__ import annotations

import json
from pathlib import Path

from . import ClaimsError, SpecError, claims, config, gitio, ledger, spec

# What a file a claim lists hashes to when it is not on disk, for example a claim about a deletion.
ABSENT = "absent"


def hash_claim(claim: claims.Claim) -> str:
    """Hash of what a claim says: its text, kill condition and files. Editing any of them voids an acceptance."""
    said = {"claim": claim["claim"], "kill_condition": claim["kill_condition"], "files": claim["files"]}
    return config.hash_text(json.dumps(said, sort_keys=True, ensure_ascii=False))


def _hash_file(path: Path) -> str:
    """Hash of one file's bytes, or ABSENT when no file is there."""
    return config.hash_bytes(path.read_bytes()) if path.is_file() else ABSENT


def hash_files(repo: Path, *, files: list[str]) -> str:
    """Hash of a claim's files as they are on disk now, so an edit voids the acceptance, committed or not."""
    contents = [{"path": path, "sha256": _hash_file(repo / path)} for path in sorted(files)]
    return config.hash_text(json.dumps(contents, sort_keys=True))


def read_user_name(repo: Path) -> str:
    """git's user.name for this repo, or "unknown" when none is set."""
    return gitio.run_git(repo, "config", "user.name", check=False).strip() or "unknown"


def _load_claims(repo: Path) -> claims.ClaimsFile:
    """The repo's claims file, validated against the lock when there is one. Raises ClaimsError."""
    lock_ids: set[int] | None
    try:
        lock_ids = spec.list_lock_ids(spec.read_lock(repo))
    except SpecError:
        # No lock: any cited criterion is a violation, as in `claims validate`.
        lock_ids = None
    return claims.load_file(claims.resolve_claims_path(repo), lock_ids=lock_ids)


def accept_claim(repo: Path, *, claim_id: str, note: str) -> dict:
    """Append one acceptance line for a claim to the ledger, and return it.

    Raises ClaimsError for an empty note or a claim id that is not in claims.yaml. The claim's
    current verdict does not matter: accepting before a run is allowed.
    """
    if not note.strip():
        raise ClaimsError("accept needs a --note saying how the claim was checked, since the diff cannot show it")
    claims_file = _load_claims(repo)
    claim = next((each for each in claims_file["claims"] if each["id"] == claim_id), None)
    if claim is None:
        known = ", ".join(each["id"] for each in claims_file["claims"]) or "none"
        raise ClaimsError(f"no claim {claim_id!r} in claims.yaml (claims there: {known})")
    record = ledger.build_accept_record(
        timestamp=config.format_utc_now(),
        claim_id=claim_id,
        claim_hash=hash_claim(claim),
        files_hash=hash_files(repo, files=claim["files"]),
        note=note.strip(),
        accepted_by=read_user_name(repo),
    )
    ledger.append_atomic(repo, records=[record])
    return record


def _parse_or_empty(text: str) -> dict:
    """One ledger line as an object; a torn or foreign line reads as an empty one."""
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def find_accepted(repo: Path, *, claims_file: claims.ClaimsFile) -> dict[str, str]:
    """Each claim with an acceptance that still matches, mapped to the newest such acceptance line's hash.

    An acceptance matches while the claim's text and its files' contents hash the same as when it
    was given. Claims with no matching acceptance are left out.
    """
    path = ledger.resolve_ledger_path(repo)
    lines = ledger.split_ledger_lines(path.read_bytes() if path.exists() else b"")
    wanted = {claim["id"]: (hash_claim(claim), hash_files(repo, files=claim["files"])) for claim in claims_file["claims"]}
    matching = [
        (record["claim_id"], ledger.hash_line(text))
        for text, record in ((text, _parse_or_empty(text)) for text in lines)
        if record.get("type") == "accept" and wanted.get(record.get("claim_id", "")) == (record.get("claim_hash"), record.get("files_hash"))
    ]
    # Later lines win, so each claim maps to its newest matching acceptance.
    return dict(matching)
