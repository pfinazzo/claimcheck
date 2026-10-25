"""Regressions for bugs found by an independent review: each test reproduces one of them.

@author Patrick Finazzo
"""

from __future__ import annotations

import json
import re
import sys

import pytest

from claimcheck import ClaimcheckError, checker, gitio, hook, ledger
from claimcheck import claims as CL
from claimcheck import config as C
from conftest import SUBPROCESS_TIMEOUT_S

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
def test_config_wrong_types_are_a_clear_error(cc_repo, line, needle):
    cc_repo.write(".claimcheck/config.toml", "version = 1\n" + line + "\n")
    with pytest.raises(ClaimcheckError, match=re.escape(needle)):
        C.load(cc_repo.path)


def test_config_wrong_type_inside_a_table(cc_repo):
    cc_repo.write(".claimcheck/config.toml", 'version = 1\n[mutate]\nmax_mutants = "ten"\n')
    with pytest.raises(ClaimcheckError, match="max_mutants must be a whole number"):
        C.load(cc_repo.path)


def test_config_with_a_bom_loads(cc_repo):
    (cc_repo.cc / "config.toml").write_bytes(b"\xef\xbb\xbf" + b'version = 1\ntest_cmd = "make test"\n')
    assert C.load(cc_repo.path).test_cmd == "make test"


def test_double_star_prefix_matches_the_top_level_too():
    assert C.is_ignored("README.md", ["**/*.md"])
    assert C.is_ignored("a/b/README.md", ["**/*.md"])
    assert C.is_ignored("tests/x.py", ["**/tests/**"])
    assert not C.is_ignored("src/app.py", ["docs/**"])


# ---- hook installation ------------------------------------------------------

def test_hook_goes_where_git_looks_with_hooks_path(repo):
    (repo.path / ".husky").mkdir()
    repo.git("config", "core.hooksPath", ".husky")
    assert hook.install(repo.path) is True
    assert hook.HOOK_MARKER in (repo.path / ".husky" / "pre-commit").read_text(encoding="utf-8")
    assert not (repo.path / ".git" / "hooks" / "pre-commit").exists()


def test_hook_in_a_linked_worktree_uses_the_shared_hooks(repo, tmp_path):
    wt = tmp_path / "wt"
    repo.git("worktree", "add", "-q", str(wt), "-b", "side")
    assert hook.install(wt) is True
    assert hook.hook_file(wt) == hook.hook_file(repo.path)
    assert (repo.path / ".git" / "hooks" / "pre-commit").exists()


def test_hook_line_goes_before_a_trailing_exit(repo):
    path = hook.hook_file(repo.path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/bin/sh\necho lint\nexit 0\n", encoding="utf-8", newline="\n")
    assert hook.install(repo.path) is True
    lines = path.read_text(encoding="utf-8").splitlines()
    assert lines[-1] == "exit 0"
    assert hook.HOOK_MARKER in lines[-2]
    assert hook.install(repo.path) is False  # idempotent


def test_hook_refuses_to_edit_a_non_shell_hook(repo):
    path = hook.hook_file(repo.path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/usr/bin/env python3\nprint('hi')\n", encoding="utf-8", newline="\n")
    with pytest.raises(ClaimcheckError, match="not a shell script"):
        hook.install(repo.path)
    assert path.read_text(encoding="utf-8") == "#!/usr/bin/env python3\nprint('hi')\n"


# ---- claims file ------------------------------------------------------------

def _violations(text):
    cf, v = CL.load_text(text)
    if cf is not None:
        v += CL.validate(cf, {1})
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
    v = _violations(GOOD.replace('claim: "x"', "claim:"))
    assert any("claim text is empty" in x for x in v)
    assert not any("None" in x for x in v)


def test_wrong_field_types_are_violations_not_crashes():
    assert any("criteria must be a list" in x for x in _violations(GOOD.replace("criteria: [1]", "criteria: 1")))
    assert any("files must be a list" in x for x in _violations(GOOD.replace('files: ["a.py"]', "files: a.py")))
    assert any("must be text" in x for x in _violations(GOOD.replace("id: c1", "id: [c1]")))


# ---- checker ----------------------------------------------------------------

class _Seq:
    def __init__(self, *replies):
        self.replies, self.calls = list(replies), 0

    def complete(self, system, user, *, schema):
        self.calls += 1
        return self.replies.pop(0)


def _v(cid, verdict):
    return {"id": cid, "verdict": verdict, "reason": "r", "evidence": []}


def test_duplicate_verdicts_for_one_claim_are_invalid():
    obj = {"verdicts": [_v("c1", "REFUTED"), _v("c1", "SUPPORTED")]}
    assert any("duplicate" in e for e in checker.validate_verdicts(obj, {"c1"}))


def test_a_refutation_in_a_flawed_reply_survives_a_second_flawed_reply():
    first = json.dumps({"verdicts": [_v("c1", "REFUTED")]})  # c2 missing: invalid
    second = "not json at all"
    out = checker.ask(_Seq(first, second), "s", "u", ["c1", "c2"])
    assert out[0]["verdict"] == "REFUTED"
    assert out[1]["verdict"] == "UNVERIFIABLE"


def test_a_refutation_beats_a_support_for_the_same_claim_across_replies():
    first = json.dumps({"verdicts": [_v("c1", "SUPPORTED")]})
    second = json.dumps({"verdicts": [_v("c1", "REFUTED"), _v("c1", "REFUTED")]})
    out = checker.ask(_Seq(first, second), "s", "u", ["c1", "c2"])
    assert out[0]["verdict"] == "REFUTED"


# ---- ledger -----------------------------------------------------------------

def test_append_never_fuses_onto_an_unterminated_last_line(cc_repo):
    def rec(cid):
        return ledger.claim_record(
            ts="t", run_id="r", repo_id="x", base="b", head="h", spec_lock="s", author="a", claim_id=cid,
            claim="c", confidence=0.5, criteria=[1], files=["a.py"], kill_condition="obs: y",
            checker={"verdict": "SUPPORTED"}, mutation={"catch_rate": None},
        )

    ledger.append_atomic(cc_repo.path, [rec("c1")])
    path = ledger.ledger_path(cc_repo.path)
    path.write_bytes(path.read_bytes().rstrip(b"\n"))  # a crash or an editor ate the newline
    ledger.append_atomic(cc_repo.path, [rec("c2")])
    lines = path.read_text(encoding="utf-8").splitlines()
    assert [json.loads(line_text)["claim_id"] for line_text in lines] == ["c1", "c2"]


# ---- git plumbing -----------------------------------------------------------

def test_non_ascii_paths_come_back_unquoted(repo):
    repo.write("café.py", "x = 1\n")
    repo.git("add", "-A")
    assert ("A", "café.py") in gitio.staged_paths(repo.path)


def test_diff_prefix_config_does_not_change_what_we_parse(repo):
    repo.git("config", "diff.mnemonicPrefix", "true")
    repo.branch("f")
    repo.write("a.py", "x = 1\n")
    repo.commit("add a")
    diff = gitio.diff_text(repo.path, "main", worktree=False)
    assert "+++ b/a.py" in diff


def test_missing_base_ref_is_a_clear_error(repo):
    with pytest.raises(ClaimcheckError, match="base ref 'nope' was not found"):
        gitio.commits_ahead(repo.path, "nope")


def test_worktree_diff_includes_untracked_files_but_not_claimcheck(cc_repo):
    cc_repo.branch("f")
    cc_repo.write("fresh.py", "def h(x, y):\n    return x - y\n")  # never added to git
    diff = gitio.diff_text(cc_repo.path, "main", worktree=True)
    assert "+++ b/fresh.py" in diff and "return x - y" in diff
    assert ".claimcheck" not in diff
    assert "fresh.py" in gitio.changed_files(cc_repo.path, "main", worktree=True)


def test_repo_root_with_non_ascii_directory(tmp_path, monkeypatch):
    import subprocess

    d = tmp_path / "café-proj"
    d.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=d, check=True, timeout=SUBPROCESS_TIMEOUT_S)
    assert C.find_repo_root(d) == d.resolve()
    assert sys.getdefaultencoding()  # the point is that nothing above raised or returned mojibake
