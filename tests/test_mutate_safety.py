"""mutate must never leave a planted bug (or a stale lock) behind, and never clobber user edits.

@author Patrick Finazzo
"""

import json
import os
import subprocess
import time

import pytest

from claimcheck import ProviderError, config, mutate
from conftest import CALC_SRC, CLAIMS_FOR_CALC, PY, SUBPROCESS_TIMEOUT_S


def _clean(repo):
    assert not (repo.cc / "mutate.lock").exists()
    assert not (repo.cc / "mutate-backup").exists()


def _run(repo, **kw):
    kw.setdefault("test_cmd", "exit 0")
    return mutate.run_mutate(repo.path, settings=config.load(repo.path), **kw)


def _write_bytes(repo, *, rel_path, data: bytes, message="add file"):
    file_path = repo.path / rel_path
    file_path.parent.mkdir(parents=True, exist_ok=True)
    file_path.write_bytes(data)
    repo.commit(message)
    return file_path


def _install_spy(monkeypatch, *, repo, rel_path, seen, fail_on=None, error=None):
    real = mutate._run_tests

    def record_run(r, *, command, timeout):
        """Record the file as the tests see it, then run them (optionally failing on one call)."""
        seen.append((repo.path / rel_path).read_bytes())
        if fail_on is not None and len(seen) == fail_on:
            raise error
        return real(r, command=command, timeout=timeout)

    monkeypatch.setattr(mutate, "_run_tests", record_run)


# ---- 1: stale .pyc cannot keep a planted bug alive ---------------------------------------

def test_test_command_runs_without_writing_bytecode(calc_repo):
    cmd = f"{PY} -c \"import os, sys; sys.exit(0 if os.environ.get('PYTHONDONTWRITEBYTECODE') == '1' else 1)\""
    outcome, _ = mutate._run_tests(calc_repo.path, command=cmd, timeout=30)
    assert outcome == "survived"


def test_same_size_mutant_leaves_no_pyc_and_original_still_imports(calc_repo, *, monkeypatch):
    # Without the fix, a bytecode-writing test run leaves a .pyc that matches the restored
    # original's (mtime second, size), so a later import keeps running the planted bug.
    monkeypatch.delenv("PYTHONDONTWRITEBYTECODE", raising=False)
    cmd = f"{PY} -c \"import sys; sys.path.insert(0, 'src'); import calc\""
    report, _ = _run(calc_repo, test_cmd=cmd)
    assert any(mutant["mutated"] == "    return a + b" for mutant in report["mutants"])
    assert not list((calc_repo.path / "src").glob("__pycache__/*.pyc"))
    env = {key: value for key, value in os.environ.items() if key != "PYTHONDONTWRITEBYTECODE"}
    output = subprocess.run(
        f"{PY} -c \"import sys; sys.path.insert(0, 'src'); import calc; print(calc.sub(5, 3))\"",
        shell=True, cwd=calc_repo.path, env=env, capture_output=True, text=True, timeout=SUBPROCESS_TIMEOUT_S,
    )
    assert output.stdout.strip() == "2"
    assert (calc_repo.path / "src/calc.py").read_text(encoding="utf-8") == CALC_SRC


def test_restore_puts_the_original_mtime_back(calc_repo):
    file_path = calc_repo.path / "src/calc.py"
    old = time.time_ns() - 5 * 86_400 * 10**9
    os.utime(file_path, ns=(old, old))
    before = file_path.stat().st_mtime_ns
    _run(calc_repo)
    assert file_path.stat().st_mtime_ns == before
    _clean(calc_repo)


def test_each_mutant_gets_its_own_mtime_second(calc_repo, *, monkeypatch):
    file_path = calc_repo.path / "src/calc.py"
    seen: list = []
    real = mutate._run_tests

    def record_run(r, *, command, timeout):
        """Record the file as the tests see it, then run them (optionally failing on one call)."""
        seen.append(int(file_path.stat().st_mtime))
        return real(r, command=command, timeout=timeout)

    monkeypatch.setattr(mutate, "_run_tests", record_run)
    orig = int(file_path.stat().st_mtime)
    _run(calc_repo)
    # The first call is the baseline.
    live = seen[1:]
    assert len(live) == 3 and len(set(live)) == 3 and orig not in live


# ---- 2: no stale lock, no clobbered edits -------------------------------------------------

def test_edit_after_commit_fails_cleanly_before_touching_anything(calc_repo, *, capsys):
    file_path = calc_repo.path / "src/calc.py"
    edited = CALC_SRC.replace("def sub", "# my edit\ndef sub")
    file_path.write_text(edited, encoding="utf-8", newline="\n")
    assert calc_repo.cli("mutate", "--test-cmd", "exit 0") == 5
    err = capsys.readouterr().err
    assert "src/calc.py line " in err and "no longer matches the diff" in err
    assert "commit or stash your edits and rerun" in err
    _clean(calc_repo)
    assert file_path.read_text(encoding="utf-8") == edited
    # Not exit 6: nothing is left locked.
    assert calc_repo.cli("mutate", "--test-cmd", "exit 0") == 5


def test_file_deleted_after_commit_is_a_clear_error(calc_repo):
    (calc_repo.path / "src/calc.py").unlink()
    with pytest.raises(ProviderError, match="src/calc.py line"):
        _run(calc_repo)
    _clean(calc_repo)


def test_non_utf8_file_does_not_crash_and_stays_byte_identical(calc_repo, *, monkeypatch):
    raw = b"x = 1 + 2  # caf\xe9\ny = 3 + 4\n"
    path = _write_bytes(calc_repo, rel_path="src/lat.py", data=raw)
    seen: list = []
    _install_spy(monkeypatch, repo=calc_repo, rel_path="src/lat.py", seen=seen)
    report, _ = _run(calc_repo)
    lat = [mutant for mutant in report["mutants"] if mutant["file"] == "src/lat.py"]
    assert lat and {match["line_no"] for match in lat} == {2}
    assert report["skipped_undecodable"] > 0
    assert path.read_bytes() == raw
    for parsed_raw in seen[1:]:
        assert parsed_raw.startswith(b"x = 1 + 2  # caf\xe9\n")
    _clean(calc_repo)


def test_form_feed_and_line_separator_do_not_shift_line_numbers(calc_repo):
    src = "# a b \x0c c\nz = 1 + 2\n"
    path = _write_bytes(calc_repo, rel_path="src/uni.py", data=src.encode("utf-8"))
    report, _ = _run(calc_repo)
    uni = [mutant for mutant in report["mutants"] if mutant["file"] == "src/uni.py"]
    assert uni and {match["line_no"] for match in uni} == {2}
    assert {found["original"] for found in uni} == {"z = 1 + 2"}
    assert path.read_bytes() == src.encode("utf-8")
    _clean(calc_repo)


def test_added_lines_splits_on_newline_only():
    diff = (
        "diff --git a/u.py b/u.py\n--- a/u.py\n+++ b/u.py\n@@ -0,0 +1,2 @@\n"
        "+a \x0c b   c\n+q = 1 + 2\n"
    )
    assert mutate.list_added_lines(diff, ignore=[]) == [("u.py", 1, "a \x0c b   c"), ("u.py", 2, "q = 1 + 2")]


def test_one_crlf_line_in_an_lf_file_keeps_every_line_ending(calc_repo, *, monkeypatch):
    raw = b"A = 1\nB = 2 + 3\r\nC = 4 + 5\nD = 6 + 7"
    path = _write_bytes(calc_repo, rel_path="src/mix.py", data=raw)
    seen: list = []
    _install_spy(monkeypatch, repo=calc_repo, rel_path="src/mix.py", seen=seen)
    report, _ = _run(calc_repo)
    mix = [mutant for mutant in report["mutants"] if mutant["file"] == "src/mix.py"]
    assert {match["line_no"] for match in mix} == {1, 2, 3, 4}
    for parsed_raw in seen[1:]:
        assert parsed_raw.count(b"\r\n") == 1 and parsed_raw.count(b"\n") == 3
        assert parsed_raw.split(b"\n")[1].endswith(b"\r") and not parsed_raw.endswith(b"\n")
    assert path.read_bytes() == raw
    _clean(calc_repo)


def test_crlf_file_mutants_keep_crlf(calc_repo, *, monkeypatch):
    raw = b"A = 1 + 2\r\nB = 3\r\n"
    path = _write_bytes(calc_repo, rel_path="src/crlf.py", data=raw)
    seen: list = []
    _install_spy(monkeypatch, repo=calc_repo, rel_path="src/crlf.py", seen=seen)
    _run(calc_repo)
    for parsed_raw in seen[1:]:
        assert parsed_raw.count(b"\r\n") == 2 and parsed_raw.count(b"\n") == 2
    assert path.read_bytes() == raw


@pytest.mark.parametrize("exc", [KeyboardInterrupt(), RuntimeError("boom")])
def test_interrupt_or_crash_restores_and_removes_the_lock(calc_repo, *, monkeypatch, exc):
    seen: list = []
    real = mutate._run_tests
    _install_spy(monkeypatch, repo=calc_repo, rel_path="src/calc.py", seen=seen, fail_on=3, error=exc)
    with pytest.raises(type(exc)):
        _run(calc_repo)
    assert calc_repo.read("src/calc.py") == CALC_SRC
    _clean(calc_repo)
    monkeypatch.setattr(mutate, "_run_tests", real)
    # No exit 6.
    assert calc_repo.cli("mutate", "--test-cmd", "exit 0") == 0


def test_failed_restore_leaves_lock_so_restore_can_recover(calc_repo, *, monkeypatch):
    def fail_loudly(path, *, original, times):
        raise OSError("disk says no")

    monkeypatch.setattr(mutate, "_reset_file", fail_loudly)
    with pytest.raises(OSError):
        _run(calc_repo, max_mutants=1)
    assert (calc_repo.cc / "mutate.lock").exists() and (calc_repo.cc / "mutate-backup").exists()


# ---- 2(iv): --restore never overwrites what the run did not write -------------------------

def _run_crash_with_mutant_in_place(calc_repo, *, monkeypatch):
    real = mutate._reset_file
    monkeypatch.setattr(mutate, "_reset_file", lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError("no")))
    with pytest.raises(OSError):
        _run(calc_repo, max_mutants=1)
    monkeypatch.setattr(mutate, "_reset_file", real)
    assert calc_repo.read("src/calc.py") != CALC_SRC


def test_restore_puts_back_a_file_that_still_holds_the_mutant(calc_repo, *, monkeypatch, capsys):
    _run_crash_with_mutant_in_place(calc_repo, monkeypatch=monkeypatch)
    assert calc_repo.cli("mutate", "--restore") == 0
    assert json.loads(capsys.readouterr().out) == {"restored": ["src/calc.py"]}
    assert calc_repo.read("src/calc.py") == CALC_SRC
    _clean(calc_repo)


def test_restore_refuses_to_overwrite_the_users_newer_edit(calc_repo, *, monkeypatch, capsys):
    _run_crash_with_mutant_in_place(calc_repo, monkeypatch=monkeypatch)
    mine = CALC_SRC + "# my newer work\n"
    (calc_repo.path / "src/calc.py").write_text(mine, encoding="utf-8", newline="\n")
    # A refused file is not a success.
    assert calc_repo.cli("mutate", "--restore") == 6
    cap = capsys.readouterr()
    assert json.loads(cap.out) == {"restored": [], "refused": True}
    assert "not restoring src/calc.py" in cap.err and "changed since the run" in cap.err
    assert calc_repo.read("src/calc.py") == mine
    assert (calc_repo.cc / "mutate-backup" / "src" / "calc.py").exists()
    assert (calc_repo.cc / "mutate.lock").exists()


def test_restore_leaves_a_file_that_is_already_the_original(calc_repo, *, monkeypatch, capsys):
    _run_crash_with_mutant_in_place(calc_repo, monkeypatch=monkeypatch)
    (calc_repo.path / "src/calc.py").write_text(CALC_SRC, encoding="utf-8", newline="\n")
    assert calc_repo.cli("mutate", "--restore") == 0
    assert json.loads(capsys.readouterr().out) == {"restored": []}
    assert calc_repo.read("src/calc.py") == CALC_SRC
    _clean(calc_repo)


def test_restore_without_a_record_refuses_rather_than_guesses(calc_repo, *, capsys):
    (calc_repo.cc / "mutate.lock").write_text("stale\n", encoding="utf-8")
    part = calc_repo.cc / "mutate-backup" / "src" / "calc.py"
    part.parent.mkdir(parents=True)
    part.write_text("OLD\n", encoding="utf-8")
    calc_repo.write("src/calc.py", text="NEW\n")
    assert calc_repo.cli("mutate", "--restore") == 6
    assert "not restoring src/calc.py" in capsys.readouterr().err
    assert calc_repo.read("src/calc.py") == "NEW\n"
    assert part.exists()


# ---- 3: timeouts actually fire on a process tree ------------------------------------------

def test_timeout_kills_the_process_tree_at_about_the_timeout(tmp_path):
    marker = tmp_path / "alive.txt"
    code = (
        "import time, pathlib; "
        f"time.sleep(6); pathlib.Path(r'{marker.as_posix()}').write_text('x')"
    )
    cmd = f'{PY} -c "{code}"'
    t0 = time.monotonic()
    outcome, dur = mutate._run_tests(tmp_path, command=cmd, timeout=2)
    wall = time.monotonic() - t0
    assert outcome == "timeout"
    assert wall < 5.5, f"timeout was not enforced (took {wall:.1f}s)"
    # Long enough for a surviving grandchild to finish its sleep.
    time.sleep(5)
    assert not marker.exists(), "the grandchild test process outlived the timeout"


def test_ordinary_pass_and_fail_still_work(tmp_path):
    assert mutate._run_tests(tmp_path, command="exit 0", timeout=30)[0] == "survived"
    assert mutate._run_tests(tmp_path, command="exit 3", timeout=30)[0] == "killed"


# ---- 4: a `+++ ` content line is never a file header --------------------------------------

def test_plus_plus_line_in_an_ignored_hunk_does_not_hijack_the_next_hunk():
    diff = (
        "diff --git a/notes.md b/notes.md\n"
        "--- a/notes.md\n"
        "+++ b/notes.md\n"
        "@@ -1,2 +1,3 @@\n"
        " intro\n"
        "-- old\n"
        "+++ plus plus\n"
        "+text\n"
        "@@ -10,1 +11,2 @@\n"
        " ctx\n"
        "+total = a + 1\n"
    )
    assert mutate.list_added_lines(diff, ignore=["*.md"]) == []
    diff2 = diff.replace("notes.md", "code.py")
    got = mutate.list_added_lines(diff2, ignore=[])
    assert ("code.py", 12, "total = a + 1") in got
    assert all(file_path == "code.py" for file_path, _, _ in got)


def test_second_file_after_an_ignored_one_is_still_attributed_correctly():
    diff = (
        "diff --git a/a.md b/a.md\n--- a/a.md\n+++ b/a.md\n@@ -1 +1,2 @@\n x\n+++ plus plus\n"
        "diff --git a/b.py b/b.py\n--- a/b.py\n+++ b/b.py\n@@ -1 +1,2 @@\n y\n+total = a + 1\n"
    )
    assert mutate.list_added_lines(diff, ignore=["*.md"]) == [("b.py", 2, "total = a + 1")]


def test_quoted_header_paths_are_decoded():
    diff = (
        'diff --git "a/caf\\303\\251.py" "b/caf\\303\\251.py"\n--- "a/caf\\303\\251.py"\n'
        '+++ "b/caf\\303\\251.py"\n@@ -0,0 +1 @@\n+a = 1 + 2\n'
    )
    assert mutate.list_added_lines(diff, ignore=[]) == [("café.py", 1, "a = 1 + 2")]


# ---- 5: a leading BOM is not part of the first word ---------------------------------------

def test_bom_is_stripped_from_line_one_before_generating_mutants():
    diff = (
        "diff --git a/b.py b/b.py\n--- /dev/null\n+++ b/b.py\n@@ -0,0 +1,2 @@\n"
        "+﻿def g(x, y):\n+    return x\n"
    )
    added = mutate.list_added_lines(diff, ignore=[])
    assert added[0] == ("b.py", 1, "def g(x, y):")
    assert mutate.collect(diff, ignore=[]) == []


def test_bom_file_is_mutated_without_equivalent_swap_and_keeps_its_bom(calc_repo, *, monkeypatch):
    raw = b"\xef\xbb\xbfdef g(x, y):\n    return x - y\n"
    path = _write_bytes(calc_repo, rel_path="src/bom.py", data=raw)
    seen: list = []
    _install_spy(monkeypatch, repo=calc_repo, rel_path="src/bom.py", seen=seen)
    report, _ = _run(calc_repo)
    bom = [mutant for mutant in report["mutants"] if mutant["file"] == "src/bom.py"]
    assert bom and {match["line_no"] for match in bom} == {2}
    assert not any("def g(y, x)" in found["mutated"] for found in bom)
    assert all(entry.startswith(b"\xef\xbb\xbfdef g(x, y):\n") for entry in seen)
    assert path.read_bytes() == raw


# ---- 6: a claim with nothing to mutate is not silently green ------------------------------

def _add_empty_claim(calc_repo):
    extra = CLAIMS_FOR_CALC + (
        '  - id: c3\n    claim: "docs only"\n    confidence: 0.5\n    criteria: [1]\n'
        '    files: ["docs/readme.md"]\n    kill_condition: "obs: read it"\n    verified_by: ["obs: read it"]\n'
    )
    calc_repo.write(".claimcheck/claims.yaml", text=extra)
    calc_repo.commit("claim with no code")


def test_zero_candidate_claim_reports_candidates_and_warns_when_gated(calc_repo, *, capsys):
    _add_empty_claim(calc_repo)
    cfg = calc_repo.read(".claimcheck/config.toml").replace("min_catch_rate = 0.0", "min_catch_rate = 0.5")
    calc_repo.write(".claimcheck/config.toml", text=cfg)
    calc_repo.commit("gate")
    # Exit codes unchanged (c1 and c2 survive)
    assert calc_repo.cli("mutate", "--test-cmd", "exit 0") == 2
    cap = capsys.readouterr()
    output = json.loads(cap.out)
    assert output["per_claim"]["c3"]["candidates"] == 0
    assert output["per_claim"]["c3"]["catch_rate"] is None
    assert output["per_claim"]["c1"]["candidates"] == 3
    assert "claim c3" in cap.err and "mutation candidate" in cap.err
    assert "claim c1" not in cap.err
    # Old keys still there.
    for key in ("total", "killed", "survived", "timeout", "catch_rate"):
        assert key in output["per_claim"]["c3"]


def test_zero_candidate_claim_is_quiet_when_not_gated(calc_repo, *, capsys):
    _add_empty_claim(calc_repo)
    assert calc_repo.cli("mutate", "--test-cmd", "exit 0") == 0
    cap = capsys.readouterr()
    assert json.loads(cap.out)["per_claim"]["c3"]["candidates"] == 0
    assert "warning" not in cap.err
