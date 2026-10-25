"""claims.yaml: typed records, validation, and the redaction the checker sees.

@author Patrick Finazzo
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any, TypedDict

import yaml

from . import ClaimsError, config

KILL_PREFIXES = ("cmd:", "test:", "obs:")
ID_RE = re.compile(r"^[a-z0-9_-]+$")


# One claim from claims.yaml. `confidence` and `verified_by` hold whatever the YAML had,
# so validate() can report a bad value; the checker never sees either.
Claim = TypedDict(
    "Claim",
    {
        "id": str,
        "claim": str,
        "confidence": float,
        "criteria": list[int],
        "files": list[str],
        "kill_condition": str,
        "verified_by": list[str],
    },
)

ClaimsFile = TypedDict("ClaimsFile", {"version": int, "author": str, "base": str, "claims": list[Claim]})


def make_claims_file(*, version: int, author: str, base: str, claims: list[Claim] | None = None) -> ClaimsFile:
    """A ClaimsFile; no claims unless given."""
    return {"version": version, "author": author, "base": base, "claims": [] if claims is None else claims}


def resolve_claims_path(repo: Path) -> Path:
    """Where the claims file lives in a repo."""
    return config.resolve_cc_dir(repo) / config.CLAIMS_FILE


def _read_text_field(raw: dict, *, key: str, tag: str) -> tuple[str, str | None]:
    """A text field of one raw claim, and the problem with it when it is not text."""
    value = raw.get(key)
    if value is None:
        return "", None
    if not isinstance(value, str):
        return "", f"{tag}: {key} must be text (got {value!r})"
    return value, None


def load_text(text: str) -> tuple[ClaimsFile | None, list[str]]:
    """Parse YAML into a ClaimsFile. Returns (file_or_None, violations)."""
    try:
        raw = yaml.safe_load(text)
    except yaml.YAMLError as error:
        return None, [f"invalid YAML: {error}"]
    if not isinstance(raw, dict):
        return None, ["top level must be a mapping"]
    violations: list[str] = []
    if "version" not in raw:
        violations.append("missing version")
    elif raw["version"] != 1:
        violations.append(f"version must be 1 (got {raw['version']!r})")
    raw_claims = raw.get("claims")
    if not isinstance(raw_claims, list):
        violations.append("claims must be a list")
        raw_claims = []
    claims: list[Claim] = []
    for index, raw_claim in enumerate(raw_claims):
        if not isinstance(raw_claim, dict):
            violations.append(f"claims[{index}] must be a mapping")
            continue
        tag = f"claims[{index}]"

        criteria_raw = raw_claim.get("criteria") or []
        if not isinstance(criteria_raw, list):
            violations.append(f"{tag}: criteria must be a list of numbers (got {criteria_raw!r})")
            criteria_raw = []
        files_raw = raw_claim.get("files") or []
        if not isinstance(files_raw, list) or any(not isinstance(file, str) for file in files_raw):
            violations.append(f"{tag}: files must be a list of paths (got {files_raw!r})")
            files_raw = []
        text_fields = {key: _read_text_field(raw_claim, key=key, tag=tag) for key in ("id", "claim", "kill_condition")}
        violations.extend(problem for _, problem in text_fields.values() if problem)
        # validate() checks these two later; parse() keeps whatever the YAML held so it can report it.
        raw_confidence: Any = raw_claim.get("confidence")
        raw_verified_by: Any = raw_claim.get("verified_by")
        claims.append(
            {
                "id": text_fields["id"][0],
                "claim": text_fields["claim"][0],
                "confidence": raw_confidence,
                "criteria": list(criteria_raw),
                "files": [file_path.replace("\\", "/") for file_path in files_raw],
                "kill_condition": text_fields["kill_condition"][0],
                "verified_by": raw_verified_by,
            }
        )
    claims_file = make_claims_file(
        version=raw.get("version", 0),
        author=str(raw.get("author", "") or ""),
        base=str(raw.get("base", "") or ""),
        claims=claims,
    )
    return claims_file, violations


NO_LOCK_HINT = " (no spec.lock; run claimcheck spec freeze)"


def validate(claims_file: ClaimsFile, *, lock_ids: set[int] | None) -> list[str]:
    """Return one line per violation (empty list == valid).

    `lock_ids=None` means there is no spec.lock at all: the frozen id set is then
    empty, so every non-empty `criteria` list is a violation.
    """
    violations: list[str] = []
    no_lock = lock_ids is None
    frozen: set[int] = set() if no_lock else lock_ids  # type: ignore[assignment]
    seen: set[str] = set()
    for claim in claims_file["claims"]:
        tag = f"claim {claim['id'] or '<no id>'}"
        if not claim["id"] or not ID_RE.match(claim["id"]):
            violations.append(f"{tag}: id must match [a-z0-9_-]+")
        if claim["id"] in seen:
            violations.append(f"{tag}: duplicate id")
        seen.add(claim["id"])
        if not claim["claim"].strip():
            violations.append(f"{tag}: claim text is empty")
        conf = claim["confidence"]
        if isinstance(conf, bool) or not isinstance(conf, (int, float)) or not (0.0 <= float(conf) <= 1.0):
            violations.append(f"{tag}: confidence must be a float in [0.0, 1.0] (got {conf!r})")
        kc = claim["kill_condition"]
        prefix = next((kill_prefix for kill_prefix in KILL_PREFIXES if kc.startswith(kill_prefix)), None)
        if prefix is None:
            violations.append(f"{tag}: kill_condition must start with one of {list(KILL_PREFIXES)}")
        elif kc[len(prefix):].strip() == claim["claim"].strip():
            violations.append(f"{tag}: kill_condition must differ from the claim text")
        vb = claim["verified_by"]
        if not isinstance(vb, list) or not vb or any(not isinstance(value, str) or not value.strip() for value in vb):
            violations.append(f"{tag}: verified_by must be a non-empty list of non-empty strings")
        if not claim["files"]:
            violations.append(f"{tag}: files must be non-empty")
        bad = [criterion for criterion in claim["criteria"] if not isinstance(criterion, int) or isinstance(criterion, bool) or criterion not in frozen]
        if bad:
            violations.append(f"{tag}: criteria ids not in the frozen lock: {bad}" + (NO_LOCK_HINT if no_lock else ""))
    return violations


def load_and_validate(text: str, *, lock_ids: set[int] | None) -> ClaimsFile:
    """Parse and validate claims text. Raises ClaimsError listing every violation."""
    cf, violations = load_text(text)
    if cf is not None:
        violations += validate(cf, lock_ids=lock_ids)
    if violations:
        raise ClaimsError("claims file invalid:\n  " + "\n  ".join(violations))
    assert cf is not None
    return cf


def load_file(path: Path, *, lock_ids: set[int] | None) -> ClaimsFile:
    """Load and validate a claims file. Raises ClaimsError when it is missing or invalid."""
    if not path.exists():
        raise ClaimsError(f"missing claims file: {path}")
    return load_and_validate(path.read_text(encoding="utf-8"), lock_ids=lock_ids)


# What the independent checker is allowed to see of a claim: no confidence, no verified_by.
CHECKER_KEYS = ("id", "claim", "criteria", "files", "kill_condition")


def redact(cf: ClaimsFile) -> list[dict]:
    """The file's claims as the independent checker may see them."""
    return redact_claims(cf["claims"])


def redact_claims(claims: Sequence[Mapping[str, Any]]) -> list[dict]:
    """Each claim cut down to CHECKER_KEYS, lists copied so the checker never shares the originals."""
    return [{key: list(claim[key]) if isinstance(claim[key], list) else claim[key] for key in CHECKER_KEYS if key in claim} for claim in claims]
