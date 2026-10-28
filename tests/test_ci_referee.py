"""`run` and `check` refuse what the commit hook refuses, and UNVERIFIABLE no longer passes on its own.

Why this file exists: the AI being checked can commit with --no-verify, skipping the hook, and it can
steer the checker toward "can't tell". These tests play that author. A run must refuse claims that
don't match the diff, must not report SUPPORTED for a file the checker never saw, and must fail on an
UNVERIFIABLE claim until a person accepts it with `claimcheck accept`.

@author Patrick Finazzo
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from claimcheck import (
    accept,
    checker,
    claims,
    cli,
    config,
    detect,
    hook,
    initflow,
    ledger,
    providers,
    redact,
    run,
)
from claimcheck.providers import Provider, Request, make_provider
from conftest import CLAIMS_FOR_CALC, PY

TEST_CMD = f"{PY} -m pytest -q -p no:cacheprovider"


def make_verdict_provider(verdicts_by_id: dict[str, str]) -> tuple[Provider, list[str]]:
    """A checker that answers each claim in the prompt with the verdict given for its id, and the prompts it got."""
    prompts: list[str] = []

    def answer_request(request: Request) -> str:
        """Answer every claim in the claims block with its chosen verdict."""
        prompts.append(request["user"])
        ids = [claim["id"] for claim in json.loads(request["user"].split("```json", 1)[1].split("```", 1)[0])]
        verdicts = [{"id": claim_id, "verdict": verdicts_by_id[claim_id], "reason": "fake", "evidence": []} for claim_id in ids]
        return json.dumps({"verdicts": verdicts})

    return make_provider("verdicts", complete=answer_request), prompts


def use_checker(monkeypatch: pytest.MonkeyPatch, *, verdicts_by_id: dict[str, str]) -> list[str]:
    """Make every provider the fake checker; return the list its prompts land in."""
    provider, prompts = make_verdict_provider(verdicts_by_id)
    monkeypatch.setattr(providers, "load", lambda name, model=None: provider)
    return prompts


def set_config_line(repo, *, key: str, value: str) -> None:
    """Change one top-level or [checker] line of the working-tree config.toml."""
    text = repo.read(".claimcheck/config.toml")
    repo.write(".claimcheck/config.toml", text=re.sub(rf"(?m)^{key} = .*$", f"{key} = {value}", text, count=1))


def claim_entry(*, claim_id: str, files: list[str], text: str = "the change does what it says") -> str:
    """One claims.yaml entry, as YAML text."""
    return (
        f'  - id: {claim_id}\n    claim: "{text}"\n    confidence: 0.5\n    criteria: [1]\n'
        f"    files: {json.dumps(files)}\n    kill_condition: \"obs: someone checks it\"\n    verified_by: [\"obs: looked\"]\n"
    )


def write_claims(repo, *, entries: list[str]) -> None:
    """Replace claims.yaml with these entries (none gives `claims: []`)."""
    head = 'version: 1\nauthor: "test-agent"\nbase: "main"\n'
    repo.write(".claimcheck/claims.yaml", text=head + ("claims:\n" + "".join(entries) if entries else "claims: []\n"))


# ---- the hook's rules, now in run and check -----------------------------------------------------

@pytest.mark.parametrize("command", ["check", "run"])
def test_code_changed_with_no_claims_exits_4_before_the_checker(calc_repo, *, monkeypatch, command):
    prompts = use_checker(monkeypatch, verdicts_by_id={})
    write_claims(calc_repo, entries=[])
    calc_repo.commit("drop the claims, the way --no-verify would let through", date="2020-01-06T00:00:00+00:00")
    assert calc_repo.cli(*([command, "--provider", "stub"] + (["--test-cmd", TEST_CMD] if command == "run" else []))) == 4
    assert prompts == [], "the checker was never asked"


@pytest.mark.parametrize("command", ["check", "run"])
def test_a_claim_about_a_file_the_diff_does_not_change_exits_4_even_beside_a_good_claim(calc_repo, *, monkeypatch, command):
    prompts = use_checker(monkeypatch, verdicts_by_id={})
    write_claims(calc_repo, entries=[claim_entry(claim_id="c1", files=["src/calc.py"]), claim_entry(claim_id="c2", files=["src/untouched.py"])])
    calc_repo.commit("claim a file that never changed", date="2020-01-06T00:00:00+00:00")
    assert calc_repo.cli(*([command, "--provider", "stub"] + (["--test-cmd", TEST_CMD] if command == "run" else []))) == 4
    assert prompts == []


def test_an_uncovered_code_file_exits_4_with_full_coverage_and_only_warns_without_it(calc_repo, *, monkeypatch, capsys):
    use_checker(monkeypatch, verdicts_by_id={"c1": "SUPPORTED", "c2": "SUPPORTED"})
    calc_repo.write("src/extra.py", text="X = 1\n")
    calc_repo.commit("a second code file with no claim", date="2020-01-06T00:00:00+00:00")
    assert calc_repo.cli("check", "--provider", "stub") == 4
    assert "src/extra.py" in capsys.readouterr().err
    set_config_line(calc_repo, key="require_full_coverage", value="false")
    assert calc_repo.cli("check", "--provider", "stub") == 0
    assert "warning: changed code files with no claim covering them: src/extra.py" in capsys.readouterr().err


def test_the_hook_and_check_give_the_same_refusal_through_one_function(calc_repo, *, monkeypatch):
    calls = []
    real = claims.check_coverage

    def spy(claims_file, **kw):
        """Record that the shared rules ran, then run them."""
        calls.append(kw["changed_paths"])
        return real(claims_file, **kw)

    monkeypatch.setattr(claims, "check_coverage", spy)
    use_checker(monkeypatch, verdicts_by_id={})
    bad = [claim_entry(claim_id="c1", files=["src/calc.py"]), claim_entry(claim_id="c2", files=["src/untouched.py"])]
    write_claims(calc_repo, entries=bad)
    calc_repo.write("src/calc.py", text=calc_repo.read("src/calc.py") + "\n# touched\n")
    calc_repo.git("add", "-A")
    with pytest.raises(claims.ClaimsError) as from_hook:
        hook.run_pre_commit(calc_repo.path, settings=config.load(calc_repo.path))
    calc_repo.git("commit", "-q", "--no-verify", "-m", "skip the hook")
    with pytest.raises(claims.ClaimsError) as from_check:
        checker.run_check(calc_repo.path, settings=config.load(calc_repo.path), provider_name="stub")
    assert str(from_hook.value) == str(from_check.value)
    assert len(calls) == 2, "the hook and check both went through claims.check_coverage"


def test_a_refusal_wins_over_a_refuted_verdict_and_the_checker_never_runs(calc_repo, *, monkeypatch):
    prompts = use_checker(monkeypatch, verdicts_by_id={"c1": "REFUTED", "c2": "REFUTED"})
    write_claims(calc_repo, entries=[claim_entry(claim_id="c1", files=["src/untouched.py"])])
    calc_repo.commit("bad claim", date="2020-01-06T00:00:00+00:00")
    assert calc_repo.cli("check", "--provider", "stub") == 4
    assert prompts == []


# ---- files the checker never saw ------------------------------------------------------------------

def test_a_claim_about_a_withheld_or_cut_file_cannot_come_back_supported(calc_repo, *, monkeypatch):
    use_checker(monkeypatch, verdicts_by_id={"c1": "SUPPORTED", "c2": "SUPPORTED"})
    calc_repo.write(".env", text="SECRET=topsecretvalue1234\n")
    calc_repo.git("add", "-f", ".env")
    calc_repo.write("src/big.py", text="".join(f"LINE_{index} = {index}\n" for index in range(redact.PER_FILE_CHARS // 10)))
    write_claims(calc_repo, entries=[claim_entry(claim_id="c1", files=["src/calc.py"]), claim_entry(claim_id="c2", files=["src/calc.py", ".env", "src/big.py"])])
    calc_repo.commit("a secret file and a huge one", date="2020-01-06T00:00:00+00:00")
    report, code = checker.run_check(calc_repo.path, settings=config.load(calc_repo.path), provider_name="stub")
    verdicts = {verdict["id"]: verdict for verdict in report["verdicts"]}
    assert verdicts["c1"]["verdict"] == "SUPPORTED"
    assert verdicts["c2"]["verdict"] == "UNVERIFIABLE"
    assert ".env" in verdicts["c2"]["reason"] and "src/big.py" in verdicts["c2"]["reason"]
    assert report["sent"]["files_truncated"] == ["src/big.py"]
    assert code == checker.EXIT_NEEDS_A_PERSON


def test_refuted_stays_refuted_and_unverifiable_gains_the_unseen_files():
    claims_file = claims.make_claims_file(version=1, author="a", base="main", claims=[
        {"id": "c1", "claim": "x", "confidence": 0.5, "criteria": [], "files": [".env"], "kill_condition": "obs: y", "verified_by": ["z"]},
        {"id": "c2", "claim": "x", "confidence": 0.5, "criteria": [], "files": [".env"], "kill_condition": "obs: y", "verified_by": ["z"]},
    ])
    verdicts = [
        {"id": "c1", "verdict": "REFUTED", "reason": "wrong", "evidence": ["-a"]},
        {"id": "c2", "verdict": "UNVERIFIABLE", "reason": "needs runtime", "evidence": []},
    ]
    marked = checker.mark_unseen(verdicts, claims_file=claims_file, unseen=[".env"])
    assert marked[0] == verdicts[0]
    assert marked[1]["verdict"] == "UNVERIFIABLE" and marked[1]["reason"].startswith("needs runtime (") and ".env" in marked[1]["reason"]


# ---- UNVERIFIABLE fails unless a person accepts it --------------------------------------------------

def test_fail_on_unverifiable_is_on_when_the_config_does_not_say(cc_repo):
    text = cc_repo.read(".claimcheck/config.toml")
    cc_repo.write(".claimcheck/config.toml", text=text.replace("fail_on_unverifiable = true\n", ""))
    assert "fail_on_unverifiable" not in cc_repo.read(".claimcheck/config.toml")
    assert config.load(cc_repo.path)["checker_fail_on_unverifiable"] is True


def test_one_open_unverifiable_exits_9(calc_repo, *, monkeypatch):
    use_checker(monkeypatch, verdicts_by_id={"c1": "SUPPORTED", "c2": "UNVERIFIABLE"})
    assert calc_repo.cli("check", "--provider", "stub") == 9


def test_refuted_and_a_low_catch_rate_beat_9_and_9_beats_0(calc_repo, *, monkeypatch):
    use_checker(monkeypatch, verdicts_by_id={"c1": "REFUTED", "c2": "UNVERIFIABLE"})
    assert calc_repo.cli("check", "--provider", "stub") == 2
    assert run.pick_exit_code([9, 2]) == 2
    assert run.pick_exit_code([2, 9]) == 2
    assert run.pick_exit_code([9, 0]) == 9
    assert run.pick_exit_code([0, 0]) == 0


def test_with_fail_on_unverifiable_off_an_open_unverifiable_only_warns(calc_repo, *, monkeypatch, capsys):
    use_checker(monkeypatch, verdicts_by_id={"c1": "SUPPORTED", "c2": "UNVERIFIABLE"})
    set_config_line(calc_repo, key="fail_on_unverifiable", value="false")
    assert calc_repo.cli("check", "--provider", "stub") == 0
    assert "warning: claim c2 is UNVERIFIABLE and not accepted" in capsys.readouterr().err


# ---- claimcheck accept ----------------------------------------------------------------------------------

@pytest.mark.parametrize(("claim_id", "note"), [("c2", ""), ("c2", "   "), ("c9", "checked by hand")])
def test_accept_refuses_an_empty_note_or_an_unknown_claim_and_writes_nothing(calc_repo, *, claim_id, note):
    before = calc_repo.read(".claimcheck/ledger.jsonl")
    assert calc_repo.cli("accept", claim_id, "--note", note) == 4
    assert calc_repo.read(".claimcheck/ledger.jsonl") == before


def test_accept_works_before_any_run_and_records_unknown_without_a_git_name(calc_repo):
    assert calc_repo.cli("accept", "c2", "--note", "ran it by hand") == 0
    [line] = calc_repo.read(".claimcheck/ledger.jsonl").splitlines()
    assert json.loads(line)["accepted_by"] == "unknown"


def test_accept_outside_a_git_repo_gives_the_usual_error(tmp_path, *, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    assert cli.main(["accept", "c2", "--note", "x"]) != 0
    assert "not a git repository" in capsys.readouterr().err


def test_accept_appends_one_chained_line_with_both_hashes_the_note_and_the_name(calc_repo):
    calc_repo.git("config", "user.name", "Dana Reviewer")
    assert calc_repo.cli("accept", "c2", "--note", "ran is_adult(18) by hand") == 0
    [line] = calc_repo.read(".claimcheck/ledger.jsonl").splitlines()
    record = json.loads(line)
    claims_file = claims.load_and_validate(CLAIMS_FOR_CALC, lock_ids={1, 2})
    claim = next(each for each in claims_file["claims"] if each["id"] == "c2")
    assert record["type"] == "accept" and record["claim_id"] == "c2"
    assert record["claim_hash"] == accept.hash_claim(claim)
    assert record["files_hash"] == accept.hash_files(calc_repo.path, files=["src/calc.py"])
    assert record["note"] == "ran is_adult(18) by hand" and record["accepted_by"] == "Dana Reviewer" and record["ts"]
    assert ledger.check_chain([line])["chained"] == 1


def test_an_acceptance_holds_until_the_claim_or_its_files_change(calc_repo, *, monkeypatch):
    use_checker(monkeypatch, verdicts_by_id={"c1": "SUPPORTED", "c2": "UNVERIFIABLE"})
    assert calc_repo.cli("check", "--provider", "stub") == 9
    assert calc_repo.cli("accept", "c2", "--note", "ran it by hand") == 0
    assert calc_repo.cli("check", "--provider", "stub") == 0
    # An uncommitted edit to a listed file voids it, so a run in the working tree fails again.
    calc_repo.write("src/calc.py", text=calc_repo.read("src/calc.py") + "\n# later edit\n")
    assert calc_repo.cli("check", "--provider", "stub", "--worktree") == 9
    calc_repo.git("checkout", "--", "src/calc.py")
    assert calc_repo.cli("check", "--provider", "stub") == 0
    # So does editing what the claim says.
    calc_repo.write(".claimcheck/claims.yaml", text=CLAIMS_FOR_CALC.replace("is_adult is inclusive at 18", "is_adult is inclusive at 18 and 19"))
    calc_repo.commit("reword the claim", date="2020-01-07T00:00:00+00:00")
    assert calc_repo.cli("check", "--provider", "stub") == 9


def test_an_acceptance_does_not_depend_on_the_base_or_other_files(calc_repo, *, monkeypatch):
    use_checker(monkeypatch, verdicts_by_id={"c1": "SUPPORTED", "c2": "UNVERIFIABLE"})
    assert calc_repo.cli("accept", "c2", "--note", "ran it by hand") == 0
    assert calc_repo.cli("check", "--provider", "stub") == 0
    # Another file changes on the branch, and the base branch moves on.
    calc_repo.write("README.md", text="# changed docs\n")
    calc_repo.commit("docs on the branch", date="2020-01-06T00:00:00+00:00")
    calc_repo.git("checkout", "-q", "main")
    calc_repo.write("docs/notes.md", text="notes\n")
    calc_repo.commit("docs on main", date="2020-01-07T00:00:00+00:00")
    calc_repo.git("checkout", "-q", "feat")
    assert calc_repo.cli("check", "--provider", "stub") == 0


@pytest.mark.parametrize("fail_on_unverifiable", ["true", "false"])
def test_the_output_and_the_ledger_name_the_claims_that_passed_by_acceptance(calc_repo, *, monkeypatch, capsys, fail_on_unverifiable):
    use_checker(monkeypatch, verdicts_by_id={"c1": "SUPPORTED", "c2": "UNVERIFIABLE"})
    set_config_line(calc_repo, key="fail_on_unverifiable", value=fail_on_unverifiable)
    assert calc_repo.cli("accept", "c2", "--note", "ran it by hand") == 0
    acceptance_hash = ledger.hash_line(calc_repo.read(".claimcheck/ledger.jsonl").splitlines()[0])
    capsys.readouterr()
    assert calc_repo.cli("run", "--provider", "stub", "--test-cmd", TEST_CMD) == 0
    captured = capsys.readouterr()
    assert "claim c2 is UNVERIFIABLE but passes: a person accepted it" in captured.err
    assert json.loads(captured.out)["check"]["accepted"] == {"c2": acceptance_hash}
    run_lines = [json.loads(line) for line in calc_repo.read(".claimcheck/ledger.jsonl").splitlines()[1:]]
    assert {line["claim_id"]: line["accepted"] for line in run_lines} == {"c1": None, "c2": acceptance_hash}


# ---- what the agent is told, and the docs ------------------------------------------------------------------

def test_init_tells_agents_that_only_a_person_runs_accept(repo):
    initflow.run_setup(repo.path, create_agent_doc="claude")
    assert "Only a person runs `claimcheck accept`; never run it yourself." in repo.read("CLAUDE.md")


def test_the_docs_and_the_written_config_cover_fail_on_unverifiable_exit_9_and_accept():
    root = Path(__file__).resolve().parents[1]
    readme_text = (root / "README.md").read_text(encoding="utf-8")
    assert "fail_on_unverifiable" in readme_text and "| 9 |" in readme_text and "claimcheck accept" in readme_text
    assert "fail_on_unverifiable = true" in (root / "examples" / "config.toml").read_text(encoding="utf-8")
    assert "fail_on_unverifiable = true" in detect.render_config(detect.detect(root))
