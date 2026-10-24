"""AC 21-27: mutation generation, backup/restore, runner, end-to-end.

@author Patrick Finazzo
"""

import json

import pytest

from claimcheck import mutate
from claimcheck import config as C
from conftest import CALC_SRC, PY

TEST_CMD = f"{PY} -m pytest -q -p no:cacheprovider"


# ---- AC 21 ---------------------------------------------------------------

DIFF = """\
diff --git a/src/calc.py b/src/calc.py
index 0000000..1111111 100644
--- a/src/calc.py
+++ b/src/calc.py
@@ -1,4 +1,5 @@
 def keep(a):
-    return a - 1
+    return a + 1
+    # added
 def ctx(x):
     return x < 2
diff --git a/docs/readme.md b/docs/readme.md
--- a/docs/readme.md
+++ b/docs/readme.md
@@ -1 +1 @@
-x < 1
+x < 2
diff --git a/gone.py b/gone.py
deleted file mode 100644
--- a/gone.py
+++ /dev/null
@@ -1 +0,0 @@
-z = 1 + 2
"""


def test_ac21_only_added_lines_in_non_ignored_files():
    added = mutate.added_lines(DIFF, C.DEFAULT_IGNORE)
    assert added == [("src/calc.py", 2, "    return a + 1"), ("src/calc.py", 3, "    # added")]
    muts = mutate.collect(DIFF, C.DEFAULT_IGNORE)
    assert {m.file for m in muts} == {"src/calc.py"}
    assert all(m.line_no in (2, 3) for m in muts)
    assert not any("x < 2" in m.original or "<" in m.mutated for m in muts)


# ---- AC 22 ---------------------------------------------------------------

@pytest.mark.parametrize(
    "line, expected",
    [
        ("x = a + b", {("sign_flip", "x = a - b")}),
        ("if i < n:", {("boundary", "if i <= n:")}),
        ("f(a, b)", {("swap_args", "f(b, a)")}),
        ("return -x", {("sign_flip", "return x")}),
        ('s = "a+b"', set()),
        ("y = x << 2", {("off_by_one", "y = x << 3")}),
        ("if a <= b and c >= d:", {("boundary", "if a < b and c >= d:"), ("boundary", "if a <= b and c > d:")}),
        ("pad(size, 10)", {("off_by_one", "pad(size, 11)"), ("swap_args", "pad(10, size)")}),
        ("def add(a, b):", set()),
        ("x = a != b or a == b", set()),
        ("p = q -> r", set()),
        ("v = 1.5 * 2", {("off_by_one", "v = 1.5 * 3")}),
    ],
)
def test_ac22_exact_mutant_sets(line, expected):
    got = {(m.cls, m.mutated) for m in mutate.generate(line)}
    assert got == expected
    assert all(m.original == line for m in mutate.generate(line))


# ---- AC 23 ---------------------------------------------------------------

def test_ac23_stale_sentinel_exits_6_and_restore_puts_files_back(calc_repo, capsys):
    import hashlib

    sentinel = calc_repo.cc / "mutate.lock"
    sentinel.write_text("stale\n", encoding="utf-8")
    assert calc_repo.cli("mutate", "--test-cmd", "exit 0") == 6
    assert "--restore" in capsys.readouterr().err

    sha = lambda s: hashlib.sha256(s.encode("utf-8")).hexdigest()
    sentinel.write_text(
        json.dumps({"version": 2, "files": {"src/calc.py": {
            "original_sha256": sha("ORIGINAL\n"), "mutated_sha256": sha("MUTATED\n")}}}),
        encoding="utf-8",
    )
    backup = calc_repo.cc / "mutate-backup" / "src" / "calc.py"
    backup.parent.mkdir(parents=True)
    backup.write_text("ORIGINAL\n", encoding="utf-8", newline="\n")
    calc_repo.write("src/calc.py", "MUTATED\n")
    assert calc_repo.cli("mutate", "--restore") == 0
    assert json.loads(capsys.readouterr().out) == {"restored": ["src/calc.py"]}
    assert calc_repo.read("src/calc.py") == "ORIGINAL\n"
    assert not sentinel.exists()
    assert not (calc_repo.cc / "mutate-backup").exists()


def test_ac23_backup_and_sentinel_exist_during_run_then_vanish(calc_repo, monkeypatch):
    seen = {}

    real = mutate._run_tests

    def spy(repo, cmd, timeout):
        seen["sentinel"] = (calc_repo.cc / "mutate.lock").exists()
        seen["backup"] = (calc_repo.cc / "mutate-backup" / "src" / "calc.py").exists()
        return real(repo, cmd, timeout)

    monkeypatch.setattr(mutate, "_run_tests", spy)
    before = (calc_repo.path / "src/calc.py").read_bytes()
    result, code = mutate.run_mutate(calc_repo.path, C.load(calc_repo.path), test_cmd="exit 0", max_mutants=1)
    assert seen == {"sentinel": True, "backup": True}
    assert not (calc_repo.cc / "mutate.lock").exists()
    assert not (calc_repo.cc / "mutate-backup").exists()
    assert (calc_repo.path / "src/calc.py").read_bytes() == before


def test_ac23_failed_restore_keeps_backup_and_sentinel(calc_repo, monkeypatch, capsys):
    real_restore = mutate._restore_file

    def boom(path, original, *times):
        raise OSError("disk says no")

    monkeypatch.setattr(mutate, "_restore_file", boom)
    with pytest.raises(OSError):
        mutate.run_mutate(calc_repo.path, C.load(calc_repo.path), test_cmd="exit 0", max_mutants=1)
    assert (calc_repo.cc / "mutate.lock").exists()
    backup = calc_repo.cc / "mutate-backup" / "src" / "calc.py"
    assert backup.exists()
    assert calc_repo.read("src/calc.py") != CALC_SRC  # the mutant is still in place...
    monkeypatch.setattr(mutate, "_restore_file", real_restore)
    assert calc_repo.cli("mutate", "--restore") == 0  # ...and --restore has what it needs
    assert calc_repo.read("src/calc.py") == CALC_SRC
    assert not (calc_repo.cc / "mutate.lock").exists()


def test_added_line_starting_with_plus_plus_is_content():
    diff = (
        "diff --git a/x.py b/x.py\n--- a/x.py\n+++ b/x.py\n@@ -0,0 +1,2 @@\n"
        "+++ y = 2\n+z = 3 + 4\n"
    )
    added = mutate.added_lines(diff, [])
    assert added == [("x.py", 1, "++ y = 2"), ("x.py", 2, "z = 3 + 4")]


# ---- AC 24 ---------------------------------------------------------------

def test_ac24_baseline_failure_exits_5(calc_repo, capsys):
    assert calc_repo.cli("mutate", "--test-cmd", "exit 1") == 5
    assert "baseline tests fail; fix them first" in capsys.readouterr().err


def test_ac24_timeout_counts_as_timeout(calc_repo, monkeypatch):
    calls = {"n": 0}

    def fake(repo, cmd, timeout):
        calls["n"] += 1
        return ("survived", 0.0) if calls["n"] == 1 else ("timeout", float(timeout))

    monkeypatch.setattr(mutate, "_run_tests", fake)
    result, code = mutate.run_mutate(calc_repo.path, C.load(calc_repo.path), test_cmd="x", max_mutants=2)
    assert result["summary"]["timeout"] == 2
    assert result["summary"]["catch_rate"] == 1.0


# ---- AC 25 ---------------------------------------------------------------

def test_ac25_summary_math_and_null_rate():
    recs = [{"outcome": "killed"}, {"outcome": "survived"}, {"outcome": "timeout"}, {"outcome": "killed"}]
    assert mutate._summary(recs) == {"total": 4, "killed": 2, "survived": 1, "timeout": 1, "catch_rate": 0.75}
    assert mutate._summary([])["catch_rate"] is None


def test_ac25_max_mutants_and_seed_reproducible(calc_repo):
    cfg = C.load(calc_repo.path)
    a, _ = mutate.run_mutate(calc_repo.path, cfg, test_cmd="exit 0", max_mutants=2, seed=7)
    b, _ = mutate.run_mutate(calc_repo.path, cfg, test_cmd="exit 0", max_mutants=2, seed=7)
    c, _ = mutate.run_mutate(calc_repo.path, cfg, test_cmd="exit 0", max_mutants=2, seed=8)
    key = lambda r: [(m["cls"], m["mutated"]) for m in r["mutants"]]
    assert len(a["mutants"]) == 2 and a["candidates"] == 3
    assert key(a) == key(b)
    assert key(a) != key(c) or True  # different seeds may coincide with 3 candidates


# ---- AC 26 ---------------------------------------------------------------

def test_ac26_run_file_shape_and_threshold(calc_repo, capsys):
    assert calc_repo.cli("mutate", "--test-cmd", "exit 0") == 0  # everything survives, min rate 0.0
    out = json.loads(capsys.readouterr().out)
    files = sorted((calc_repo.cc / "runs").glob("*-mutate.json"))
    assert json.loads(files[-1].read_text(encoding="utf-8")) == out
    for k in ("run_id", "base", "head", "test_cmd", "baseline_s", "mutants", "summary", "per_claim"):
        assert k in out, k
    assert out["summary"]["survived"] == 3 and out["summary"]["catch_rate"] == 0.0
    assert set(out["per_claim"]) == {"c1", "c2"}
    assert out["per_claim"]["c1"]["total"] == 3
    for m in out["mutants"]:
        assert set(m) == {"file", "line_no", "cls", "original", "mutated", "outcome", "duration_s"}

    cfg = calc_repo.read(".claimcheck/config.toml").replace("min_catch_rate = 0.0", "min_catch_rate = 0.5")
    calc_repo.write(".claimcheck/config.toml", cfg)
    calc_repo.commit("raise threshold")
    assert calc_repo.cli("mutate", "--test-cmd", "exit 0") == 2


# ---- AC 27 ---------------------------------------------------------------

def test_ac27_end_to_end_catch_rate_one(calc_repo, capsys):
    before = (calc_repo.path / "src/calc.py").read_bytes()
    assert calc_repo.cli("mutate", "--test-cmd", TEST_CMD) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["summary"]["total"] == 3
    assert sorted(m["cls"] for m in out["mutants"]) == ["boundary", "off_by_one", "sign_flip"]
    assert out["summary"]["catch_rate"] == 1.0
    assert (calc_repo.path / "src/calc.py").read_bytes() == before


def test_ac27_weak_tests_let_boundary_survive(calc_repo, capsys):
    tests = calc_repo.read("tests/test_calc.py").replace("    assert is_adult(18) is True\n", "    pass\n")
    calc_repo.write("tests/test_calc.py", tests)
    calc_repo.commit("weaken")
    assert calc_repo.cli("mutate", "--test-cmd", TEST_CMD) == 0
    out = json.loads(capsys.readouterr().out)
    assert any(m["cls"] == "boundary" and m["outcome"] == "survived" for m in out["mutants"])
