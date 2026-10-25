"""mutate must never leave a planted bug (or a stale lock) behind, and never clobber user edits.

@author Patrick Finazzo
"""

import json
import os
import subprocess
import time

import pytest

from claimcheck import ProviderError, mutate
from claimcheck import config as C
from conftest import CALC_SRC, CLAIMS_FOR_CALC, PY, SUBPROCESS_TIMEOUT_S


def _clean(repo):
    assert not (repo.cc / "mutate.lock").exists()
    assert not (repo.cc / "mutate-backup").exists()


def _run(repo, **kw):
    kw.setdefault("test_cmd", "exit 0")
    return mutate.run_mutate(repo.path, C.load(repo.path), **kw)


def _write_bytes(repo, rel, data: bytes, msg="add file"):
    p = repo.path / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data)
    repo.commit(msg)
    return p


def _spy(monkeypatch, repo, rel, seen, fail_on=None, exc=None):
    real = mutate._run_tests

    def spy(r, cmd, timeout):
        """Record the file as the tests see it, then run them (optionally failing on one call)."""
        seen.append((repo.path / rel).read_bytes())
        if fail_on is not None and len(seen) == fail_on:
            raise exc
        return real(r, cmd, timeout)

    monkeypatch.setattr(mutate, "_run_tests", spy)


# ---- 1: stale .pyc cannot keep a planted bug alive ---------------------------------------

def test_test_command_runs_without_writing_bytecode(calc_repo):
    cmd = f"{PY} -c \"import os, sys; sys.exit(0 if os.environ.get('PYTHONDONTWRITEBYTECODE') == '1' else 1)\""
    outcome, _ = mutate._run_tests(calc_repo.path, cmd, 30)
    assert outcome == "survived"


def test_same_size_mutant_leaves_no_pyc_and_original_still_imports(calc_repo, monkeypatch):
    # Without the fix, a bytecode-writing test run leaves a .pyc that matches the restored
    # original's (mtime second, size), so a later import keeps running the planted bug.
    monkeypatch.delenv("PYTHONDONTWRITEBYTECODE", raising=False)
    cmd = f"{PY} -c \"import sys; sys.path.insert(0, 'src'); import calc\""
    result, _ = _run(calc_repo, test_cmd=cmd)
    assert any(m["mutated"] == "    return a + b" for m in result["mutants"])
    assert not list((calc_repo.path / "src").glob("__pycache__/*.pyc"))
    env = {k: v for k, v in os.environ.items() if k != "PYTHONDONTWRITEBYTECODE"}
    out = subprocess.run(
        f"{PY} -c \"import sys; sys.path.insert(0, 'src'); import calc; print(calc.sub(5, 3))\"",
        shell=True, cwd=calc_repo.path, env=env, capture_output=True, text=True, timeout=SUBPROCESS_TIMEOUT_S,
    )
    assert out.stdout.strip() == "2"
    assert (calc_repo.path / "src/calc.py").read_text(encoding="utf-8") == CALC_SRC


def test_restore_puts_the_original_mtime_back(calc_repo):
    p = calc_repo.path / "src/calc.py"
    old = time.time_ns() - 5 * 86_400 * 10**9
    os.utime(p, ns=(old, old))
    before = p.stat().st_mtime_ns
    _run(calc_repo)
    assert p.stat().st_mtime_ns == before
    _clean(calc_repo)


def test_each_mutant_gets_its_own_mtime_second(calc_repo, monkeypatch):
    p = calc_repo.path / "src/calc.py"
    seen: list = []
    real = mutate._run_tests

    def spy(r, cmd, timeout):
        """Record the file as the tests see it, then run them (optionally failing on one call)."""
        seen.append(int(p.stat().st_mtime))
        return real(r, cmd, timeout)

    monkeypatch.setattr(mutate, "_run_tests", spy)
    orig = int(p.stat().st_mtime)
    _run(calc_repo)
    # The first call is the baseline.
    live = seen[1:]
    assert len(live) == 3 and len(set(live)) == 3 and orig not in live


# ---- 2: no stale lock, no clobbered edits -------------------------------------------------

def test_edit_after_commit_fails_cleanly_before_touching_anything(calc_repo, capsys):
    p = calc_repo.path / "src/calc.py"
    edited = CALC_SRC.replace("def sub", "# my edit\ndef sub")
    p.write_text(edited, encoding="utf-8", newline="\n")
    assert calc_repo.cli("mutate", "--test-cmd", "exit 0") == 5
    err = capsys.readouterr().err
    assert "src/calc.py line " in err and "no longer matches the diff" in err
    assert "commit or stash your edits and rerun" in err
    _clean(calc_repo)
    assert p.read_text(encoding="utf-8") == edited
    # Not exit 6: nothing is left locked.
    assert calc_repo.cli("mutate", "--test-cmd", "exit 0") == 5


def test_file_deleted_after_commit_is_a_clear_error(calc_repo):
    (calc_repo.path / "src/calc.py").unlink()
    with pytest.raises(ProviderError, match="src/calc.py line"):
        _run(calc_repo)
    _clean(calc_repo)


def test_non_utf8_file_does_not_crash_and_stays_byte_identical(calc_repo, monkeypatch):
    raw = b"x = 1 + 2  # caf\xe9\ny = 3 + 4\n"
    p = _write_bytes(calc_repo, "src/lat.py", raw)
    seen: list = []
    _spy(monkeypatch, calc_repo, "src/lat.py", seen)
    result, _ = _run(calc_repo)
    lat = [m for m in result["mutants"] if m["file"] == "src/lat.py"]
    assert lat and {m["line_no"] for m in lat} == {2}
    assert result["skipped_undecodable"] > 0
    assert p.read_bytes() == raw
    for data in seen[1:]:
        assert data.startswith(b"x = 1 + 2  # caf\xe9\n")
    _clean(calc_repo)


def test_form_feed_and_line_separator_do_not_shift_line_numbers(calc_repo):
    src = "# a b \x0c c\nz = 1 + 2\n"
    p = _write_bytes(calc_repo, "src/uni.py", src.encode("utf-8"))
    result, _ = _run(calc_repo)
    uni = [m for m in result["mutants"] if m["file"] == "src/uni.py"]
    assert uni and {m["line_no"] for m in uni} == {2}
    assert {m["original"] for m in uni} == {"z = 1 + 2"}
    assert p.read_bytes() == src.encode("utf-8")
    _clean(calc_repo)


def test_added_lines_splits_on_newline_only():
    diff = (
        "diff --git a/u.py b/u.py\n--- a/u.py\n+++ b/u.py\n@@ -0,0 +1,2 @@\n"
        "+a \x0c b   c\n+q = 1 + 2\n"
    )
    assert mutate.added_lines(diff, []) == [("u.py", 1, "a \x0c b   c"), ("u.py", 2, "q = 1 + 2")]


def test_one_crlf_line_in_an_lf_file_keeps_every_line_ending(calc_repo, monkeypatch):
    raw = b"A = 1\nB = 2 + 3\r\nC = 4 + 5\nD = 6 + 7"
    p = _write_bytes(calc_repo, "src/mix.py", raw)
    seen: list = []
    _spy(monkeypatch, calc_repo, "src/mix.py", seen)
    result, _ = _run(calc_repo)
    mix = [m for m in result["mutants"] if m["file"] == "src/mix.py"]
    assert {m["line_no"] for m in mix} == {1, 2, 3, 4}
    for data in seen[1:]:
        assert data.count(b"\r\n") == 1 and data.count(b"\n") == 3
        assert data.split(b"\n")[1].endswith(b"\r") and not data.endswith(b"\n")
    assert p.read_bytes() == raw
    _clean(calc_repo)


def test_crlf_file_mutants_keep_crlf(calc_repo, monkeypatch):
    raw = b"A = 1 + 2\r\nB = 3\r\n"
    p = _write_bytes(calc_repo, "src/crlf.py", raw)
    seen: list = []
    _spy(monkeypatch, calc_repo, "src/crlf.py", seen)
    _run(calc_repo)
    for data in seen[1:]:
        assert data.count(b"\r\n") == 2 and data.count(b"\n") == 2
    assert p.read_bytes() == raw


@pytest.mark.parametrize("exc", [KeyboardInterrupt(), RuntimeError("boom")])
def test_interrupt_or_crash_restores_and_removes_the_lock(calc_repo, monkeypatch, exc):
    seen: list = []
    real = mutate._run_tests
    _spy(monkeypatch, calc_repo, "src/calc.py", seen, fail_on=3, exc=exc)
    with pytest.raises(type(exc)):
        _run(calc_repo)
    assert calc_repo.read("src/calc.py") == CALC_SRC
    _clean(calc_repo)
    monkeypatch.setattr(mutate, "_run_tests", real)
    # No exit 6.
    assert calc_repo.cli("mutate", "--test-cmd", "exit 0") == 0


def test_failed_restore_leaves_lock_so_restore_can_recover(calc_repo, monkeypatch):
    def boom(path, original, *times):
        raise OSError("disk says no")

    monkeypatch.setattr(mutate, "_restore_file", boom)
    with pytest.raises(OSError):
        _run(calc_repo, max_mutants=1)
    assert (calc_repo.cc / "mutate.lock").exists() and (calc_repo.cc / "mutate-backup").exists()


# ---- 2(iv): --restore never overwrites what the run did not write -------------------------

def _crash_with_mutant_in_place(calc_repo, monkeypatch):
    real = mutate._restore_file
    monkeypatch.setattr(mutate, "_restore_file", lambda *a: (_ for _ in ()).throw(OSError("no")))
    with pytest.raises(OSError):
        _run(calc_repo, max_mutants=1)
    monkeypatch.setattr(mutate, "_restore_file", real)
    assert calc_repo.read("src/calc.py") != CALC_SRC


def test_restore_puts_back_a_file_that_still_holds_the_mutant(calc_repo, monkeypatch, capsys):
    _crash_with_mutant_in_place(calc_repo, monkeypatch)
    assert calc_repo.cli("mutate", "--restore") == 0
    assert json.loads(capsys.readouterr().out) == {"restored": ["src/calc.py"]}
    assert calc_repo.read("src/calc.py") == CALC_SRC
    _clean(calc_repo)


def test_restore_refuses_to_overwrite_the_users_newer_edit(calc_repo, monkeypatch, capsys):
    _crash_with_mutant_in_place(calc_repo, monkeypatch)
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


def test_restore_leaves_a_file_that_is_already_the_original(calc_repo, monkeypatch, capsys):
    _crash_with_mutant_in_place(calc_repo, monkeypatch)
    (calc_repo.path / "src/calc.py").write_text(CALC_SRC, encoding="utf-8", newline="\n")
    assert calc_repo.cli("mutate", "--restore") == 0
    assert json.loads(capsys.readouterr().out) == {"restored": []}
    assert calc_repo.read("src/calc.py") == CALC_SRC
    _clean(calc_repo)


def test_restore_without_a_record_refuses_rather_than_guesses(calc_repo, capsys):
    (calc_repo.cc / "mutate.lock").write_text("stale\n", encoding="utf-8")
    b = calc_repo.cc / "mutate-backup" / "src" / "calc.py"
    b.parent.mkdir(parents=True)
    b.write_text("OLD\n", encoding="utf-8")
    calc_repo.write("src/calc.py", "NEW\n")
    assert calc_repo.cli("mutate", "--restore") == 6
    assert "not restoring src/calc.py" in capsys.readouterr().err
    assert calc_repo.read("src/calc.py") == "NEW\n"
    assert b.exists()


# ---- 3: timeouts actually fire on a process tree ------------------------------------------

def test_timeout_kills_the_process_tree_at_about_the_timeout(tmp_path):
    marker = tmp_path / "alive.txt"
    code = (
        "import time, pathlib; "
        f"time.sleep(6); pathlib.Path(r'{marker.as_posix()}').write_text('x')"
    )
    cmd = f'{PY} -c "{code}"'
    t0 = time.monotonic()
    outcome, dur = mutate._run_tests(tmp_path, cmd, 2)
    wall = time.monotonic() - t0
    assert outcome == "timeout"
    assert wall < 5.5, f"timeout was not enforced (took {wall:.1f}s)"
    # Long enough for a surviving grandchild to finish its sleep.
    time.sleep(5)
    assert not marker.exists(), "the grandchild test process outlived the timeout"


def test_ordinary_pass_and_fail_still_work(tmp_path):
    assert mutate._run_tests(tmp_path, "exit 0", 30)[0] == "survived"
    assert mutate._run_tests(tmp_path, "exit 3", 30)[0] == "killed"


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
    assert mutate.added_lines(diff, ["*.md"]) == []
    diff2 = diff.replace("notes.md", "code.py")
    got = mutate.added_lines(diff2, [])
    assert ("code.py", 12, "total = a + 1") in got
    assert all(f == "code.py" for f, _, _ in got)


def test_second_file_after_an_ignored_one_is_still_attributed_correctly():
    diff = (
        "diff --git a/a.md b/a.md\n--- a/a.md\n+++ b/a.md\n@@ -1 +1,2 @@\n x\n+++ plus plus\n"
        "diff --git a/b.py b/b.py\n--- a/b.py\n+++ b/b.py\n@@ -1 +1,2 @@\n y\n+total = a + 1\n"
    )
    assert mutate.added_lines(diff, ["*.md"]) == [("b.py", 2, "total = a + 1")]


def test_quoted_header_paths_are_decoded():
    diff = (
        'diff --git "a/caf\\303\\251.py" "b/caf\\303\\251.py"\n--- "a/caf\\303\\251.py"\n'
        '+++ "b/caf\\303\\251.py"\n@@ -0,0 +1 @@\n+a = 1 + 2\n'
    )
    assert mutate.added_lines(diff, []) == [("café.py", 1, "a = 1 + 2")]


# ---- 5: a leading BOM is not part of the first word ---------------------------------------

def test_bom_is_stripped_from_line_one_before_generating_mutants():
    diff = (
        "diff --git a/b.py b/b.py\n--- /dev/null\n+++ b/b.py\n@@ -0,0 +1,2 @@\n"
        "+﻿def g(x, y):\n+    return x\n"
    )
    added = mutate.added_lines(diff, [])
    assert added[0] == ("b.py", 1, "def g(x, y):")
    assert mutate.collect(diff, []) == []


def test_bom_file_is_mutated_without_equivalent_swap_and_keeps_its_bom(calc_repo, monkeypatch):
    raw = b"\xef\xbb\xbfdef g(x, y):\n    return x - y\n"
    p = _write_bytes(calc_repo, "src/bom.py", raw)
    seen: list = []
    _spy(monkeypatch, calc_repo, "src/bom.py", seen)
    result, _ = _run(calc_repo)
    bom = [m for m in result["mutants"] if m["file"] == "src/bom.py"]
    assert bom and {m["line_no"] for m in bom} == {2}
    assert not any("def g(y, x)" in m["mutated"] for m in bom)
    assert all(d.startswith(b"\xef\xbb\xbfdef g(x, y):\n") for d in seen)
    assert p.read_bytes() == raw


# ---- 6: a claim with nothing to mutate is not silently green ------------------------------

def _with_empty_claim(calc_repo):
    extra = CLAIMS_FOR_CALC + (
        '  - id: c3\n    claim: "docs only"\n    confidence: 0.5\n    criteria: [1]\n'
        '    files: ["docs/readme.md"]\n    kill_condition: "obs: read it"\n    verified_by: ["obs: read it"]\n'
    )
    calc_repo.write(".claimcheck/claims.yaml", extra)
    calc_repo.commit("claim with no code")


def test_zero_candidate_claim_reports_candidates_and_warns_when_gated(calc_repo, capsys):
    _with_empty_claim(calc_repo)
    cfg = calc_repo.read(".claimcheck/config.toml").replace("min_catch_rate = 0.0", "min_catch_rate = 0.5")
    calc_repo.write(".claimcheck/config.toml", cfg)
    calc_repo.commit("gate")
    # Exit codes unchanged (c1 and c2 survive)
    assert calc_repo.cli("mutate", "--test-cmd", "exit 0") == 2
    cap = capsys.readouterr()
    out = json.loads(cap.out)
    assert out["per_claim"]["c3"]["candidates"] == 0
    assert out["per_claim"]["c3"]["catch_rate"] is None
    assert out["per_claim"]["c1"]["candidates"] == 3
    assert "claim c3" in cap.err and "mutation candidate" in cap.err
    assert "claim c1" not in cap.err
    # Old keys still there.
    for k in ("total", "killed", "survived", "timeout", "catch_rate"):
        assert k in out["per_claim"]["c3"]


def test_zero_candidate_claim_is_quiet_when_not_gated(calc_repo, capsys):
    _with_empty_claim(calc_repo)
    assert calc_repo.cli("mutate", "--test-cmd", "exit 0") == 0
    cap = capsys.readouterr()
    assert json.loads(cap.out)["per_claim"]["c3"]["candidates"] == 0
    assert "warning" not in cap.err
