"""claims.yaml: dataclasses, validation, and the redaction the checker sees.

@author Patrick Finazzo
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from . import ClaimsError
from . import config as C

KILL_PREFIXES = ("cmd:", "test:", "obs:")
ID_RE = re.compile(r"^[a-z0-9_-]+$")


@dataclass
class Claim:
    id: str
    claim: str
    confidence: float
    criteria: list[int]
    files: list[str]
    kill_condition: str
    verified_by: list[str]


@dataclass
class ClaimsFile:
    version: int
    author: str
    base: str
    claims: list[Claim] = field(default_factory=list)


def claims_path(repo: Path) -> Path:
    """Where the claims file lives in a repo."""
    return C.cc_dir(repo) / C.CLAIMS_FILE


def _read_text_field(raw: dict, key: str, tag: str) -> tuple[str, str | None]:
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
        data = yaml.safe_load(text)
    except yaml.YAMLError as e:
        return None, [f"invalid YAML: {e}"]
    if not isinstance(data, dict):
        return None, ["top level must be a mapping"]
    violations: list[str] = []
    if "version" not in data:
        violations.append("missing version")
    elif data["version"] != 1:
        violations.append(f"version must be 1 (got {data['version']!r})")
    raw_claims = data.get("claims")
    if not isinstance(raw_claims, list):
        violations.append("claims must be a list")
        raw_claims = []
    claims: list[Claim] = []
    for i, rc in enumerate(raw_claims):
        if not isinstance(rc, dict):
            violations.append(f"claims[{i}] must be a mapping")
            continue
        tag = f"claims[{i}]"

        criteria_raw = rc.get("criteria") or []
        if not isinstance(criteria_raw, list):
            violations.append(f"{tag}: criteria must be a list of numbers (got {criteria_raw!r})")
            criteria_raw = []
        files_raw = rc.get("files") or []
        if not isinstance(files_raw, list) or any(not isinstance(f, str) for f in files_raw):
            violations.append(f"{tag}: files must be a list of paths (got {files_raw!r})")
            files_raw = []
        text_fields = {key: _read_text_field(rc, key, tag) for key in ("id", "claim", "kill_condition")}
        violations.extend(problem for _, problem in text_fields.values() if problem)
        # validate() checks these two later; parse() keeps whatever the YAML held so it can report it.
        raw_confidence: Any = rc.get("confidence")
        raw_verified_by: Any = rc.get("verified_by")
        claims.append(
            Claim(
                id=text_fields["id"][0],
                claim=text_fields["claim"][0],
                confidence=raw_confidence,
                criteria=list(criteria_raw),
                files=[f.replace("\\", "/") for f in files_raw],
                kill_condition=text_fields["kill_condition"][0],
                verified_by=raw_verified_by,
            )
        )
    cf = ClaimsFile(
        version=data.get("version", 0),
        author=str(data.get("author", "") or ""),
        base=str(data.get("base", "") or ""),
        claims=claims,
    )
    return cf, violations


NO_LOCK_HINT = " (no spec.lock; run claimcheck spec freeze)"


def validate(cf: ClaimsFile, lock_ids: set[int] | None) -> list[str]:
    """Return one line per violation (empty list == valid).

    `lock_ids=None` means there is no spec.lock at all: the frozen id set is then
    empty, so every non-empty `criteria` list is a violation.
    """
    out: list[str] = []
    no_lock = lock_ids is None
    frozen: set[int] = set() if no_lock else lock_ids  # type: ignore[assignment]
    seen: set[str] = set()
    for c in cf.claims:
        tag = f"claim {c.id or '<no id>'}"
        if not c.id or not ID_RE.match(c.id):
            out.append(f"{tag}: id must match [a-z0-9_-]+")
        if c.id in seen:
            out.append(f"{tag}: duplicate id")
        seen.add(c.id)
        if not c.claim.strip():
            out.append(f"{tag}: claim text is empty")
        conf = c.confidence
        if isinstance(conf, bool) or not isinstance(conf, (int, float)) or not (0.0 <= float(conf) <= 1.0):
            out.append(f"{tag}: confidence must be a float in [0.0, 1.0] (got {conf!r})")
        kc = c.kill_condition
        prefix = next((p for p in KILL_PREFIXES if kc.startswith(p)), None)
        if prefix is None:
            out.append(f"{tag}: kill_condition must start with one of {list(KILL_PREFIXES)}")
        elif kc[len(prefix):].strip() == c.claim.strip():
            out.append(f"{tag}: kill_condition must differ from the claim text")
        vb = c.verified_by
        if not isinstance(vb, list) or not vb or any(not isinstance(v, str) or not v.strip() for v in vb):
            out.append(f"{tag}: verified_by must be a non-empty list of non-empty strings")
        if not c.files:
            out.append(f"{tag}: files must be non-empty")
        bad = [i for i in c.criteria if not isinstance(i, int) or isinstance(i, bool) or i not in frozen]
        if bad:
            out.append(f"{tag}: criteria ids not in the frozen lock: {bad}" + (NO_LOCK_HINT if no_lock else ""))
    return out


def load_and_validate(text: str, lock_ids: set[int] | None) -> ClaimsFile:
    """Parse and validate claims text. Raises ClaimsError listing every violation."""
    cf, violations = load_text(text)
    if cf is not None:
        violations += validate(cf, lock_ids)
    if violations:
        raise ClaimsError("claims file invalid:\n  " + "\n  ".join(violations))
    assert cf is not None
    return cf


def load_file(path: Path, lock_ids: set[int] | None) -> ClaimsFile:
    """Load and validate a claims file. Raises ClaimsError when it is missing or invalid."""
    if not path.exists():
        raise ClaimsError(f"missing claims file: {path}")
    return load_and_validate(path.read_text(encoding="utf-8"), lock_ids)


def redact(cf: ClaimsFile) -> list[dict]:
    """What the independent checker is allowed to see: no confidence, no verified_by."""
    return [
        {
            "id": c.id,
            "claim": c.claim,
            "criteria": list(c.criteria),
            "files": list(c.files),
            "kill_condition": c.kill_condition,
        }
        for c in cf.claims
    ]
