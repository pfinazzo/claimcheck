"""The guided, animated terminal setup behind `claimcheck init`.

One idea per screen, revealed when the person presses Enter. `m` opens a deeper explanation and
`s` skips the tour. With no terminal, or with --yes, none of this runs: `init` does the same work
quietly and prints a plain summary.

@author Patrick Finazzo
"""

from __future__ import annotations

from pathlib import Path

from . import (
    ClaimcheckError,
    ProviderError,
    detect,
    initflow,
    providers,
    specdraft,
    tui,
)
from . import config as C
from .tui import Term

TOTAL = 5


def with_spinner(inner: providers.Provider, *, term: Term, label: str) -> providers.Provider:
    """The same provider, showing a spinner while every model call runs."""

    def complete(request: providers.Request) -> str:
        """Ask the inner provider with the spinner turning."""
        with tui.show_spinner(term, label, keep=False):
            return inner["complete"](request)

    return providers.make_provider(inner["name"], complete=complete, model=inner["model"])


def indented(t: Term):
    """(say, ask) for the spec conversation, indented to sit inside the guided screens."""
    def say(s: str) -> None:
        tui.write_line(t, "\n".join(("  " + line) if line.strip() else line for line in s.split("\n")))

    def ask(prompt: str) -> str:
        """Ask through the terminal, indented, keeping a leading blank line when the prompt has one."""
        lead = "\n" if prompt.startswith("\n") else ""
        return tui.ask(t, lead + "  " + prompt.lstrip("\n"))

    return say, ask


# ---- the tour ---------------------------------------------------------------

def _banner(t: Term) -> None:
    tui.write_line(t)
    tui.show_shimmer(t, "claimcheck", indent="  ")
    tui.write_typed(t, "  A ledger for code that an AI wrote.", "grey", delay=0.012)
    tui.write_line(t)
    tui.write_line(t, "  " + tui.format_styled(t, "About two minutes. Enter moves on, m shows more detail, s skips the tour.", "grey"))
    tui.write_line(t)


def _scene_problem(t: Term) -> str:
    tui.show_step(t, 1, TOTAL, "The problem")
    tui.write_line(t, "  A coding agent tells you its change works. It says so in the same tone")
    tui.write_line(t, "  whether it is right or wrong.")
    tui.write_line(t)
    tui.draw_box(t,
        [
            tui.format_styled(t, "claim", "grey") + "  shipping_fee returns 0 for orders of $50 or more",
            tui.format_styled(t, "author", "grey") + "  coding agent",
        ],
        title="what the agent said",
    )
    tui.show_bar_filling(t, "  stated confidence", 0.92, width=26, duration=1.0, suffix=lambda v: f"{v:.2f}")
    tui.write_line(t)
    tui.write_line(t, "  The tests pass. Does that make the claim true?")
    return tui.wait_for_continue(t,
        more=(
            "A green test run only shows the tests you have do not complain. If they never\n"
            "check an order of exactly $50, a bug at that boundary ships anyway.\n"
            "claimcheck measures how much the tests would notice, and writes it down."
        ),
        skip_label="skip the tour",
    )


def _mutation_demo(t: Term) -> None:
    g = t["glyphs"]
    code_ok = "    if total >= 50:"
    code_bug = "    if total >  50:"
    tui.write_line(t, tui.format_styled(t, "  def shipping_fee(total):", "grey"))
    tui.write_line(t, f"  {code_ok}       " + tui.format_styled(t, "2 tests pass", "green"))
    tui.sleep_briefly(t, 0.7)
    tui.write(t, f"  {tui.format_styled(t, code_bug, 'red')}       ")
    tui.sleep_briefly(t, 0.5)
    tui.write_line(t, tui.format_styled(t, "2 tests pass", "green") + "   " + tui.format_styled(t, "survived", "red", "bold") + tui.format_styled(t, "  (a bug nobody noticed)", "grey"))
    tui.sleep_briefly(t, 0.8)
    tui.write_line(t, f"  {tui.format_styled(t, '+', 'green')} {tui.format_styled(t, 'def test_exactly_fifty(): assert shipping_fee(50) == 0', 'green')}")
    tui.sleep_briefly(t, 0.6)
    tui.write_line(t, f"  {tui.format_styled(t, code_bug, 'red')}       " + tui.format_styled(t, "1 test fails", "red") + "   " + tui.format_styled(t, "killed", "green", "bold"))
    _ = g


def _scene_checks(t: Term) -> str:
    tui.show_step(t, 2, TOTAL, "Three checks")
    tui.write_line(t, "  Every change carries three checks that the author cannot influence.")
    tui.write_line(t)
    tui.write_line(t, "  " + tui.format_styled(t, "1", "cyan", "bold") + "  Criteria are frozen before the code exists.")
    tui.show_decode(t, "     locked", "4c7f94b79bca0c877c2fddfc86f80beb700300ff39bde270d7618c790f292f12"[:40], duration=0.9)
    tui.write_line(t)
    tui.write_line(t, "  " + tui.format_styled(t, "2", "cyan", "bold") + "  A second model checks each claim. It never sees the author's confidence.")
    tui.sleep_briefly(t, 0.4)
    tui.write_line(t)
    tui.write_line(t, "  " + tui.format_styled(t, "3", "cyan", "bold") + "  Planted bugs. claimcheck breaks the new code on purpose and reruns your tests.")
    tui.write_line(t)
    _mutation_demo(t)
    tui.write_line(t)
    tui.write_line(t, "  " + tui.format_styled(t, "The share of planted bugs your tests catch is printed next to the author's confidence.", "bold"))
    return tui.wait_for_continue(t,
        more=(
            "The checks write to .claimcheck/ledger.jsonl, one line per claim per run.\n"
            "Over time that file is the record of how far to trust each author, human or AI."
        ),
    )


# ---- setup ------------------------------------------------------------------

def _secrets_note(value: dict) -> str:
    """What setup did to .gitignore: created it, added lines, or nothing needed."""
    if value["created"]:
        return ".gitignore created, .env and key files ignored"
    if value["added"]:
        return f"added {len(value['added'])} lines so .env and key files are ignored"
    return ".env and key files are already ignored"


def _reveal_secrets(t: Term, value: dict) -> None:
    """The secrets step, plus a warning for each secret file git already tracks."""
    ok = tui.format_styled(t, t["glyphs"]["ok"], "green", "bold")
    tui.write_line(t, f"  {ok} Secrets               {tui.format_styled(t, _secrets_note(value), 'grey')}")
    for tracked in value["tracked"]:
        tui.write_line(t, f"  {tui.format_styled(t, '!', 'red', 'bold')} {tui.format_styled(t, tracked, 'red')} {tui.format_styled(t, 'is already committed. Ignoring it does not remove it: run git rm --cached ' + tracked, 'grey')}")
    tui.sleep_briefly(t, 0.25)


def _reveal_config(t: Term, value) -> None:
    """The config step: created or already there."""
    tui.write_line(t, f"  {tui.format_styled(t, t['glyphs']['ok'], 'green', 'bold')} Config               {tui.format_styled(t, '.claimcheck/config.toml (' + str(value) + ')', 'grey')}")


def _reveal_hook(t: Term, value: dict) -> None:
    """The commit hook step."""
    tui.write_line(t, f"  {tui.format_styled(t, t['glyphs']['ok'], 'green', 'bold')} Commit hook           {tui.format_styled(t, value['status'], 'grey')}")


def _reveal_gitignore(t: Term, value: list) -> None:
    """The .gitignore step: how many lines were added."""
    note = f"added {len(value)} lines" if value else "already set"
    tui.write_line(t, f"  {tui.format_styled(t, t['glyphs']['ok'], 'green', 'bold')} .gitignore            {tui.format_styled(t, note, 'grey')}")


def _reveal_agent_docs(t: Term, value: list) -> None:
    """The agent instructions step: the files updated, or that there were none."""
    if not value:
        tui.write_line(t, f"  {tui.format_styled(t, t['glyphs']['ring'], 'grey')} Agent instructions    {tui.format_styled(t, 'no CLAUDE.md or AGENTS.md to update', 'grey')}")
        return
    files = ", ".join(f"{x['path']} ({x['action']})" for x in value)
    tui.write_line(t, f"  {tui.format_styled(t, t['glyphs']['ok'], 'green', 'bold')} Agent instructions    {tui.format_styled(t, files, 'grey')}")


def _reveal_ci(t: Term, value: dict | None) -> None:
    """The CI workflow step, when one was asked for."""
    if value:
        tui.write_line(t, f"  {tui.format_styled(t, t['glyphs']['ok'], 'green', 'bold')} CI workflow           {tui.format_styled(t, value['path'] + ' (' + value['action'] + ')', 'grey')}")


def _reveal_nothing(t: Term, value) -> None:
    """Steps with nothing to show (detect)."""


_REVEALERS = {
    "secrets": _reveal_secrets,
    "config": _reveal_config,
    "hook": _reveal_hook,
    "gitignore": _reveal_gitignore,
    "agent_docs": _reveal_agent_docs,
    "ci": _reveal_ci,
}


def _scene_setup(t: Term, repo: Path, *, assume_yes: bool) -> dict:
    tui.show_step(t, 3, TOTAL, "Set up this repo")
    det = detect.detect(repo)
    cfg_exists = (C.cc_dir(repo) / C.CONFIG_FILE).exists()
    test_cmd = None
    if not cfg_exists:
        guess = det["test_cmd"] or "python -m pytest -q"
        label = "detected" if det["test_cmd"] else "default, nothing detected"
        tui.write_line(t, f"  Test command: {tui.format_styled(t, guess, 'cyan')} {tui.format_styled(t, '(' + label + ')', 'grey')}")
        if det["others"]:
            tui.write_line(t, "  " + tui.format_styled(t, "Also found: " + ", ".join(det["others"]) + ". Using the first.", "grey"))
        if not assume_yes:
            typed = tui.ask(t, f"  {tui.format_styled(t, '?', 'cyan', 'bold')} Press Enter to keep it, or type the command to use> ").strip()
            test_cmd = typed or None
    ci_provider = None
    create_doc = None
    has_agent_file = any((repo / f).is_file() for f in ("CLAUDE.md", ".claude/CLAUDE.md", "AGENTS.md"))
    if not assume_yes:
        if not has_agent_file and tui.ask_yes_no(t, "No CLAUDE.md or AGENTS.md found. Create CLAUDE.md with the agent instructions?", default=True):
            create_doc = "claude"
        if tui.ask_yes_no(t, "Add a GitHub Actions workflow that runs claimcheck on pull requests?", default=False):
            ci_provider = "github"
    tui.write_line(t)

    def reveal(name: str, value) -> None:
        """Show one finished setup step, with a short pause so the steps read one by one."""
        _REVEALERS.get(name, _reveal_nothing)(t, value)
        if name != "detect":
            tui.sleep_briefly(t, 0.25)

    result = initflow.run_setup(repo, create_agent_doc=create_doc, ci_provider=ci_provider, test_cmd=test_cmd, on_step=reveal)
    tui.write_line(t)
    tui.write_line(t, "  " + tui.format_styled(t, "Your coding agent now finds the claimcheck rules in its own instructions file.", "grey"))
    tui.wait_for_continue(t,
        more=(
            "The commit hook refuses a commit that changes code without a claims file that covers it.\n"
            "The notes in CLAUDE.md or AGENTS.md sit between two marker comments, so running init again\n"
            "updates them in place and never duplicates them. Nothing is committed yet."
        ),
    )
    return result


# ---- connection and spec ----------------------------------------------------

def _connection(t: Term):
    """Returns (provider, description) or (None, reason)."""
    tui.show_step(t, 4, TOTAL, "Connect Claude")
    try:
        if C.has_api_key():
            provider, how = providers.load("auto"), "your Anthropic API key"
        else:
            provider, how = providers.load("auto"), "your Claude Code sign-in"
    except (ProviderError, ImportError, ValueError) as e:
        tui.write_line(t, f"  {tui.format_styled(t, t['glyphs']['bad'], 'red', 'bold')} {e}")
        tui.write_line(t, "  " + tui.format_styled(t, "You can still write .claimcheck/spec.md by hand. Setup is otherwise complete.", "grey"))
        return None, str(e)
    tui.write_line(t, f"  {tui.format_styled(t, t['glyphs']['ok'], 'green', 'bold')} Using {how}.")
    tui.write_line(t, "  " + tui.format_styled(t, "Claude sees your goal, your answers and the repo's file names (never .env or key files).", "grey"))
    tui.write_line(t, "  " + tui.format_styled(t, "Later, checking a claim also sends the diff under test.", "grey"))
    return provider, how


def _scene_spec(t: Term, repo: Path, provider, *, goal: str | None) -> dict | None:
    tui.show_step(t, 5, TOTAL, "Your first spec")
    tui.write_line(t, "  Claude asks questions, you answer, and the acceptance criteria take shape.")
    tui.write_line(t, "  You can edit any criterion yourself. Nothing is frozen until you say so.")
    tui.write_line(t)
    if goal is None:
        goal = tui.ask(t, f"  {tui.format_styled(t, '?', 'cyan', 'bold')} What do you want built? A sentence or two. Enter to skip> ").strip()
    if not goal:
        tui.write_line(t, "  " + tui.format_styled(t, "Skipped. Run `claimcheck spec draft` whenever you are ready.", "grey"))
        return None
    cfg = C.load(repo)
    spinning = with_spinner(provider, term=t, label="Claude is thinking")
    say, ask = indented(t)
    draft, status = specdraft.run_interview(spinning, repo, goal, say=say, ask=ask)
    if status == "quit":
        tui.write_line(t, "  " + tui.format_styled(t, "Left without writing. Your answers are kept: `claimcheck spec draft --resume` picks up here.", "grey"))
        return None
    tui.write_line(t)
    tui.draw_box(t, [f"{i}. {c['text']}" for i, c in enumerate(draft["criteria"], 1)], title="acceptance criteria")
    if not tui.ask_yes_no(t, "Freeze these and commit them on a new branch?", default=True):
        specdraft.write_spec(repo, draft)
        tui.write_line(t, "  " + tui.format_styled(t, "Wrote .claimcheck/spec.md. Freeze it later with `claimcheck spec freeze`.", "grey"))
        return None
    out = specdraft.finish(repo, cfg, draft)
    tui.write_line(t)
    tui.show_decode(t, "  criteria locked", out["lock_sha256"], duration=1.0)
    if out.get("branch") and out.get("commit"):
        tui.write_line(t, f"  Committed {tui.format_styled(t, out['commit'][:8], 'cyan')} on branch {tui.format_styled(t, out['branch'], 'cyan')}.")
    return out


def _finish(t: Term, spec_result: dict | None) -> None:
    tui.write_line(t)
    tui.draw_rule(t, "done")
    tui.write_line(t)
    steps = []
    if spec_result and spec_result.get("branch"):
        steps.append(f"Have your coding agent build it on {spec_result['branch']}.")
    else:
        steps.append("Write the spec:        claimcheck spec draft")
    steps.append("Check the result:      claimcheck run")
    steps.append("See the board:         the Desk app in app/ (see the README)")
    tui.draw_box(t, [f"{i}. {s}" for i, s in enumerate(steps, 1)], title="next", style="green")
    tui.write_line(t)


# ---- entry point ------------------------------------------------------------

def _play_tour(t: Term) -> None:
    """The intro scenes, in order, until the person skips."""
    for scene in (_scene_problem, _scene_checks):
        if scene(t) == "skip":
            return


def _spec_or_explain(t: Term, repo: Path, provider: providers.Provider, *, goal: str | None):
    """The spec scene's result. A failure there is shown, and setup still counts as done."""
    try:
        return _scene_spec(t, repo, provider, goal=goal)
    except ClaimcheckError as e:
        tui.write_line(t, f"  {tui.format_styled(t, t['glyphs']['bad'], 'red', 'bold')} {e}")
        tui.write_line(t, "  " + tui.format_styled(t, "Setup is done. Try `claimcheck spec draft` again when ready.", "grey"))
        return None


def run_onboarding(t: Term, repo: Path, *, tour: bool = True, goal: str | None = None, assume_yes: bool = False) -> int:
    """The guided `claimcheck init`: tour, setup, connection, first spec. Returns the exit code (130 if stopped)."""
    try:
        _banner(t)
        if tour:
            _play_tour(t)
        result = _scene_setup(t, repo, assume_yes=assume_yes)
        provider, _ = _connection(t)
        spec_result = None if provider is None else _spec_or_explain(t, repo, provider, goal=goal)
        _finish(t, spec_result)
        _ = result
        return 0
    except (KeyboardInterrupt, EOFError):
        tui.show_cursor(t)
        tui.write_line(t)
        tui.write_line(t, "  " + tui.format_styled(t, "Stopped. Whatever finished is kept. Run `claimcheck init` again to continue.", "grey"))
        return 130
