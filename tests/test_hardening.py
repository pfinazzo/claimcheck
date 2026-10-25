"""Regressions for bugs found by an independent review: each test reproduces one of them.

@author Patrick Finazzo
"""

from __future__ import annotations

import json
import re
import subprocess
import sys

import pytest

from claimcheck import ClaimcheckError, checker, claims, config, gitio, hook, ledger
from claimcheck.providers import Provider
from conftest import SUBPROCESS_TIMEOUT_S
from fakes import make_sequence_provider

# ---- config -----------------------------------------------------------------

@pytest.mark.parametrize(
    "line, needle",
    [
        ('ignore = "docs/**"', "ignore must be a list"),
        ('test_cmd = 5', "test_cmd must be a string"),
        ('require_full_coverage = "yes"', "true or false"),
        ('checker = "claude"', "[checker] must be a table"),
        ('mutate = 3', "[mutate] must be a table"),
    ],
)
def test_config_wrong_types_are_a_clear_error(cc_repo, *, line, needle):
    cc_repo.write(".claimcheck/config.toml", text="version = 1\n" + line + "\n")
    with pytest.raises(ClaimcheckError, match=re.escape(needle)):
        config.load(cc_repo.path)


def test_config_wrong_type_inside_a_table(cc_repo):
    cc_repo.write(".claimcheck/config.toml", text='version = 1\n[mutate]\nmax_mutants = "ten"\n')
    with pytest.raises(ClaimcheckError, match="max_mutants must be a whole number"):
        config.load(cc_repo.path)


def test_config_with_a_bom_loads(cc_repo):
    (cc_repo.cc / "config.toml").write_bytes(b"\xef\xbb\xbf" + b'version = 1\ntest_cmd = "make test"\n')
    assert config.load(cc_repo.path)["test_cmd"] == "make test"


def test_double_star_prefix_matches_the_top_level_too():
    assert config.is_ignored("README.md", globs=["**/*.md"])
    assert config.is_ignored("a/b/README.md", globs=["**/*.md"])
    assert config.is_ignored("tests/x.py", globs=["**/tests/**"])
    assert not config.is_ignored("src/app.py", globs=["docs/**"])


# ---- hook installation ------------------------------------------------------

def test_hook_goes_where_git_looks_with_hooks_path(repo):
    (repo.path / ".husky").mkdir()
    repo.git("config", "core.hooksPath", ".husky")
    assert hook.install(repo.path) is True
    assert hook.HOOK_MARKER in (repo.path / ".husky" / "pre-commit").read_text(encoding="utf-8")
    assert not (repo.path / ".git" / "hooks" / "pre-commit").exists()


def test_hook_in_a_linked_worktree_uses_the_shared_hooks(repo, *, tmp_path):
    wt = tmp_path / "wt"
    repo.git("worktree", "add", "-q", str(wt), "-b", "side")
    assert hook.install(wt) is True
    assert hook.resolve_hook_file(wt) == hook.resolve_hook_file(repo.path)
    assert (repo.path / ".git" / "hooks" / "pre-commit").exists()


def test_hook_line_goes_before_a_trailing_exit(repo):
    path = hook.resolve_hook_file(repo.path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/bin/sh\necho lint\nexit 0\n", encoding="utf-8", newline="\n")
    assert hook.install(repo.path) is True
    lines = path.read_text(encoding="utf-8").splitlines()
    assert lines[-1] == "exit 0"
    assert hook.HOOK_MARKER in lines[-2]
    # Idempotent.
    assert hook.install(repo.path) is False


def test_hook_refuses_to_edit_a_non_shell_hook(repo):
    path = hook.resolve_hook_file(repo.path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/usr/bin/env python3\nprint('hi')\n", encoding="utf-8", newline="\n")
    with pytest.raises(ClaimcheckError, match="not a shell script"):
        hook.install(repo.path)
    assert path.read_text(encoding="utf-8") == "#!/usr/bin/env python3\nprint('hi')\n"


# ---- claims file ------------------------------------------------------------

def _list_violations(text):
    cf, v = claims.load_text(text)
    if cf is not None:
        v += claims.validate(cf, lock_ids={1})
    return v


GOOD = """\
version: 1
author: a
base: main
claims:
  - id: c1
    claim: "x"
    confidence: 0.5
    criteria: [1]
    files: ["a.py"]
    kill_condition: "obs: y"
    verified_by: ["obs: z"]
"""


def test_a_null_claim_is_empty_not_the_word_none():
    value = _list_violations(GOOD.replace('claim: "x"', "claim:"))
    assert any("claim text is empty" in element for element in value)
    assert not any("None" in piece for piece in value)


def test_wrong_field_types_are_violations_not_crashes():
    assert any("criteria must be a list" in value for value in _list_violations(GOOD.replace("criteria: [1]", "criteria: 1")))
    assert any("files must be a list" in element for element in _list_violations(GOOD.replace('files: ["a.py"]', "files: a.py")))
    assert any("must be text" in piece for piece in _list_violations(GOOD.replace("id: c1", "id: [c1]")))


# ---- checker ----------------------------------------------------------------

def _make_seq_provider(*replies: str) -> Provider:
    """A provider that answers with each reply in turn."""
    return make_sequence_provider(*replies)[0]


def _make_verdict(cid, *, verdict):
    return {"id": cid, "verdict": verdict, "reason": "r", "evidence": []}


def test_duplicate_verdicts_for_one_claim_are_invalid():
    parsed = {"verdicts": [_make_verdict("c1", verdict="REFUTED"), _make_verdict("c1", verdict="SUPPORTED")]}
    assert any("duplicate" in error for error in checker.validate_verdicts(parsed, claim_ids={"c1"}))


def test_a_refutation_in_a_flawed_reply_survives_a_second_flawed_reply():
    # C2 missing: invalid.
    first = json.dumps({"verdicts": [_make_verdict("c1", verdict="REFUTED")]})
    second = "not json at all"
    output = checker.ask(_make_seq_provider(first, second), system="s", user="u", claim_ids=["c1", "c2"])
    assert output[0]["verdict"] == "REFUTED"
    assert output[1]["verdict"] == "UNVERIFIABLE"


def test_a_refutation_beats_a_support_for_the_same_claim_across_replies():
    first = json.dumps({"verdicts": [_make_verdict("c1", verdict="SUPPORTED")]})
    second = json.dumps({"verdicts": [_make_verdict("c1", verdict="REFUTED"), _make_verdict("c1", verdict="REFUTED")]})
    output = checker.ask(_make_seq_provider(first, second), system="s", user="u", claim_ids=["c1", "c2"])
    assert output[0]["verdict"] == "REFUTED"


# ---- ledger -----------------------------------------------------------------

def test_append_never_fuses_onto_an_unterminated_last_line(cc_repo):
    def make_record(cid):
        return ledger.build_claim_record(
            timestamp="t", run_id="r", repo_id="x", base="b", head="h", spec_lock="s", author="a", claim_id=cid,
            claim="c", confidence=0.5, criteria=[1], files=["a.py"], kill_condition="obs: y",
            checker={"verdict": "SUPPORTED"}, mutation={"catch_rate": None},
        )

    ledger.append_atomic(cc_repo.path, records=[make_record("c1")])
    path = ledger.resolve_ledger_path(cc_repo.path)
    # A crash or an editor ate the newline.
    path.write_bytes(path.read_bytes().rstrip(b"\n"))
    ledger.append_atomic(cc_repo.path, records=[make_record("c2")])
    lines = path.read_text(encoding="utf-8").splitlines()
    assert [json.loads(line_text)["claim_id"] for line_text in lines] == ["c1", "c2"]


# ---- git plumbing -----------------------------------------------------------

def test_non_ascii_paths_come_back_unquoted(repo):
    repo.write("café.py", text="x = 1\n")
    repo.git("add", "-A")
    assert ("A", "café.py") in gitio.list_staged_paths(repo.path)


def test_diff_prefix_config_does_not_change_what_we_parse(repo):
    repo.git("config", "diff.mnemonicPrefix", "true")
    repo.branch("f")
    repo.write("a.py", text="x = 1\n")
    repo.commit("add a")
    diff = gitio.read_diff(repo.path, base="main", worktree=False)
    assert "+++ b/a.py" in diff


def test_missing_base_ref_is_a_clear_error(repo):
    with pytest.raises(ClaimcheckError, match="base ref 'nope' was not found"):
        gitio.count_commits_ahead(repo.path, base="nope")


def test_worktree_diff_includes_untracked_files_but_not_claimcheck(cc_repo):
    cc_repo.branch("f")
    # Never added to git.
    cc_repo.write("fresh.py", text="def h(x, y):\n    return x - y\n")
    diff = gitio.read_diff(cc_repo.path, base="main", worktree=True)
    assert "+++ b/fresh.py" in diff and "return x - y" in diff
    assert ".claimcheck" not in diff
    assert "fresh.py" in gitio.list_changed_files(cc_repo.path, base="main", worktree=True)


def test_repo_root_with_non_ascii_directory(tmp_path, *, monkeypatch):
    entry = tmp_path / "café-proj"
    entry.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=entry, check=True, timeout=SUBPROCESS_TIMEOUT_S)
    assert config.find_repo_root(entry) == entry.resolve()
    # The point is that nothing above raised or returned mojibake.
    assert sys.getdefaultencoding()
