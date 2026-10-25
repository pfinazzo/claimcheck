"""`init` as a whole: the setup core, plain and JSON modes, machine commands, the terminal toolkit,
the Claude CLI provider, and the guided onboarding run end to end with a scripted terminal.

@author Patrick Finazzo
"""

from __future__ import annotations

import builtins
import io
import json
import re
import subprocess
import sys
import types

import pytest
import yaml

from claimcheck import (
    ProviderError,
    ci,
    gitio,
    initflow,
    onboard,
    providers,
    tui,
)
from claimcheck import config as C
from claimcheck.providers import claude_cli
from claimcheck.providers.stub import make_stub_provider

# ---- setup core -------------------------------------------------------------

def test_run_setup_does_everything_and_reports_it(repo):
    repo.write("package.json", '{"scripts": {"test": "vitest run"}}')
    repo.write("CLAUDE.md", "# rules\n")
    r = initflow.run_setup(repo.path, ci_provider="github")
    assert r["stack"] == {"name": "node", "test_cmd": "npm test", "others": []}
    assert r["hook"]["status"] == "installed" and r["config"] == "created"
    assert ".claimcheck/mutate.lock" in r["gitignore_added"]
    assert r["agent_docs"] == [{"path": "CLAUDE.md", "action": "added"}]
    assert r["ci"] == {"path": ".github/workflows/claimcheck.yml", "action": "created"}
    cfg = C.load(repo.path)
    assert cfg["test_cmd"] == "npm test" and "*.test.*" in cfg["ignore"] and cfg["checker_provider"] == "auto"
    assert "claimcheck:begin" in repo.read("CLAUDE.md")
    assert "claimcheck run" in repo.read(".github/workflows/claimcheck.yml")
    manifest = json.loads(repo.read(".claimcheck/setup.json"))["files"]
    assert set(manifest) == {".gitignore", "CLAUDE.md", ".github/workflows/claimcheck.yml"}


def test_run_setup_is_idempotent_and_never_overwrites(repo):
    initflow.run_setup(repo.path)
    repo.write(".claimcheck/config.toml", 'version = 1\ntest_cmd = "make check"\n')
    second = initflow.run_setup(repo.path)
    assert second["created"] == [] and second["config"] == "exists" and second["hook"]["status"] == "present"
    assert second["gitignore_added"] == [] and C.load(repo.path)["test_cmd"] == "make check"


def test_run_setup_uses_a_typed_test_command(repo):
    r = initflow.run_setup(repo.path, test_cmd="just test")
    assert r["stack"]["test_cmd"] == "just test"


def test_run_setup_can_create_the_agent_file_only_when_asked(repo):
    assert initflow.run_setup(repo.path)["agent_docs"] == []
    r = initflow.run_setup(repo.path, create_agent_doc="claude")
    assert r["agent_docs"] == [{"path": "CLAUDE.md", "action": "created"}]


def test_the_workflow_file_is_valid_yaml_with_a_working_expression():
    data = yaml.safe_load(ci.render("node"))
    steps = data["jobs"]["claimcheck"]["steps"]
    run_step = next(s for s in steps if "claimcheck run" in s.get("run", ""))
    assert "${{ github.base_ref }}" in run_step["run"]
    assert run_step["env"]["ANTHROPIC_API_KEY"] == "${{ secrets.ANTHROPIC_API_KEY }}"
    assert steps[0]["with"]["fetch-depth"] == 0


# ---- CLI: plain, json, status, machine commands ------------------------------

def test_init_plain_mode_prints_a_summary_and_the_next_step(repo, capsys):
    assert repo.cli("init", "--yes") == 0
    err = capsys.readouterr().err
    assert "hook installed" in err and "claimcheck spec draft" in err and "test command is" in err


def test_init_json_is_one_document_on_stdout(repo, capsys):
    assert repo.cli("init", "--json") == 0
    out = json.loads(capsys.readouterr().out)
    assert out["next"] == "write_spec" and out["hook"]["status"] == "installed" and out["repo"]


def test_status_before_and_after(repo, capsys):
    assert repo.cli("status", "--json") == 0
    before = json.loads(capsys.readouterr().out)
    assert before["initialized"] is False and before["spec"] == "none" and before["hook"] is False
    repo.cli("init", "--json")
    capsys.readouterr()
    repo.cli("status", "--json")
    after = json.loads(capsys.readouterr().out)
    assert after["initialized"] is True and after["spec"] == "none" and after["hook"] is True and after["branch"] == "main"


def test_spec_draft_step_and_finish_machine_protocol(repo, monkeypatch, capsys):
    repo.cli("init", "--json")
    capsys.readouterr()
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps({"goal": "Add free shipping over 50"})))
    assert repo.cli("spec", "draft", "--step", "--provider", "stub") == 0
    step = json.loads(capsys.readouterr().out)
    assert len(step["questions"]) == 2 and step["criteria"][0]["text"] and step["ready"] is False and "lint" in step

    draft = {"goal": "Add free shipping over 50", "criteria": step["criteria"], "rounds": [], "out_of_scope": []}
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(draft)))
    assert repo.cli("spec", "draft", "--finish") == 0
    done = json.loads(capsys.readouterr().out)
    assert done["frozen"] and done["branch"].startswith("task/") and len(done["lock_sha256"]) == 64 and done["commit"]
    assert gitio.current_branch(repo.path) == done["branch"]


def test_machine_errors_come_back_as_json_with_the_exit_code(repo, monkeypatch, capsys):
    monkeypatch.setattr("sys.stdin", io.StringIO("{not json"))
    code = repo.cli("spec", "draft", "--step", "--provider", "stub")
    out = json.loads(capsys.readouterr().out)
    assert code == 1 and out["code"] == 1 and "not valid JSON" in out["error"]


def test_spec_draft_without_a_terminal_needs_a_goal(repo, monkeypatch, capsys):
    assert repo.cli("spec", "draft", "--provider", "stub") == 1
    assert "pass --goal" in capsys.readouterr().err


def test_spec_draft_goal_flag_no_terminal_writes_spec_only(repo, capsys):
    repo.cli("init", "--yes")
    inputs = iter(["a", "b", "", ""])

    orig = builtins.input
    builtins.input = lambda prompt="": next(inputs)
    try:
        assert repo.cli("spec", "draft", "--goal", "Add free shipping over 50", "--provider", "stub") == 0
    finally:
        builtins.input = orig
    assert "Add free shipping" in repo.read(".claimcheck/spec.md")
    # No terminal and no --yes: nothing was frozen.
    assert not (repo.cc / "spec.lock").exists()


# ---- Claude CLI provider ------------------------------------------------------

def test_cli_output_prefers_the_structured_field():
    assert json.loads(claude_cli.parse_output(json.dumps({"result": "text", "structured_output": {"n": 7}}))) == {"n": 7}
    assert claude_cli.parse_output(json.dumps({"result": '{"n": 1}'})) == '{"n": 1}'


def test_cli_output_errors_are_clear():
    with pytest.raises(ProviderError, match="not signed in"):
        claude_cli.parse_output(json.dumps({"is_error": True, "result": "Not logged in. Please run /login"}))
    with pytest.raises(ProviderError, match="non-JSON"):
        claude_cli.parse_output("boom")
    with pytest.raises(ProviderError, match="no result"):
        claude_cli.parse_output(json.dumps({"result": ""}))


def test_shim_resolution_picks_the_script_not_node(tmp_path):
    pkg = tmp_path / "node_modules" / "@anthropic-ai" / "claude-code" / "bin"
    pkg.mkdir(parents=True)
    (pkg / "claude.exe").write_bytes(b"")
    shim = tmp_path / "claude.cmd"
    shim.write_text('@ECHO off\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n', encoding="utf-8")
    prefix, direct = claude_cli.resolve_launch(str(shim))
    assert direct and prefix[0].endswith("claude.exe")
    empty = tmp_path / "empty"
    empty.mkdir()
    assert claude_cli.resolve_launch(str(empty / "nope.cmd"))[1] is False
    assert claude_cli.resolve_launch("/usr/bin/claude") == (["/usr/bin/claude"], True)


def test_a_classic_npm_shim_with_node_beside_it_resolves_to_the_script(tmp_path):
    script = tmp_path / "node_modules" / "@anthropic-ai" / "claude-code" / "cli.js"
    script.parent.mkdir(parents=True)
    script.write_text("//", encoding="utf-8")
    (tmp_path / "node.exe").write_bytes(b"")
    shim = tmp_path / "claude.cmd"
    shim.write_text(
        '@ECHO off\r\nSET dp0=%~dp0\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\n'
        '"%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n',
        encoding="utf-8",
    )
    prefix, direct = claude_cli.resolve_launch(str(shim))
    assert direct and prefix[0] == "node" and prefix[1].endswith("cli.js")


def test_provider_sends_the_prompt_on_stdin_with_tools_off(monkeypatch):
    seen = {}

    reply = json.dumps({"structured_output": {"ok": True}})

    def fake_run(args, **kw):
        """Stand-in for subprocess.run that records the call and reports success."""
        seen["args"], seen["input"] = args, kw["input"]
        return subprocess.CompletedProcess(args, 0, stdout=reply, stderr="")

    monkeypatch.setattr(claude_cli.subprocess, "run", fake_run)
    prov = claude_cli.make_claude_cli_provider(binary="/usr/bin/claude", model="m1")
    assert json.loads(providers.ask_model(prov, system="SYS", user="USER", schema={"type": "object"})) == {"ok": True}
    a = seen["args"]
    assert "--system-prompt" in a and a[a.index("--system-prompt") + 1] == "SYS" and seen["input"] == "USER"
    assert "--disallowedTools" in a and "Bash" in a and "--model" in a and "m1" in a and "--json-schema" in a


def test_provider_reports_a_missing_cli(monkeypatch):
    monkeypatch.setattr(claude_cli, "find_claude", lambda env=None: None)
    with pytest.raises(ProviderError, match="not found"):
        claude_cli.make_claude_cli_provider()


def test_auto_provider_prefers_the_key_then_the_cli_then_explains(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setattr(claude_cli, "find_claude", lambda env=None: None)
    with pytest.raises(ProviderError, match="no way to reach Claude"):
        providers.load("auto")
    monkeypatch.setattr(claude_cli, "find_claude", lambda env=None: "/usr/bin/claude")
    assert providers.load("auto")["name"] == "claude-cli"
    assert "claude-cli" in providers.NAMES


# ---- terminal toolkit ----------------------------------------------------------

def _term(*, inp=lambda p: "", animate=False, color=False, unicode=False, sleep=None, seed=None):
    out = io.StringIO()
    term = tui.make_term(
        out,
        read_input=inp,
        animate=animate,
        color=color,
        unicode=unicode,
        sleep=sleep or (lambda s: None),
        seed=seed,
    )
    return term, out


def test_plain_terminal_has_no_escape_codes():
    t, out = _term()
    tui.write_typed(t, "hello")
    tui.show_shimmer(t, "claimcheck")
    tui.show_bar_filling(t, "bar", 0.5)
    tui.show_decode(t, "lock", "abcdef")
    tui.draw_box(t, ["line one", "line two"], title="t")
    with tui.show_spinner(t, "working") as s:
        tui.set_spin_result(s, ok=True, note="done")
    text = out.getvalue()
    assert "\x1b" not in text and "hello" in text and "abcdef" in text and "working" in text and "+ working" in text


def test_animated_terminal_ends_on_the_final_frame_and_restores_the_cursor():
    sleeps: list = []
    t, out = _term(animate=True, color=True, unicode=True, sleep=sleeps.append, seed=1)
    tui.show_shimmer(t, "claimcheck", passes=1)
    tui.show_bar_filling(t, "conf", 0.92, suffix=lambda v: f"{v:.2f}")
    tui.show_decode(t, "lock", "0123456789abcdef", duration=0.3)
    tui.write_typed(t, "done.")
    tui.show_cursor(t)
    text = out.getvalue()
    assert sleeps and "0.92" in tui.strip_ansi(text) and "0123456789abcdef" in tui.strip_ansi(text)
    assert text.count(tui.HIDE_CURSOR) >= 1 and text.rstrip("\n").endswith(tui.SHOW_CURSOR) or tui.SHOW_CURSOR in text


def test_detect_respects_no_color_ci_and_dumb_terminals():
    def tty():
        """A stand-in stream that says it is a UTF-8 terminal."""
        return types.SimpleNamespace(encoding="utf-8", isatty=lambda: True)

    real = sys.stdin
    sys.stdin = tty()
    try:
        assert tui.detect(tty(), {})["animate"] is True
        assert tui.detect(tty(), {"NO_COLOR": "1"})["color"] is False
        assert tui.detect(tty(), {"CI": "true"})["animate"] is False
        assert tui.detect(tty(), {"TERM": "dumb"})["color"] is False
        assert tui.detect(io.StringIO(), {})["tty"] is False
    finally:
        sys.stdin = real


def test_pause_more_and_skip():
    answers = iter(["m", "", ])
    t, out = _term(inp=lambda p: next(answers))
    assert tui.wait_for_continue(t, more="deeper text") == "next" and "deeper text" in out.getvalue()
    t2, _ = _term(inp=lambda p: "s")
    assert tui.wait_for_continue(t2, skip_label="skip the tour") == "skip"
    t3, _ = _term(inp=lambda p: (_ for _ in ()).throw(EOFError()))
    assert tui.wait_for_continue(t3) == "next"


def test_yes_no_defaults_and_answers():
    for typed, default, expected in (("", True, True), ("", False, False), ("n", True, False), ("Yes", False, True)):
        t, _ = _term(inp=lambda p, v=typed: v)
        assert tui.ask_yes_no(t, "ok?", default=default) is expected


# ---- the onboarding, end to end ------------------------------------------------

def _scripted_term(inputs):
    it = iter(inputs)
    prompts = []

    def inp(prompt):
        """Scripted input: record the prompt and answer with the next reply."""
        prompts.append(prompt)
        return next(it)

    t, out = _term(inp=inp)
    return t, out, prompts, it


def test_onboarding_runs_the_whole_journey(repo, monkeypatch):
    monkeypatch.setattr(providers, "load", lambda name, model=None: make_stub_provider())
    inputs = [
        # The two tour screens.
        "", "",
        # Test command, create CLAUDE.md (yes), CI (no)
        "", "", "",
        # Pause after setup.
        "",
        # The goal.
        "Add free shipping over 50",
        # Answers to the two questions.
        "50 is free", "nothing",
        # Review after round 1, review after round 2 (ready: save)
        "", "",
        # Freeze and commit: yes.
        "",
    ]
    t, out, prompts, rest = _scripted_term(inputs)
    assert onboard.run_onboarding(t, repo.path) == 0
    text = out.getvalue()
    for must in ("The problem", "Three checks", "Set up this repo", "Connect Claude", "Your first spec", "criteria locked", "done"):
        assert must in text, must
    assert next(rest, "unused") == "unused", "the script supplied more input than the flow asked for"
    # setup happened
    assert (repo.cc / "config.toml").exists() and "claimcheck:begin" in repo.read("CLAUDE.md")
    # the spec was frozen and committed on a task branch
    branch = gitio.current_branch(repo.path)
    assert branch == "task/add-free-shipping-over-50"
    assert "Freeze acceptance criteria" in repo.git("log", "-1", "--format=%s")
    assert "claimcheck:begin" in repo.git("show", "HEAD:CLAUDE.md")
    assert "Add free shipping over 50" in repo.read(".claimcheck/spec.md")


def test_onboarding_tour_can_be_skipped_and_goal_left_blank(repo, monkeypatch):
    monkeypatch.setattr(providers, "load", lambda name, model=None: make_stub_provider())
    # Skip tour at screen 1; setup prompts; blank goal.
    inputs = ["s", "", "", "", "", ""]
    t, out, _, rest = _scripted_term(inputs)
    assert onboard.run_onboarding(t, repo.path) == 0
    text = out.getvalue()
    assert "Three checks" not in text and "Skipped" in text and "claimcheck spec draft" in text
    assert not (repo.cc / "spec.lock").exists()


def test_onboarding_without_a_claude_connection_still_finishes_setup(repo, monkeypatch):
    def nope(name, model=None):
        raise ProviderError("no way to reach Claude")

    monkeypatch.setattr(providers, "load", nope)
    t, out, _, _ = _scripted_term(["", "", "", "", "", ""])
    assert onboard.run_onboarding(t, repo.path) == 0
    assert "no way to reach Claude" in out.getvalue() and (repo.cc / "config.toml").exists()


def test_ctrl_c_stops_cleanly_and_setup_can_resume(repo, monkeypatch):
    def interrupt(prompt):
        raise KeyboardInterrupt

    t, out = _term(inp=interrupt)
    assert onboard.run_onboarding(t, repo.path) == 130
    assert "Run `claimcheck init` again" in out.getvalue()


def test_ansi_never_leaks_into_the_plain_transcript(repo, monkeypatch):
    monkeypatch.setattr(providers, "load", lambda name, model=None: make_stub_provider())
    t, out, _, _ = _scripted_term(["s", "", "", "", "", ""])
    onboard.run_onboarding(t, repo.path)
    assert not re.search(r"\x1b\[", out.getvalue())
