"""AC 9: claims.yaml schema validation, one violation per case.

@author Patrick Finazzo
"""

import pytest

from claimcheck import claims
from conftest import CLAIMS_FOR_CALC, use_single_layout

LOCK_IDS = {1, 2}


def _list_violations(text: str, *, lock_ids=LOCK_IDS) -> list[str]:
    cf, value = claims.load_text(text)
    if cf is not None:
        value = value + claims.validate(cf, lock_ids=lock_ids)
    return value


def test_ac9_valid_file_has_no_violations():
    assert _list_violations(CLAIMS_FOR_CALC) == []


def _make_one_claim(**overrides) -> str:
    fields = {
        "id": "c1",
        "claim": "sub returns a minus b",
        "confidence": 0.5,
        "criteria": "[1]",
        "files": '["src/calc.py"]',
        "kill_condition": '"test: tests/test_calc.py::test_sub"',
        "verified_by": '["cmd: pytest"]',
    }
    fields.update(overrides)
    body = "\n".join(f"    {key}: {value}" for key, value in fields.items())
    return f"version: 1\nclaims:\n  - {body.strip()}\n{body.split(chr(10), 1)[1] if chr(10) in body else ''}\n"


def _make_doc(claims_block: str, *, version: str = "version: 1\n") -> str:
    return version + claims_block


GOOD = """claims:
  - id: c1
    claim: "sub returns a minus b"
    confidence: 0.5
    criteria: [1]
    files: ["src/calc.py"]
    kill_condition: "test: tests/test_calc.py::test_sub"
    verified_by: ["cmd: pytest"]
"""


@pytest.mark.parametrize(
    "text, needle",
    [
        (_make_doc(GOOD, version=""), "missing version"),
        (_make_doc(GOOD, version="version: 2\n"), "version must be 1"),
        ("version: 1\nclaims: {}\n", "claims must be a list"),
        (_make_doc(GOOD + GOOD.replace("claims:\n", "")), "duplicate id"),
        (_make_doc(GOOD.replace("confidence: 0.5", "confidence: 1.5")), "confidence must be a float"),
        (_make_doc(GOOD.replace("confidence: 0.5", 'confidence: "high"')), "confidence must be a float"),
        (_make_doc(GOOD.replace('"test: tests', '"maybe: tests')), "kill_condition must start with"),
        (_make_doc(GOOD.replace('"test: tests/test_calc.py::test_sub"', '"obs: sub returns a minus b"')), "kill_condition must differ"),
        (_make_doc(GOOD.replace('verified_by: ["cmd: pytest"]', "verified_by: []")), "verified_by must be a non-empty list"),
        (_make_doc(GOOD.replace('verified_by: ["cmd: pytest"]', 'verified_by: "cmd: pytest"')), "verified_by must be a non-empty list"),
        (_make_doc(GOOD.replace('files: ["src/calc.py"]', "files: []")), "files must be non-empty"),
        (_make_doc(GOOD.replace("criteria: [1]", "criteria: [9]")), "criteria ids not in the frozen lock: [9]"),
    ],
)
def test_ac9_each_violation(text, *, needle):
    value = _list_violations(text)
    assert any(needle in line for line in value), value


def test_ac9_cli_exit_codes(cc_repo, *, capsys):
    cc_repo.write(".claimcheck/claims.yaml", text=_make_doc(GOOD))
    assert cc_repo.cli("claims", "validate") == 0
    bad = cc_repo.write("bad.yaml", text=_make_doc(GOOD.replace("confidence: 0.5", "confidence: 7")))
    assert cc_repo.cli("claims", "validate", str(bad)) == 4
    assert "confidence must be a float" in capsys.readouterr().err


def test_ac9_no_lock_means_no_frozen_ids(repo, *, capsys):
    # No freeze.
    repo.cli("init")
    use_single_layout(repo)
    repo.write(".claimcheck/claims.yaml", text=_make_doc(GOOD.replace("criteria: [1]", "criteria: [9]")))
    assert repo.cli("claims", "validate") == 4
    err = capsys.readouterr().err
    assert "criteria ids not in the frozen lock: [9]" in err and "no spec.lock" in err
    good_file = claims.load_text(_make_doc(GOOD))[0]
    assert good_file is not None
    assert claims.validate(good_file, lock_ids=None)[0].endswith("(no spec.lock; run claimcheck spec freeze)")
    # empty criteria are fine without a lock
    repo.write(".claimcheck/claims.yaml", text=_make_doc(GOOD.replace("criteria: [1]", "criteria: []")))
    assert repo.cli("claims", "validate") == 0


def test_redact_strips_confidence_and_verified_by():
    cf, _ = claims.load_text(CLAIMS_FOR_CALC)
    assert cf is not None
    red = claims.redact(cf)
    assert len(red) == 2
    for row in red:
        assert set(row) == {"id", "claim", "criteria", "files", "kill_condition"}
