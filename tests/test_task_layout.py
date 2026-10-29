"""The tasks layout: each task keeps its spec, lock, claims and ledger in its own folder.

Two pull requests then never write the same claimcheck file, so merging both needs no conflict
resolution and no second claimcheck run.

@author Patrick Finazzo
"""

from __future__ import annotations

import io
import json
import types

import pytest

from claimcheck import agentdocs, config, gitio, ledger
from conftest import CALC_CONFTEST, CALC_SRC, CALC_TESTS, PY

TEST_CMD = f"{PY} -m pytest -q -p no:cacheprovider"

NO_TASK_ON_MAIN = (
    "claimcheck keeps each task's files in .claimcheck/tasks/<branch>/. You are on main, which is not a task. "
    "Switch to a task branch, or run claimcheck spec draft to start one."
)

CALC_CLAIMS = """\
version: 1
author: "test-agent"
base: "main"
claims:
  - id: c1
    claim: "sub returns a minus b"
    confidence: 0.9
    criteria: [1]
    files: ["src/calc.py"]
    kill_condition: "test: tests/test_calc.py::test_sub"
    verified_by: ["cmd: pytest -q"]
"""


def _make_draft(goal: str) -> dict:
    return {
        "goal": goal,
        "rounds": [],
        "criteria": [{"text": "sub(a, b) returns a - b for ints.", "check": "Run the tests."}],
        "out_of_scope": [],
    }


def _finish_draft(repo: types.SimpleNamespace, *, goal: str, monkeypatch: pytest.MonkeyPatch, branch: str | None = None) -> int:
    """Runs `spec draft --finish` with the draft on stdin, as an agent does."""
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(_make_draft(goal))))
    return repo.cli("spec", "draft", "--finish", *(["--branch", branch] if branch else []))


@pytest.fixture
def tasks_repo(repo: types.SimpleNamespace, *, monkeypatch: pytest.MonkeyPatch) -> types.SimpleNamespace:
    """init in a new repo, which picks the tasks layout, committed on main with tests for calc."""
    monkeypatch.delenv(config.TASK_ENV, raising=False)
    assert repo.cli("init") == 0
    repo.write("conftest.py", text=CALC_CONFTEST)
    repo.write("tests/test_calc.py", text=CALC_TESTS)
    repo.commit("set up claimcheck", date="2020-01-02T00:00:00+00:00")
    return repo


def _task_dir(repo: types.SimpleNamespace, *, name: str):
    return repo.cc / "tasks" / name


# ---- the layout setting -----------------------------------------------------------------------

def test_init_writes_the_tasks_layout_for_a_new_repo_and_no_top_level_task_files(tasks_repo):
    assert 'layout = "tasks"' in tasks_repo.read(".claimcheck/config.toml")
    assert config.load(tasks_repo.path)["layout"] == "tasks"
    for name in ("spec.md", "spec.lock", "claims.yaml", "ledger.jsonl"):
        assert not (tasks_repo.cc / name).exists(), name


def test_init_leaves_an_existing_config_without_a_layout_as_it_was(repo):
    original = 'version = 1\nbase = "main"\n'
    repo.write(".claimcheck/config.toml", text=original)
    assert repo.cli("init") == 0
    assert repo.read(".claimcheck/config.toml") == original
    assert config.load(repo.path)["layout"] == "single"
    assert (repo.cc / "spec.md").exists()


def test_an_unknown_layout_is_refused_by_name(repo, *, capsys):
    repo.write(".claimcheck/config.toml", text='version = 1\nlayout = "flat"\n')
    assert repo.cli("spec", "verify") != 0
    assert """invalid config.toml: layout must be "single" or "tasks" (got 'flat')""" in capsys.readouterr().err


def test_a_branch_name_becomes_one_safe_folder_name():
    assert config.to_task_name("feat/login") == "feat-login"
    assert config.to_task_name("feat/x y") == "feat-x-y"
    assert config.to_task_name("v1.2_fix-a") == "v1.2_fix-a"
    assert config.to_task_name("feat/login") == config.to_task_name("feat/login")
    for unsafe in ("..", ".", ""):
        with pytest.raises(config.SpecError):
            config.to_task_name(unsafe)


# ---- starting a task --------------------------------------------------------------------------

def test_finishing_a_draft_on_main_makes_the_branch_first_and_writes_into_its_folder(tasks_repo, *, monkeypatch):
    assert _finish_draft(tasks_repo, goal="Add sub", monkeypatch=monkeypatch) == 0
    assert gitio.read_current_branch(tasks_repo.path) == "task/add-sub"
    folder = _task_dir(tasks_repo, name="task-add-sub")
    assert (folder / "spec.md").is_file() and (folder / "spec.lock").is_file()
    assert not (tasks_repo.cc / "spec.md").exists() and not (tasks_repo.cc / "spec.lock").exists()
    assert tasks_repo.git("status", "--porcelain") == ""
    assert tasks_repo.cli("spec", "verify") == 0


def test_a_task_folder_the_base_already_has_is_refused(tasks_repo, *, monkeypatch, capsys):
    assert _finish_draft(tasks_repo, goal="Add sub", monkeypatch=monkeypatch, branch="feat-a") == 0
    tasks_repo.git("checkout", "-q", "main")
    tasks_repo.git("merge", "-q", "--no-ff", "--no-verify", "-m", "merge feat-a", "feat-a")
    capsys.readouterr()
    assert _finish_draft(tasks_repo, goal="Again", monkeypatch=monkeypatch, branch="feat/a") == 3
    assert "A task folder .claimcheck/tasks/feat-a already exists on main. Pick another branch name." in capsys.readouterr().err
    monkeypatch.setenv(config.TASK_ENV, "feat-a")
    assert _finish_draft(tasks_repo, goal="Once more", monkeypatch=monkeypatch, branch="other-name") == 3
    assert "A task folder .claimcheck/tasks/feat-a already exists on main." in capsys.readouterr().err


def test_claimcheck_task_names_the_folder_while_a_branch_is_still_made(tasks_repo, *, monkeypatch):
    monkeypatch.setenv(config.TASK_ENV, "ci/task one")
    assert _finish_draft(tasks_repo, goal="Add sub", monkeypatch=monkeypatch) == 0
    assert gitio.read_current_branch(tasks_repo.path) == "task/add-sub"
    assert (_task_dir(tasks_repo, name="ci-task-one") / "spec.md").is_file()
    assert not _task_dir(tasks_repo, name="task-add-sub").exists()


# ---- no task on the base branch ---------------------------------------------------------------

def test_task_commands_on_main_stop_with_exit_3_and_say_why(tasks_repo, *, capsys):
    for command in (("spec", "freeze"), ("spec", "verify"), ("claims", "validate")):
        capsys.readouterr()
        assert tasks_repo.cli(*command) == 3, command
        assert NO_TASK_ON_MAIN in capsys.readouterr().err
    assert not (tasks_repo.cc / "tasks").exists()


def test_task_commands_on_a_detached_head_stop_with_exit_3(tasks_repo, *, capsys):
    tasks_repo.git("checkout", "-q", "--detach")
    assert tasks_repo.cli("spec", "verify") == 3
    assert "You are on detached HEAD, which is not a task." in capsys.readouterr().err


def test_verify_ledger_status_and_init_work_without_a_task(tasks_repo, *, capsys):
    for where in ("main", "--detach"):
        tasks_repo.git("checkout", "-q", where)
        assert tasks_repo.cli("verify-ledger") == 0
        assert tasks_repo.cli("verify-ledger", "--base", "main") == 0
        assert tasks_repo.cli("status") == 0
        assert tasks_repo.cli("init") == 0


def test_the_hook_lets_a_commit_on_main_through_with_a_note(tasks_repo):
    tasks_repo.write("src/calc.py", text=CALC_SRC)
    outcome = tasks_repo.try_commit("code straight on main")
    assert outcome.returncode == 0, outcome.stderr
    assert "claimcheck: not on a task branch, so no claims are checked for this commit." in outcome.stderr


def test_an_empty_claimcheck_task_counts_as_unset(tasks_repo, *, monkeypatch, capsys):
    monkeypatch.setenv(config.TASK_ENV, "")
    assert tasks_repo.cli("spec", "verify") == 3
    assert NO_TASK_ON_MAIN in capsys.readouterr().err


def test_claimcheck_task_names_a_task_on_a_detached_head(tasks_repo, *, monkeypatch, capsys):
    tasks_repo.write(".claimcheck/tasks/feat-a/spec.md", text="# Acceptance criteria\n\n- [ ] 1. sub works.\n")
    tasks_repo.commit("a task folder")
    tasks_repo.git("checkout", "-q", "--detach")
    monkeypatch.setenv(config.TASK_ENV, "feat/a")
    assert config.resolve_task_dir(tasks_repo.path) == tasks_repo.cc / "tasks" / "feat-a"
    assert tasks_repo.cli("spec", "verify") == 3
    assert "missing .claimcheck/tasks/feat-a/spec.lock; run `claimcheck spec freeze`" in capsys.readouterr().err


def test_a_task_with_no_spec_says_which_file_is_missing(tasks_repo, *, monkeypatch, capsys):
    monkeypatch.setenv(config.TASK_ENV, "pr-branch")
    assert tasks_repo.cli("spec", "verify") == 3
    assert "missing .claimcheck/tasks/pr-branch/spec.md; run `claimcheck spec draft`" in capsys.readouterr().err


def test_the_single_layout_ignores_claimcheck_task(cc_repo, *, monkeypatch):
    monkeypatch.setenv(config.TASK_ENV, "feat-a")
    assert config.resolve_task_dir(cc_repo.path) == cc_repo.cc
    assert cc_repo.cli("spec", "verify") == 0


# ---- a task's own files -----------------------------------------------------------------------

def _start_calc_task(repo: types.SimpleNamespace, *, branch: str, monkeypatch: pytest.MonkeyPatch) -> types.SimpleNamespace:
    """A frozen task on `branch` that adds calc and claims it, committed."""
    assert _finish_draft(repo, goal=f"Add sub on {branch}", monkeypatch=monkeypatch, branch=branch) == 0
    folder = f".claimcheck/tasks/{config.to_task_name(branch)}"
    repo.write("src/calc.py", text=CALC_SRC)
    repo.write(f"{folder}/claims.yaml", text=CALC_CLAIMS)
    repo.commit(f"add calc on {branch}")
    return types.SimpleNamespace(folder=folder)


def test_a_run_on_a_task_uses_only_that_task_folder(tasks_repo, *, monkeypatch):
    tasks_repo.write(".claimcheck/tasks/other/claims.yaml", text="not: [valid")
    tasks_repo.commit("another task's broken claims on main")
    task = _start_calc_task(tasks_repo, branch="feat-a", monkeypatch=monkeypatch)
    config_path = tasks_repo.cc / "config.toml"
    config_path.write_text(config_path.read_text(encoding="utf-8").replace("fail_on_unverifiable = true", "fail_on_unverifiable = false"), encoding="utf-8")
    tasks_repo.commit("report unverifiable claims only")
    assert tasks_repo.cli("claims", "validate") == 0
    assert tasks_repo.cli("run", "--provider", "stub", "--test-cmd", TEST_CMD) == 0
    lines = tasks_repo.read(f"{task.folder}/ledger.jsonl").splitlines()
    assert [json.loads(line)["claim_id"] for line in lines] == ["c1"]
    assert not (tasks_repo.cc / "ledger.jsonl").exists()
    assert not (tasks_repo.cc / "tasks" / "other" / "ledger.jsonl").exists()


def test_the_hook_asks_for_the_task_claims_file(tasks_repo, *, monkeypatch):
    assert _finish_draft(tasks_repo, goal="Add sub", monkeypatch=monkeypatch, branch="feat-a") == 0
    tasks_repo.write("src/calc.py", text=CALC_SRC)
    refused = tasks_repo.try_commit("code with no claims")
    assert refused.returncode != 0
    assert ".claimcheck/tasks/feat-a/claims.yaml is not staged" in refused.stderr
    tasks_repo.write(".claimcheck/tasks/feat-a/claims.yaml", text=CALC_CLAIMS)
    assert tasks_repo.try_commit("code with claims").returncode == 0


def test_a_refreeze_after_the_diff_began_is_refused_in_the_task_folder(tasks_repo, *, monkeypatch, capsys):
    # The task's first commits are dated in the past, so a freeze made now comes after the diff began.
    monkeypatch.setenv("GIT_AUTHOR_DATE", "2020-01-05T00:00:00+00:00")
    task = _start_calc_task(tasks_repo, branch="feat-a", monkeypatch=monkeypatch)
    monkeypatch.delenv("GIT_AUTHOR_DATE")
    spec_path = tasks_repo.path / task.folder / "spec.md"
    spec_path.write_text(spec_path.read_text(encoding="utf-8") + "- [ ] 2. A late criterion.\n", encoding="utf-8")
    (tasks_repo.path / task.folder / "spec.lock").unlink()
    assert tasks_repo.cli("spec", "freeze") == 0
    tasks_repo.commit("re-freeze late", date="2030-01-01T00:00:00+00:00")
    capsys.readouterr()
    assert tasks_repo.cli("check", "--provider", "stub") == 3
    assert "spec.lock was re-frozen" in capsys.readouterr().err


def _make_claim_record() -> dict:
    return ledger.build_claim_record(
        timestamp="2026-01-01T00:00:00Z", run_id="r1", repo_id="x" * 64, base="b", head="h", spec_lock="s",
        author="a", claim_id="c1", claim="claim c1", confidence=0.5, criteria=[1],
        files=["src/calc.py"], kill_condition="obs: y", checker={"verdict": "SUPPORTED"}, mutation={"catch_rate": None},
    )


def test_each_task_ledger_starts_its_own_chain(tasks_repo, *, monkeypatch):
    record = _make_claim_record()
    for branch in ("feat-a", "feat-b"):
        tasks_repo.git("checkout", "-q", "main")
        assert _finish_draft(tasks_repo, goal=f"Task {branch}", monkeypatch=monkeypatch, branch=branch) == 0
        ledger.append_atomic(tasks_repo.path, records=[record])
        first = json.loads(tasks_repo.read(f".claimcheck/tasks/{branch}/ledger.jsonl").splitlines()[0])
        assert first["prev"] == ledger.ZERO_HASH
        assert tasks_repo.cli("verify-ledger") == 0


# ---- two pull requests ------------------------------------------------------------------------

def test_two_tasks_from_one_base_merge_with_no_conflict(tasks_repo, *, monkeypatch):
    for branch in ("feat-a", "feat-b"):
        tasks_repo.git("checkout", "-q", "main")
        _start_calc_task(tasks_repo, branch=branch, monkeypatch=monkeypatch)
        tasks_repo.write(f"src/{branch}.py", text="VALUE = 1\n")
        ledger.append_atomic(tasks_repo.path, records=[_make_claim_record()])
        tasks_repo.commit(f"{branch} work and its run")
    tasks_repo.git("checkout", "-q", "main")
    tasks_repo.git("merge", "-q", "--no-ff", "--no-verify", "-m", "merge a", "feat-a")
    outcome = tasks_repo.git("merge", "--no-ff", "--no-verify", "-m", "merge b", "feat-b", check=False)
    claimcheck_conflicts = [path for path in tasks_repo.git("diff", "--name-only", "--diff-filter=U").splitlines() if path.startswith(".claimcheck/")]
    assert claimcheck_conflicts == [], outcome
    assert (tasks_repo.cc / "tasks" / "feat-a" / "ledger.jsonl").is_file()
    assert (tasks_repo.cc / "tasks" / "feat-b" / "ledger.jsonl").is_file()


# ---- verify-ledger across tasks ---------------------------------------------------------------

def test_a_broken_task_ledger_fails_verify_ledger_and_is_named(tasks_repo, *, monkeypatch, capsys):
    for branch in ("feat-a", "feat-b"):
        tasks_repo.git("checkout", "-q", "main")
        assert _finish_draft(tasks_repo, goal=f"Task {branch}", monkeypatch=monkeypatch, branch=branch) == 0
        ledger.append_atomic(tasks_repo.path, records=[_make_claim_record(), _make_claim_record()])
    path = tasks_repo.cc / "tasks" / "feat-a" / "ledger.jsonl"
    lines = path.read_text(encoding="utf-8").splitlines()
    path.write_text("\n".join([lines[0].replace("claim c1", "claim edited"), lines[1]]) + "\n", encoding="utf-8")
    capsys.readouterr()
    assert tasks_repo.cli("verify-ledger") == 8
    assert ".claimcheck/tasks/feat-a/ledger.jsonl: ledger line 2" in capsys.readouterr().err


def test_verify_ledger_base_wants_every_task_ledger_to_only_grow(tasks_repo, *, monkeypatch, capsys):
    assert _finish_draft(tasks_repo, goal="Task a", monkeypatch=monkeypatch, branch="feat-a") == 0
    ledger.append_atomic(tasks_repo.path, records=[_make_claim_record()])
    tasks_repo.commit("a run")
    tasks_repo.git("checkout", "-q", "main")
    tasks_repo.git("merge", "-q", "--no-ff", "--no-verify", "-m", "merge a", "feat-a")
    tasks_repo.branch("feat-b")
    monkeypatch.setenv(config.TASK_ENV, "feat-a")
    ledger.append_atomic(tasks_repo.path, records=[_make_claim_record()])
    assert tasks_repo.cli("verify-ledger", "--base", "main") == 0
    (tasks_repo.cc / "tasks" / "feat-a" / "ledger.jsonl").unlink()
    capsys.readouterr()
    assert tasks_repo.cli("verify-ledger", "--base", "main") == 8
    assert ".claimcheck/tasks/feat-a/ledger.jsonl: 1 line(s) from the end of the ledger at main are gone" in capsys.readouterr().err


def test_verify_ledger_still_guards_the_old_top_level_ledger(tasks_repo, *, capsys):
    tasks_repo.write(".claimcheck/ledger.jsonl", text=json.dumps({**_make_claim_record(), "prev": ledger.ZERO_HASH}, sort_keys=True) + "\n")
    tasks_repo.commit("an old ledger from the single layout")
    tasks_repo.branch("feat-a")
    (tasks_repo.cc / "ledger.jsonl").write_text("", encoding="utf-8")
    assert tasks_repo.cli("verify-ledger", "--base", "main") == 8
    assert ".claimcheck/ledger.jsonl: 1 line(s) from the end" in capsys.readouterr().err


def test_the_old_top_level_files_are_never_written(tasks_repo, *, monkeypatch):
    old_files = {".claimcheck/spec.md": "# old\n\n- [ ] 1. old.\n", ".claimcheck/spec.lock": "{}\n", ".claimcheck/claims.yaml": "claims: []\n", ".claimcheck/ledger.jsonl": ""}
    for rel, text in old_files.items():
        tasks_repo.write(rel, text=text)
    tasks_repo.commit("old single-layout files")
    task = _start_calc_task(tasks_repo, branch="feat-a", monkeypatch=monkeypatch)
    ledger.append_atomic(tasks_repo.path, records=[_make_claim_record()])
    assert tasks_repo.cli("claims", "validate") == 0
    assert (tasks_repo.path / task.folder / "ledger.jsonl").is_file()
    for rel, text in old_files.items():
        assert tasks_repo.read(rel) == text, rel


# ---- what the agent is told -------------------------------------------------------------------

def test_the_agent_block_names_the_task_folder_in_the_tasks_layout(tasks_repo):
    block = agentdocs.build_block(layout="tasks")
    assert "`.claimcheck/tasks/<task>/spec.lock`" in block and "`.claimcheck/tasks/<task>/claims.yaml`" in block
    assert "`.claimcheck/spec.lock`" not in block and "`.claimcheck/claims.yaml`" not in block
    assert "In this repo each task's files live in `.claimcheck/tasks/<task>/`. `<task>` is your branch name\n" in block
    assert "with every character outside A-Z, a-z, 0-9, `.`, `_` and `-` turned into `-`.\n" in block
    assert agentdocs.build_block() == agentdocs.build_block(layout="single")
    tasks_repo.write("CLAUDE.md", text="# repo\n")
    agentdocs.install(tasks_repo.path)
    assert "`.claimcheck/tasks/<task>/spec.md`" in tasks_repo.read("CLAUDE.md")
