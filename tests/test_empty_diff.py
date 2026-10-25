"""An empty diff is refused: nothing to verify, nothing recorded.

@author Patrick Finazzo
"""

from __future__ import annotations

import json

import pytest

from claimcheck import checker, mutate, providers
from conftest import PY

TEST_CMD = f"{PY} -m pytest -q -p no:cacheprovider"


def _no_provider(monkeypatch):
    def boom(*a, **k):
        raise AssertionError("the checker provider must not be loaded for an empty diff")

    monkeypatch.setattr(providers, "load", boom)


def _no_mutation(monkeypatch):
    def boom(*a, **k):
        raise AssertionError("no bug may be planted for an empty diff")

    monkeypatch.setattr(mutate, "_prepare", boom)


def test_run_refuses_an_empty_diff_and_says_what_to_do(cc_repo, capsys):
    assert cc_repo.cli("run", "--provider", "stub", "--test-cmd", "exit 0") == 7
    err = capsys.readouterr().err
    assert "the diff is empty" in err and "Commit the change" in err and "--worktree" in err


def test_run_on_an_empty_diff_calls_no_checker_plants_nothing_and_writes_no_ledger(cc_repo, monkeypatch):
    _no_provider(monkeypatch)
    _no_mutation(monkeypatch)
    before = cc_repo.read(".claimcheck/ledger.jsonl") if (cc_repo.cc / "ledger.jsonl").exists() else None
    assert cc_repo.cli("run", "--provider", "stub", "--test-cmd", "exit 0") == 7
    after = cc_repo.read(".claimcheck/ledger.jsonl") if (cc_repo.cc / "ledger.jsonl").exists() else None
    assert before == after
    assert not (cc_repo.cc / "mutate.lock").exists()


@pytest.mark.parametrize("command", ["check", "mutate"])
def test_check_and_mutate_refuse_an_empty_diff_the_same_way(cc_repo, capsys, command):
    extra = ["--provider", "stub"] if command == "check" else ["--test-cmd", "exit 0"]
    assert cc_repo.cli(command, *extra) == 7
    err = capsys.readouterr().err
    assert "the diff is empty" in err and "--worktree" in err


def test_worktree_mode_with_no_changes_is_also_refused(cc_repo, capsys):
    assert cc_repo.cli("run", "--provider", "stub", "--test-cmd", "exit 0", "--worktree") == 7
    assert "working tree has no changes" in capsys.readouterr().err


def test_a_non_empty_diff_runs_as_before(calc_repo, capsys):
    assert calc_repo.cli("run", "--provider", "stub", "--test-cmd", TEST_CMD) == 0
    assert json.loads(capsys.readouterr().out)["ledger_lines_appended"] == 2
    assert len(calc_repo.read(".claimcheck/ledger.jsonl").splitlines()) == 2


def test_the_claimcheck_folder_alone_does_not_count_as_a_change(cc_repo):
    cc_repo.branch("only-claimcheck-files")
    cc_repo.write(".claimcheck/claims.yaml", 'version: 1\nauthor: "x"\nbase: "main"\nclaims: []\n')
    cc_repo.commit("only claimcheck files changed")
    assert cc_repo.cli("run", "--provider", "stub", "--test-cmd", "exit 0") == 7
