"""The ledger is a hash chain: tampering is detected, old lines are sealed, Desk continues the chain.

@author Patrick Finazzo
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from claimcheck import ledger

FIXTURE = Path(__file__).parent / "fixtures" / "ledger_chain.json"
ROOT = Path(__file__).resolve().parents[1]


def _rec(cid: str, confidence: float = 0.5) -> dict:
    return ledger.claim_record(
        ts="2026-01-01T00:00:00Z", run_id="r1", repo_id="x" * 64, base="b", head="h", spec_lock="s",
        author="a", claim_id=cid, claim=f"claim {cid}", confidence=confidence, criteria=[1],
        files=["a.py"], kill_condition="obs: y", checker={"verdict": "SUPPORTED"}, mutation={"catch_rate": None},
    )


def _legacy(cid: str) -> str:
    # The form written before chaining.
    return json.dumps(_rec(cid), sort_keys=True, ensure_ascii=False)


def _read(repo) -> list[str]:
    return ledger.ledger_lines((repo.cc / "ledger.jsonl").read_bytes())


def _write(repo, lines: list[str]) -> None:
    (repo.cc / "ledger.jsonl").write_bytes(("\n".join(lines) + "\n").encode("utf-8"))


def _commit_ledger(repo) -> None:
    repo.git("add", ".claimcheck/ledger.jsonl")
    repo.git("commit", "-q", "-m", "ledger")


@pytest.fixture
def chained(cc_repo):
    """A repo whose ledger already holds four chained lines."""
    ledger.append_atomic(cc_repo.path, [_rec("c1"), _rec("c2"), _rec("c3"), _rec("c4")])
    return cc_repo


# ---- criterion 1: what gets written ------------------------------------------

def test_each_line_carries_the_hash_of_the_line_before(chained):
    lines = _read(chained)
    objs = [json.loads(line_text) for line_text in lines]
    # Nothing before it.
    assert objs[0]["prev"] == "0" * 64
    for i in range(1, 4):
        assert objs[i]["prev"] == ledger.line_hash(lines[i - 1])


def test_the_chain_continues_across_separate_appends(cc_repo):
    ledger.append_atomic(cc_repo.path, [_rec("c1")])
    ledger.append_atomic(cc_repo.path, [_rec("c2")])
    lines = _read(cc_repo)
    assert json.loads(lines[1])["prev"] == ledger.line_hash(lines[0])


def test_the_first_chained_line_seals_all_older_lines(cc_repo):
    older = [_legacy("o1"), _legacy("o2")]
    _write(cc_repo, older)
    ledger.append_atomic(cc_repo.path, [_rec("n1")])
    first = json.loads(_read(cc_repo)[2])
    assert first["prev"] == ledger.line_hash("\n".join(older))


def test_shared_fixture_pins_the_hashes():
    for case in json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"]:
        assert ledger.chain_head(case["lines"]) == case["head"], case["name"]


# ---- criteria 2 and 5: accepting an honest ledger ----------------------------

def test_an_untouched_chain_verifies(chained, capsys):
    assert chained.cli("verify-ledger") == 0
    assert json.loads(capsys.readouterr().out) == {"lines": 4, "legacy": 0, "chained": 4, "base": None}


def test_older_lines_without_prev_then_a_chain_verifies(cc_repo):
    _write(cc_repo, [_legacy("o1"), _legacy("o2")])
    ledger.append_atomic(cc_repo.path, [_rec("n1"), _rec("n2")])
    assert cc_repo.cli("verify-ledger") == 0


def test_an_empty_or_missing_ledger_verifies(cc_repo):
    assert cc_repo.cli("verify-ledger") == 0


def test_a_crlf_checkout_still_verifies(chained):
    path = chained.cc / "ledger.jsonl"
    path.write_bytes(path.read_bytes().replace(b"\n", b"\r\n"))
    assert chained.cli("verify-ledger") == 0
    # And it can keep growing.
    ledger.append_atomic(chained.path, [_rec("c5")])
    assert chained.cli("verify-ledger") == 0


def test_an_unchained_line_after_chained_lines_is_refused(chained, capsys):
    _write(chained, _read(chained) + [_legacy("sneaky")])
    assert chained.cli("verify-ledger") == 8
    assert "ledger line 5 has no prev hash" in capsys.readouterr().err


# ---- criterion 3: tampering ---------------------------------------------------

def test_a_deleted_middle_line_is_found(chained, capsys):
    lines = _read(chained)
    del lines[1]
    _write(chained, lines)
    assert chained.cli("verify-ledger") == 8
    assert "ledger line 2:" in capsys.readouterr().err


def test_an_edited_line_is_found_at_the_next_line(chained, capsys):
    lines = _read(chained)
    obj = json.loads(lines[1])
    obj["confidence"] = 0.99
    lines[1] = json.dumps(obj, sort_keys=True, ensure_ascii=False)
    _write(chained, lines)
    assert chained.cli("verify-ledger") == 8
    assert "ledger line 3:" in capsys.readouterr().err


def test_two_swapped_lines_are_found(chained, capsys):
    lines = _read(chained)
    lines[1], lines[2] = lines[2], lines[1]
    _write(chained, lines)
    assert chained.cli("verify-ledger") == 8
    assert "ledger line 2:" in capsys.readouterr().err


def test_an_edited_older_line_is_found_once_a_chain_follows(cc_repo, capsys):
    _write(cc_repo, [_legacy("o1"), _legacy("o2")])
    ledger.append_atomic(cc_repo.path, [_rec("n1")])
    lines = _read(cc_repo)
    lines[0] = lines[0].replace("claim o1", "claim EDITED")
    _write(cc_repo, lines)
    assert cc_repo.cli("verify-ledger") == 8
    assert "ledger line 3:" in capsys.readouterr().err


def test_garbage_in_the_ledger_is_named(chained, capsys):
    lines = _read(chained)
    lines[2] = "not json"
    _write(chained, lines)
    assert chained.cli("verify-ledger") == 8
    assert "ledger line 3 is not valid JSON" in capsys.readouterr().err


# ---- criterion 4: the end of the ledger, against a base ref -------------------

def test_a_deleted_last_line_passes_alone_but_not_against_the_committed_base(chained, capsys):
    _commit_ledger(chained)
    _write(chained, _read(chained)[:-1])
    # A chain cannot see its own tail being cut off.
    assert chained.cli("verify-ledger") == 0
    assert chained.cli("verify-ledger", "--base", "HEAD") == 8
    assert "1 line(s) from the end of the ledger at HEAD are gone" in capsys.readouterr().err


def test_an_edited_last_line_is_found_against_the_base(chained, capsys):
    _commit_ledger(chained)
    lines = _read(chained)
    obj = json.loads(lines[-1])
    obj["confidence"] = 0.01
    lines[-1] = json.dumps(obj, sort_keys=True, ensure_ascii=False)
    _write(chained, lines)
    assert chained.cli("verify-ledger") == 0
    assert chained.cli("verify-ledger", "--base", "HEAD") == 8
    assert "ledger line 4 differs from the ledger at HEAD" in capsys.readouterr().err


def test_a_ledger_that_only_gained_lines_passes_against_the_base(chained):
    _commit_ledger(chained)
    ledger.append_atomic(chained.path, [_rec("c5")])
    assert chained.cli("verify-ledger", "--base", "HEAD") == 0


def test_a_base_ref_that_does_not_exist_is_an_error_not_a_pass(chained):
    assert chained.cli("verify-ledger", "--base", "no-such-ref") != 0


# ---- criterion 7: CI runs it ---------------------------------------------------

def test_the_ci_workflow_verifies_the_ledger_and_on_pull_requests_against_the_base():
    text = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
    assert "claimcheck verify-ledger\n" in text
    assert "claimcheck verify-ledger --base origin/${{ github.base_ref }}" in text
