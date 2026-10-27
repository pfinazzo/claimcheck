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
    config,
    detect,
    initflow,
    providers,
    specdraft,
    tui,
)
from .tui import Term

TOTAL = 5


def wrap_with_spinner(inner: providers.Provider, *, term: Term, label: str) -> providers.Provider:
    """The same provider, showing a spinner while every model call runs."""

    def answer_request(request: providers.Request) -> str:
        """Ask the inner provider with the spinner turning."""
        with tui.show_spinner(term, label=label, keep=False):
            return inner["complete"](request)

    return providers.make_provider(inner["name"], complete=answer_request, model=inner["model"])


def make_indented(t: Term):
    """(say, ask) for the spec conversation, indented to sit inside the guided screens."""
    def write_indented(s: str) -> None:
        tui.write_line(t, text="\n".join(("  " + line) if line.strip() else line for line in s.split("\n")))

    def ask(prompt: str) -> str:
        """Ask through the terminal, indented, keeping a leading blank line when the prompt has one."""
        lead = "\n" if prompt.startswith("\n") else ""
        return tui.ask(t, prompt=lead + "  " + prompt.lstrip("\n"))

    return write_indented, ask


# ---- the tour ---------------------------------------------------------------

def _show_banner(t: Term) -> None:
    tui.write_line(t)
    tui.show_shimmer(t, text="claimcheck", indent="  ")
    tui.write_typed(t, text="  A ledger for code that an AI wrote.", styles=("grey",), delay=0.012)
    tui.write_line(t)
    tui.write_line(t, text="  " + tui.format_styled(t, text="About two minutes. Enter moves on, m shows more detail, s skips the tour.", styles=("grey",)))
    tui.write_line(t)


def _show_problem_scene(t: Term) -> str:
    tui.show_step(t, number=1, total=TOTAL, title="The problem")
    tui.write_line(t, text="  A coding agent tells you its change works. It says so in the same tone")
    tui.write_line(t, text="  whether it is right or wrong.")
    tui.write_line(t)
    tui.draw_box(t,
        lines=[
            tui.format_styled(t, text="claim", styles=("grey",)) + "  shipping_fee returns 0 for orders of $50 or more",
            tui.format_styled(t, text="author", styles=("grey",)) + "  coding agent",
        ],
        title="what the agent said",
    )
    tui.show_bar_filling(t, label="  stated confidence", to=0.92, width=26, duration=1.0, suffix=lambda fraction: f"{fraction:.2f}")
    tui.write_line(t)
    tui.write_line(t, text="  The tests pass. Does that make the claim true?")
    return tui.wait_for_continue(t,
        more=(
            "A green test run only shows the tests you have do not complain. If they never\n"
            "check an order of exactly $50, a bug at that boundary ships anyway.\n"
            "claimcheck measures how much the tests would notice, and writes it down."
        ),
        skip_label="skip the tour",
    )


def _show_mutation_demo(t: Term) -> None:
    glob = t["glyphs"]
    code_ok = "    if total >= 50:"
    code_bug = "    if total >  50:"
    tui.write_line(t, text=tui.format_styled(t, text="  def shipping_fee(total):", styles=("grey",)))
    tui.write_line(t, text=f"  {code_ok}       " + tui.format_styled(t, text="2 tests pass", styles=("green",)))
    tui.sleep_briefly(t, seconds=0.7)
    tui.write(t, text=f"  {tui.format_styled(t, text=code_bug, styles=('red',))}       ")
    tui.sleep_briefly(t, seconds=0.5)
    tui.write_line(t, text=tui.format_styled(t, text="2 tests pass", styles=("green",)) + "   " + tui.format_styled(t, text="survived", styles=("red", "bold")) + tui.format_styled(t, text="  (a bug nobody noticed)", styles=("grey",)))
    tui.sleep_briefly(t, seconds=0.8)
    tui.write_line(t, text=f"  {tui.format_styled(t, text='+', styles=('green',))} {tui.format_styled(t, text='def test_exactly_fifty(): assert shipping_fee(50) == 0', styles=('green',))}")
    tui.sleep_briefly(t, seconds=0.6)
    tui.write_line(t, text=f"  {tui.format_styled(t, text=code_bug, styles=('red',))}       " + tui.format_styled(t, text="1 test fails", styles=("red",)) + "   " + tui.format_styled(t, text="killed", styles=("green", "bold")))
    _ = glob


def _show_checks_scene(t: Term) -> str:
    tui.show_step(t, number=2, total=TOTAL, title="Three checks")
    tui.write_line(t, text="  Every change carries three checks that the author cannot influence.")
    tui.write_line(t)
    tui.write_line(t, text="  " + tui.format_styled(t, text="1", styles=("cyan", "bold")) + "  Criteria are frozen before the code exists.")
    tui.show_decode(t, label="     locked", final="4c7f94b79bca0c877c2fddfc86f80beb700300ff39bde270d7618c790f292f12"[:40], duration=0.9)
    tui.write_line(t)
    tui.write_line(t, text="  " + tui.format_styled(t, text="2", styles=("cyan", "bold")) + "  A second model checks each claim. It never sees the author's confidence.")
    tui.sleep_briefly(t, seconds=0.4)
    tui.write_line(t)
    tui.write_line(t, text="  " + tui.format_styled(t, text="3", styles=("cyan", "bold")) + "  Planted bugs. claimcheck breaks the new code on purpose and reruns your tests.")
    tui.write_line(t)
    _show_mutation_demo(t)
    tui.write_line(t)
    tui.write_line(t, text="  " + tui.format_styled(t, text="The share of planted bugs your tests catch is printed next to the author's confidence.", styles=("bold",)))
    return tui.wait_for_continue(t,
        more=(
            "The checks write to .claimcheck/ledger.jsonl, one line per claim per run.\n"
            "Over time that file is the record of how far to trust each author, human or AI."
        ),
    )


# ---- setup ------------------------------------------------------------------

def _describe_secrets(value: dict) -> str:
    """What setup did to .gitignore: created it, added lines, or nothing needed."""
    if value["created"]:
        return ".gitignore created, .env and key files ignored"
    if value["added"]:
        return f"added {len(value['added'])} lines so .env and key files are ignored"
    return ".env and key files are already ignored"


def _show_secrets(t: Term, *, value: dict) -> None:
    """The secrets step, plus a warning for each secret file git already tracks."""
    ok = tui.format_styled(t, text=t["glyphs"]["ok"], styles=("green", "bold"))
    tui.write_line(t, text=f"  {ok} Secrets               {tui.format_styled(t, text=_describe_secrets(value), styles=('grey',))}")
    for tracked in value["tracked"]:
        tui.write_line(t, text=f"  {tui.format_styled(t, text='!', styles=('red', 'bold'))} {tui.format_styled(t, text=tracked, styles=('red',))} {tui.format_styled(t, text='is already committed. Ignoring it does not remove it: run git rm --cached ' + tracked, styles=('grey',))}")
    tui.sleep_briefly(t, seconds=0.25)


def _show_config(t: Term, *, value) -> None:
    """The config step: created or already there."""
    tui.write_line(t, text=f"  {tui.format_styled(t, text=t['glyphs']['ok'], styles=('green', 'bold'))} Config               {tui.format_styled(t, text='.claimcheck/config.toml (' + str(value) + ')', styles=('grey',))}")


def _show_hook(t: Term, *, value: dict) -> None:
    """The commit hook step."""
    tui.write_line(t, text=f"  {tui.format_styled(t, text=t['glyphs']['ok'], styles=('green', 'bold'))} Commit hook           {tui.format_styled(t, text=value['status'], styles=('grey',))}")


def _show_gitignore(t: Term, *, value: list) -> None:
    """The .gitignore step: how many lines were added."""
    note = f"added {len(value)} lines" if value else "already set"
    tui.write_line(t, text=f"  {tui.format_styled(t, text=t['glyphs']['ok'], styles=('green', 'bold'))} .gitignore            {tui.format_styled(t, text=note, styles=('grey',))}")


def _show_agent_docs(t: Term, *, value: list) -> None:
    """The agent instructions step: the files updated, or that there were none."""
    if not value:
        tui.write_line(t, text=f"  {tui.format_styled(t, text=t['glyphs']['ring'], styles=('grey',))} Agent instructions    {tui.format_styled(t, text='no CLAUDE.md or AGENTS.md to update', styles=('grey',))}")
        return
    files = ", ".join(f"{element['path']} ({element['action']})" for element in value)
    tui.write_line(t, text=f"  {tui.format_styled(t, text=t['glyphs']['ok'], styles=('green', 'bold'))} Agent instructions    {tui.format_styled(t, text=files, styles=('grey',))}")


def _show_ci(t: Term, *, value: dict | None) -> None:
    """The CI workflow step, when one was asked for."""
    if value:
        tui.write_line(t, text=f"  {tui.format_styled(t, text=t['glyphs']['ok'], styles=('green', 'bold'))} CI workflow           {tui.format_styled(t, text=value['path'] + ' (' + value['action'] + ')', styles=('grey',))}")


def _show_nothing(t: Term, *, value) -> None:
    """Steps with nothing to show (detect)."""


_REVEALERS = {
    "secrets": _show_secrets,
    "config": _show_config,
    "hook": _show_hook,
    "gitignore": _show_gitignore,
    "agent_docs": _show_agent_docs,
    "ci": _show_ci,
}


def _show_setup_scene(t: Term, *, repo: Path, assume_yes: bool) -> dict:
    tui.show_step(t, number=3, total=TOTAL, title="Set up this repo")
    det = detect.detect(repo)
    cfg_exists = (config.resolve_cc_dir(repo) / config.CONFIG_FILE).exists()
    test_cmd = None
    if not cfg_exists:
        guess = det["test_cmd"] or "python -m pytest -q"
        label = "detected" if det["test_cmd"] else "default, nothing detected"
        tui.write_line(t, text=f"  Test command: {tui.format_styled(t, text=guess, styles=('cyan',))} {tui.format_styled(t, text='(' + label + ')', styles=('grey',))}")
        if det["others"]:
            tui.write_line(t, text="  " + tui.format_styled(t, text="Also found: " + ", ".join(det["others"]) + ". Using the first.", styles=("grey",)))
        if not assume_yes:
            typed = tui.ask(t, prompt=f"  {tui.format_styled(t, text='?', styles=('cyan', 'bold'))} Press Enter to keep it, or type the command to use> ").strip()
            test_cmd = typed or None
    ci_provider = None
    create_doc = None
    has_agent_file = any((repo / file_path).is_file() for file_path in ("CLAUDE.md", ".claude/CLAUDE.md", "AGENTS.md"))
    if not assume_yes:
        if not has_agent_file and tui.ask_yes_no(t, question="No CLAUDE.md or AGENTS.md found. Create CLAUDE.md with the agent instructions?", default=True):
            create_doc = "claude"
        if tui.ask_yes_no(t, question="Add a GitHub Actions workflow that runs claimcheck on pull requests?", default=False):
            ci_provider = "github"
    tui.write_line(t)

    def show_reveal(name: str, *, value) -> None:
        """Show one finished setup step, with a short pause so the steps read one by one."""
        _REVEALERS.get(name, _show_nothing)(t, value=value)
        if name != "detect":
            tui.sleep_briefly(t, seconds=0.25)

    outcome = initflow.run_setup(repo, create_agent_doc=create_doc, ci_provider=ci_provider, test_cmd=test_cmd, on_step=show_reveal)
    tui.write_line(t)
    tui.write_line(t, text="  " + tui.format_styled(t, text="Your coding agent now finds the claimcheck rules in its own instructions file.", styles=("grey",)))
    tui.wait_for_continue(t,
        more=(
            "The commit hook refuses a commit that changes code without a claims file that covers it.\n"
            "The notes in CLAUDE.md or AGENTS.md sit between two marker comments, so running init again\n"
            "updates them in place and never duplicates them. Nothing is committed yet."
        ),
    )
    return outcome


# ---- connection and spec ----------------------------------------------------

def _connect(t: Term):
    """Returns (provider, description) or (None, reason)."""
    tui.show_step(t, number=4, total=TOTAL, title="Connect Claude")
    try:
        if config.has_api_key():
            provider, how = providers.load("auto"), "your Anthropic API key"
        else:
            provider, how = providers.load("auto"), "your Claude Code sign-in"
    except (ProviderError, ImportError, ValueError) as error:
        tui.write_line(t, text=f"  {tui.format_styled(t, text=t['glyphs']['bad'], styles=('red', 'bold'))} {error}")
        tui.write_line(t, text="  " + tui.format_styled(t, text="You can still write .claimcheck/spec.md by hand. Setup is otherwise complete.", styles=("grey",)))
        return None, str(error)
    tui.write_line(t, text=f"  {tui.format_styled(t, text=t['glyphs']['ok'], styles=('green', 'bold'))} Using {how}.")
    tui.write_line(t, text="  " + tui.format_styled(t, text="Claude sees your goal, your answers and the repo's file names (never .env or key files).", styles=("grey",)))
    tui.write_line(t, text="  " + tui.format_styled(t, text="Later, checking a claim also sends the diff under test.", styles=("grey",)))
    return provider, how


def _show_spec_scene(t: Term, *, repo: Path, provider, goal: str | None) -> dict | None:
    tui.show_step(t, number=5, total=TOTAL, title="Your first spec")
    tui.write_line(t, text="  Claude asks questions, you answer, and the acceptance criteria take shape.")
    tui.write_line(t, text="  You can edit any criterion yourself. Nothing is frozen until you say so.")
    tui.write_line(t)
    if goal is None:
        goal = tui.ask(t, prompt=f"  {tui.format_styled(t, text='?', styles=('cyan', 'bold'))} What do you want built? A sentence or two. Enter to skip> ").strip()
    if not goal:
        tui.write_line(t, text="  " + tui.format_styled(t, text="Skipped. Run `claimcheck spec draft` whenever you are ready.", styles=("grey",)))
        return None
    cfg = config.load(repo)
    spinning = wrap_with_spinner(provider, term=t, label="Claude is thinking")
    say, ask = make_indented(t)
    draft, status = specdraft.run_interview(spinning, repo=repo, goal=goal, say=say, ask=ask)
    if status == "quit":
        tui.write_line(t, text="  " + tui.format_styled(t, text="Left without writing. Your answers are kept: `claimcheck spec draft --resume` picks up here.", styles=("grey",)))
        return None
    tui.write_line(t)
    tui.draw_box(t, lines=[f"{index}. {criterion['text']}" for index, criterion in enumerate(draft["criteria"], 1)], title="acceptance criteria")
    if not tui.ask_yes_no(t, question="Freeze these and commit them on a new branch?", default=True):
        specdraft.write_spec(repo, draft=draft)
        tui.write_line(t, text="  " + tui.format_styled(t, text="Wrote .claimcheck/spec.md. Freeze it later with `claimcheck spec freeze`.", styles=("grey",)))
        return None
    output = specdraft.apply_draft(repo, settings=cfg, draft=draft)
    tui.write_line(t)
    tui.show_decode(t, label="  criteria locked", final=output["lock_sha256"], duration=1.0)
    if output.get("branch") and output.get("commit"):
        tui.write_line(t, text=f"  Committed {tui.format_styled(t, text=output['commit'][:8], styles=('cyan',))} on branch {tui.format_styled(t, text=output['branch'], styles=('cyan',))}.")
    return output


def _show_finish(t: Term, *, spec_result: dict | None) -> None:
    tui.write_line(t)
    tui.draw_rule(t, label="done")
    tui.write_line(t)
    steps = []
    if spec_result and spec_result.get("branch"):
        steps.append(f"Have your coding agent build it on {spec_result['branch']}.")
    else:
        steps.append("Write the spec:        claimcheck spec draft")
    steps.append("Check the result:      claimcheck run")
    steps.append("See the board:         the Desk app in app/ (see the README)")
    tui.draw_box(t, lines=[f"{index}. {step}" for index, step in enumerate(steps, 1)], title="next", style="green")
    tui.write_line(t)


# ---- entry point ------------------------------------------------------------

def _show_tour(t: Term) -> None:
    """The intro scenes, in order, until the person skips."""
    for scene in (_show_problem_scene, _show_checks_scene):
        if scene(t) == "skip":
            return


def _draft_spec_or_explain(t: Term, *, repo: Path, provider: providers.Provider, goal: str | None):
    """The spec scene's result. A failure there is shown, and setup still counts as done."""
    try:
        return _show_spec_scene(t, repo=repo, provider=provider, goal=goal)
    except ClaimcheckError as error:
        tui.write_line(t, text=f"  {tui.format_styled(t, text=t['glyphs']['bad'], styles=('red', 'bold'))} {error}")
        tui.write_line(t, text="  " + tui.format_styled(t, text="Setup is done. Try `claimcheck spec draft` again when ready.", styles=("grey",)))
        return None


def run_onboarding(t: Term, *, repo: Path, tour: bool = True, goal: str | None = None, assume_yes: bool = False) -> int:
    """The guided `claimcheck init`: tour, setup, connection, first spec. Returns the exit code (130 if stopped)."""
    try:
        _show_banner(t)
        if tour:
            _show_tour(t)
        outcome = _show_setup_scene(t, repo=repo, assume_yes=assume_yes)
        provider, _ = _connect(t)
        spec_result = None if provider is None else _draft_spec_or_explain(t, repo=repo, provider=provider, goal=goal)
        _show_finish(t, spec_result=spec_result)
        _ = outcome
        return 0
    except (KeyboardInterrupt, EOFError):
        tui.show_cursor(t)
        tui.write_line(t)
        tui.write_line(t, text="  " + tui.format_styled(t, text="Stopped. Whatever finished is kept. Run `claimcheck init` again to continue.", styles=("grey",)))
        return 130
