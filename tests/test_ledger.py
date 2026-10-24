"""AC 28-31: run orchestration, ledger validation, attribution, examples as fixtures.

@author Patrick Finazzo
"""

import json
from pathlib import Path

import pytest

from claimcheck import ClaimcheckError, ledger
from claimcheck import claims as CL
from claimcheck import spec as S
from conftest import PY

ROOT = Path(__file__).resolve().parents[1]
EXAMPLES = ROOT / "examples"
TEST_CMD = f"{PY} -m pytest -q -p no:cacheprovider"


# ---- AC 28 ---------------------------------------------------------------

def test_ac28_run_appends_one_line_per_claim(calc_repo, capsys):
    code = calc_repo.cli("run", "--provider", "stub", "--test-cmd", TEST_CMD)
    assert code == 0
    out = json.loads(capsys.readouterr().out)
    assert out["ledger_lines_appended"] == 2
    lines = calc_repo.read(".claimcheck/ledger.jsonl").splitlines()
    assert len(lines) == 2
    recs = [ledger.validate_line(l) for l in lines]
    assert [r["claim_id"] for r in recs] == ["c1", "c2"]
    for r in recs:
        assert r["type"] == "claim" and r["v"] == 1
        assert r["outcome"] is None and r["outcome_source"] is None and r["outcome_ts"] is None
        assert r["checker"]["verdict"] == "UNVERIFIABLE"
        assert r["mutation"]["total"] == 3 and r["mutation"]["catch_rate"] == 1.0
        assert r["run_id"] == out["run_id"]
        assert len(r["repo"]) == 64
        assert json.dumps(r, sort_keys=True, ensure_ascii=False) in lines  # written sorted
    assert calc_repo.read(".claimcheck/ledger.jsonl").endswith("\n")


def test_ac28_exit_is_max_of_parts(calc_repo, monkeypatch):
    fixtures = Path(__file__).parent / "fixtures" / "stub_verdicts.json"
    monkeypatch.setenv("CLAIMCHECK_STUB_FILE", str(fixtures))
    assert calc_repo.cli("run", "--provider", "stub", "--test-cmd", "exit 0") == 2
    lines = calc_repo.read(".claimcheck/ledger.jsonl").splitlines()
    recs = [json.loads(l) for l in lines]
    assert recs[1]["checker"]["verdict"] == "REFUTED"
    assert recs[0]["mutation"]["catch_rate"] == 0.0


def test_ac28_append_is_all_or_nothing(repo):
    repo.cli("init")
    good = json.loads((EXAMPLES / "ledger.jsonl").read_text(encoding="utf-8").splitlines()[0])
    with pytest.raises(ClaimcheckError):
        ledger.append_atomic(repo.path, [good, {"v": 1, "type": "claim"}])
    assert repo.read(".claimcheck/ledger.jsonl") == ""
    assert not list(repo.cc.glob(".ledger-*.tmp"))


# ---- AC 29 ---------------------------------------------------------------

def test_ac29_validate_line_rejects_bad_lines():
    with pytest.raises(ClaimcheckError):
        ledger.validate_line('{"v": 1, "type": "weird"}')
    with pytest.raises(ClaimcheckError) as e:
        ledger.validate_line('{"v": 1, "type": "outcome", "ts": "t"}')
    assert "missing keys" in str(e.value)
    with pytest.raises(ClaimcheckError):
        ledger.validate_line("not json")


def test_ac29_example_ledger_round_trips():
    for line in (EXAMPLES / "ledger.jsonl").read_text(encoding="utf-8").splitlines():
        rec = ledger.validate_line(line)
        assert rec["type"] in ("claim", "outcome")


# ---- AC 30 ---------------------------------------------------------------

def test_ac30_attribution_everywhere():
    files = [ROOT / "README.md", ROOT / "pyproject.toml", *sorted((ROOT / "src" / "claimcheck").rglob("*.py"))]
    missing = [str(f) for f in files if "@author Patrick Finazzo" not in f.read_text(encoding="utf-8")]
    assert missing == []
    assert '{ name = "Patrick Finazzo" }' in (ROOT / "pyproject.toml").read_text(encoding="utf-8")


# ---- AC 31 ---------------------------------------------------------------

def test_ac31_examples_are_valid_fixtures(repo):
    repo.cli("init")
    repo.write(".claimcheck/spec.md", (EXAMPLES / "spec.md").read_text(encoding="utf-8"))
    repo.commit("example spec")
    assert repo.cli("spec", "freeze") == 0
    lock_ids = S.lock_ids(S.read_lock(repo.path))
    cf = CL.load_file(EXAMPLES / "claims.yaml", lock_ids)
    assert [c.id for c in cf.claims] == ["c1", "c2", "c3"]
    assert repo.cli("claims", "validate", str(EXAMPLES / "claims.yaml")) == 0
    import tomllib

    cfg = tomllib.loads((EXAMPLES / "config.toml").read_text(encoding="utf-8"))
    assert cfg["checker"]["model"] == "claude-opus-5-5"
