"""AC 4-8: criteria parsing, freeze, verify, late-addition rules.

@author Patrick Finazzo
"""

import json
import re

import pytest

from claimcheck import SpecError
from claimcheck import spec as S
from conftest import TWO_CRITERIA_SPEC

# ---- AC 4 ----------------------------------------------------------------

def test_ac4_parse_ok():
    crit = S.parse_criteria(TWO_CRITERIA_SPEC)
    assert [c["id"] for c in crit] == [1, 2]
    assert crit[0]["text"].startswith("sub(a, b)")


@pytest.mark.parametrize(
    "text, needle",
    [
        ("- [ ] 1. a\n- [ ] 1. b\n", "duplicate criterion ids: [1]"),
        ("- [ ] 1. a\n- [ ] 3. b\n", "offending ids: [2, 3]"),
        ("- [ ] 2. a\n- [ ] 3. b\n", "offending ids: [1, 3]"),
        ("# nothing here\n", "zero criteria"),
    ],
)
def test_ac4_parse_errors(text, needle, repo):
    repo.cli("init")
    repo.write(".claimcheck/spec.md", text)
    with pytest.raises(SpecError) as e:
        S.parse_criteria(text)
    assert needle in str(e.value)
    assert repo.cli("spec", "freeze") == 3


def test_ac4_checked_box_counts():
    assert len(S.parse_criteria("- [x] 1. done\n- [X] 2. also\n")) == 2


# ---- AC 5 ----------------------------------------------------------------

def test_ac5_lock_shape(cc_repo):
    lock = json.loads(cc_repo.read(".claimcheck/spec.lock"))
    assert lock["version"] == 1
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", lock["frozen_at"])
    assert re.fullmatch(r"[0-9a-f]{40}", lock["git_head"])
    assert re.fullmatch(r"[0-9a-f]{64}", lock["spec_sha256"])
    assert [c["id"] for c in lock["criteria"]] == [1, 2]
    for c in lock["criteria"]:
        assert re.fullmatch(r"[0-9a-f]{64}", c["sha256"])
    crit = S.parse_criteria(TWO_CRITERIA_SPEC)
    assert lock["criteria"][0]["sha256"] == crit[0]["sha256"]


def test_ac5_refreeze_clean_overwrites(cc_repo):
    first = json.loads(cc_repo.read(".claimcheck/spec.lock"))
    assert cc_repo.cli("spec", "freeze") == 0
    second = json.loads(cc_repo.read(".claimcheck/spec.lock"))
    assert second["criteria"] == first["criteria"]
    assert second["git_head"] == cc_repo.sha()


def test_ac5_refreeze_refused_when_code_is_dirty(cc_repo, capsys):
    # A new, untracked code file is an open diff.
    cc_repo.write("x.py", "x = 1\n")
    assert cc_repo.cli("spec", "freeze") == 3
    assert "refusing to re-freeze with an open diff" in capsys.readouterr().err


def test_ac5_refreeze_allowed_when_only_the_spec_and_docs_changed(cc_repo):
    """A second task in the same repo: edit the spec, freeze again. This used to be impossible."""
    cc_repo.branch("task-two")
    cc_repo.write(".claimcheck/spec.md", TWO_CRITERIA_SPEC + "- [ ] 3. A third thing.\n")
    cc_repo.write("README.md", "# docs changed\n")
    assert cc_repo.cli("spec", "freeze") == 0
    assert [c["id"] for c in json.loads(cc_repo.read(".claimcheck/spec.lock"))["criteria"]] == [1, 2, 3]
    cc_repo.commit("freeze task two")
    assert cc_repo.cli("spec", "verify") == 0


def test_ac5_second_freeze_after_a_spec_only_commit_on_the_branch(cc_repo):
    cc_repo.branch("task-two")
    cc_repo.write(".claimcheck/spec.md", TWO_CRITERIA_SPEC + "- [ ] 3. A third thing.\n")
    # One commit ahead of the base, but no code in it.
    cc_repo.commit("spec only")
    assert cc_repo.cli("spec", "freeze") == 0


def test_spec_hash_ignores_bom_and_crlf(cc_repo):
    """A Windows checkout (autocrlf) or an editor that adds a BOM must not look like drift."""
    raw = cc_repo.read(".claimcheck/spec.md")
    (cc_repo.cc / "spec.md").write_bytes(b"\xef\xbb\xbf" + raw.replace("\n", "\r\n").encode("utf-8"))
    assert cc_repo.cli("spec", "verify") == 0


def test_lock_is_written_with_lf_newlines(cc_repo):
    assert b"\r\n" not in (cc_repo.cc / "spec.lock").read_bytes()


def test_ac5_refreeze_refused_when_ahead_of_base(cc_repo, capsys):
    cc_repo.branch("feat")
    cc_repo.write("x.py", "x = 1\n")
    cc_repo.commit("ahead")
    assert cc_repo.cli("spec", "freeze") == 3
    assert "refusing to re-freeze with an open diff" in capsys.readouterr().err


# ---- AC 6 ----------------------------------------------------------------

def test_ac6_verify_ok(cc_repo):
    assert cc_repo.cli("spec", "verify") == 0


def test_ac6_late_addition(cc_repo, capsys):
    cc_repo.write(".claimcheck/spec.md", TWO_CRITERIA_SPEC + "- [ ] 3. sneaky\n")
    assert cc_repo.cli("spec", "verify") == 3
    assert "late addition: [3]" in capsys.readouterr().err


def test_ac6_modified(cc_repo, capsys):
    cc_repo.write(".claimcheck/spec.md", TWO_CRITERIA_SPEC.replace("for ints", "for floats"))
    assert cc_repo.cli("spec", "verify") == 3
    assert "modified: [1]" in capsys.readouterr().err


def test_ac6_removed(cc_repo, capsys):
    one = "\n".join(line_text for line_text in TWO_CRITERIA_SPEC.splitlines() if not line_text.startswith("- [ ] 2.")) + "\n"
    cc_repo.write(".claimcheck/spec.md", one)
    assert cc_repo.cli("spec", "verify") == 3
    assert "removed: [2]" in capsys.readouterr().err


# ---- AC 7 ----------------------------------------------------------------

def test_ac7_lock_refrozen_inside_diff_refused(calc_repo, capsys):
    # The diff's first commit is dated 2020; now an agent hand-edits spec + lock and commits.
    calc_repo.write(".claimcheck/spec.md", TWO_CRITERIA_SPEC + "- [ ] 3. added late\n")
    text, crit = S.read_spec(calc_repo.path)
    # Frozen_at = now (> 2020)
    lock = S.build_lock(calc_repo.path, text, crit)
    calc_repo.write(".claimcheck/spec.lock", json.dumps(lock, indent=2, sort_keys=True) + "\n")
    calc_repo.commit("late criterion", date="2020-01-06T00:00:00+00:00")
    # Spec and lock agree with each other...
    assert calc_repo.cli("spec", "verify") == 0
    # ...but the lock moved inside the diff.
    assert calc_repo.cli("check", "--provider", "stub") == 3
    err = capsys.readouterr().err
    assert "re-frozen" in err and "late criteria: [3]" in err
    assert calc_repo.cli("mutate", "--test-cmd", "exit 0") == 3


def test_ac7_cli_base_overrides_config_base(calc_repo, capsys):
    # Config says base = feat (so there are no commits "ahead" of it); the CLI measures against main.
    cfg = calc_repo.read(".claimcheck/config.toml").replace('base = "main"', 'base = "feat"')
    calc_repo.write(".claimcheck/config.toml", cfg)
    calc_repo.write(".claimcheck/spec.md", TWO_CRITERIA_SPEC + "- [ ] 3. added late\n")
    text, crit = S.read_spec(calc_repo.path)
    lock = S.build_lock(calc_repo.path, text, crit)
    calc_repo.write(".claimcheck/spec.lock", json.dumps(lock, indent=2, sort_keys=True) + "\n")
    calc_repo.commit("late criterion + config", date="2020-01-06T00:00:00+00:00")
    assert calc_repo.cli("check", "--provider", "stub", "--base", "main") == 3
    assert "late criteria: [3]" in capsys.readouterr().err
    assert calc_repo.cli("mutate", "--test-cmd", "exit 0", "--base", "main") == 3
    assert calc_repo.cli("run", "--provider", "stub", "--test-cmd", "exit 0", "--base", "main") == 3


# ---- AC 8 ----------------------------------------------------------------

def test_ac8_uncommitted_spec_change_refused(calc_repo, capsys):
    calc_repo.write(".claimcheck/spec.md", TWO_CRITERIA_SPEC + "\nextra prose\n")
    assert calc_repo.cli("check", "--provider", "stub") == 3
    assert "uncommitted change to" in capsys.readouterr().err


def test_ac8_staged_lock_change_refused(calc_repo, capsys):
    lock = json.loads(calc_repo.read(".claimcheck/spec.lock"))
    lock["frozen_at"] = "2030-01-01T00:00:00Z"
    calc_repo.write(".claimcheck/spec.lock", json.dumps(lock) + "\n")
    calc_repo.git("add", ".claimcheck/spec.lock")
    assert calc_repo.cli("mutate", "--test-cmd", "exit 0") == 3
    assert ".claimcheck/spec.lock" in capsys.readouterr().err
