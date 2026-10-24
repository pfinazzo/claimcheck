"""The guided, animated terminal setup behind `claimcheck init`.

One idea per screen, revealed when the person presses Enter. `m` opens a deeper explanation and
`s` skips the tour. With no terminal, or with --yes, none of this runs: `init` does the same work
quietly and prints a plain summary.

@author Patrick Finazzo
"""

from __future__ import annotations

import os
from pathlib import Path

from . import ClaimcheckError, ProviderError, detect, initflow, providers, specdraft
from . import config as C
from .tui import Term

TOTAL = 5


class _SpinningProvider:
    """Wraps a provider so every model call shows a spinner while Claude works."""

    def __init__(self, inner, term: Term, label: str):
        self.inner, self.term, self.label = inner, term, label

    def complete(self, system: str, user: str, *, schema: dict) -> str:
        with self.term.spinner(self.label, keep=False):
            return self.inner.complete(system, user, schema=schema)


def indented(t: Term):
    """(say, ask) for the spec conversation, indented to sit inside the guided screens."""
    def say(s: str) -> None:
        t.p("\n".join(("  " + line) if line.strip() else line for line in s.split("\n")))

    def ask(prompt: str) -> str:
        lead = "\n" if prompt.startswith("\n") else ""
        return t.ask(lead + "  " + prompt.lstrip("\n"))

    return say, ask


# ---- the tour ---------------------------------------------------------------

def _banner(t: Term) -> None:
    t.p()
    t.shimmer("claimcheck", indent="  ")
    t.typewriter("  A ledger for code that an AI wrote.", "grey", delay=0.012)
    t.p()
    t.p("  " + t.c("About two minutes. Enter moves on, m shows more detail, s skips the tour.", "grey"))
    t.p()


def _scene_problem(t: Term) -> str:
    t.step(1, TOTAL, "The problem")
    t.p("  A coding agent tells you its change works. It says so in the same tone")
    t.p("  whether it is right or wrong.")
    t.p()
    t.box(
        [
            t.c("claim", "grey") + "  shipping_fee returns 0 for orders of $50 or more",
            t.c("author", "grey") + "  coding agent",
        ],
        title="what the agent said",
    )
    t.animate_bar("  stated confidence", 0.92, width=26, duration=1.0, suffix=lambda v: f"{v:.2f}")
    t.p()
    t.p("  The tests pass. Does that make the claim true?")
    return t.pause(
        more=(
            "A green test run only shows the tests you have do not complain. If they never\n"
            "check an order of exactly $50, a bug at that boundary ships anyway.\n"
            "claimcheck measures how much the tests would notice, and writes it down."
        ),
        skip_label="skip the tour",
    )


def _mutation_demo(t: Term) -> None:
    g = t.g
    code_ok = "    if total >= 50:"
    code_bug = "    if total >  50:"
    t.p(t.c("  def shipping_fee(total):", "grey"))
    t.p(f"  {code_ok}       " + t.c("2 tests pass", "green"))
    t.nap(0.7)
    t.w(f"  {t.c(code_bug, 'red')}       ")
    t.nap(0.5)
    t.p(t.c("2 tests pass", "green") + "   " + t.c("survived", "red", "bold") + t.c("  (a bug nobody noticed)", "grey"))
    t.nap(0.8)
    t.p(f"  {t.c('+', 'green')} {t.c('def test_exactly_fifty(): assert shipping_fee(50) == 0', 'green')}")
    t.nap(0.6)
    t.p(f"  {t.c(code_bug, 'red')}       " + t.c("1 test fails", "red") + "   " + t.c("killed", "green", "bold"))
    _ = g


def _scene_checks(t: Term) -> str:
    t.step(2, TOTAL, "Three checks")
    t.p("  Every change carries three checks that the author cannot influence.")
    t.p()
    t.p("  " + t.c("1", "cyan", "bold") + "  Criteria are frozen before the code exists.")
    t.decode("     locked", "4c7f94b79bca0c877c2fddfc86f80beb700300ff39bde270d7618c790f292f12"[:40], duration=0.9)
    t.p()
    t.p("  " + t.c("2", "cyan", "bold") + "  A second model checks each claim. It never sees the author's confidence.")
    t.nap(0.4)
    t.p()
    t.p("  " + t.c("3", "cyan", "bold") + "  Planted bugs. claimcheck breaks the new code on purpose and reruns your tests.")
    t.p()
    _mutation_demo(t)
    t.p()
    t.p("  " + t.c("The share of planted bugs your tests catch is printed next to the author's confidence.", "bold"))
    return t.pause(
        more=(
            "The checks write to .claimcheck/ledger.jsonl, one line per claim per run.\n"
            "Over time that file is the record of how far to trust each author, human or AI."
        ),
    )


# ---- setup ------------------------------------------------------------------

def _scene_setup(t: Term, repo: Path, *, assume_yes: bool) -> dict:
    t.step(3, TOTAL, "Set up this repo")
    det = detect.detect(repo)
    cfg_exists = (C.cc_dir(repo) / C.CONFIG_FILE).exists()
    test_cmd = None
    if not cfg_exists:
        guess = det.test_cmd or "python -m pytest -q"
        label = "detected" if det.test_cmd else "default, nothing detected"
        t.p(f"  Test command: {t.c(guess, 'cyan')} {t.c('(' + label + ')', 'grey')}")
        if det.others:
            t.p("  " + t.c("Also found: " + ", ".join(det.others) + ". Using the first.", "grey"))
        if not assume_yes:
            typed = t.ask(f"  {t.c('?', 'cyan', 'bold')} Press Enter to keep it, or type the command to use> ").strip()
            test_cmd = typed or None
    ci_provider = None
    create_doc = None
    has_agent_file = any((repo / f).is_file() for f in ("CLAUDE.md", ".claude/CLAUDE.md", "AGENTS.md"))
    if not assume_yes:
        if not has_agent_file and t.yes_no("No CLAUDE.md or AGENTS.md found. Create CLAUDE.md with the agent instructions?", default=True):
            create_doc = "claude"
        if t.yes_no("Add a GitHub Actions workflow that runs claimcheck on pull requests?", default=False):
            ci_provider = "github"
    t.p()

    def reveal(name: str, value) -> None:
        if name == "config":
            t.p(f"  {t.c(t.g['ok'], 'green', 'bold')} Config               {t.c('.claimcheck/config.toml (' + str(value) + ')', 'grey')}")
        elif name == "hook":
            t.p(f"  {t.c(t.g['ok'], 'green', 'bold')} Commit hook           {t.c(value['status'], 'grey')}")
        elif name == "gitignore":
            note = f"added {len(value)} lines" if value else "already set"
            t.p(f"  {t.c(t.g['ok'], 'green', 'bold')} .gitignore            {t.c(note, 'grey')}")
        elif name == "agent_docs":
            if value:
                files = ", ".join(f"{x['path']} ({x['action']})" for x in value)
                t.p(f"  {t.c(t.g['ok'], 'green', 'bold')} Agent instructions    {t.c(files, 'grey')}")
            else:
                t.p(f"  {t.c(t.g['ring'], 'grey')} Agent instructions    {t.c('no CLAUDE.md or AGENTS.md to update', 'grey')}")
        elif name == "ci" and value:
            t.p(f"  {t.c(t.g['ok'], 'green', 'bold')} CI workflow           {t.c(value['path'] + ' (' + value['action'] + ')', 'grey')}")
        if name != "detect":
            t.nap(0.25)

    result = initflow.run_setup(repo, create_agent_doc=create_doc, ci_provider=ci_provider, test_cmd=test_cmd, on_step=reveal)
    t.p()
    t.p("  " + t.c("Your coding agent now finds the claimcheck rules in its own instructions file.", "grey"))
    t.pause(
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
    t.step(4, TOTAL, "Connect Claude")
    try:
        if os.environ.get("ANTHROPIC_API_KEY"):
            provider, how = providers.load("auto"), "your Anthropic API key"
        else:
            provider, how = providers.load("auto"), "your Claude Code sign-in"
    except (ProviderError, ImportError, ValueError) as e:
        t.p(f"  {t.c(t.g['bad'], 'red', 'bold')} {e}")
        t.p("  " + t.c("You can still write .claimcheck/spec.md by hand. Setup is otherwise complete.", "grey"))
        return None, str(e)
    t.p(f"  {t.c(t.g['ok'], 'green', 'bold')} Using {how}.")
    t.p("  " + t.c("It writes the spec with you and later checks claims. Nothing leaves your machine except those prompts.", "grey"))
    return provider, how


def _scene_spec(t: Term, repo: Path, provider, *, goal: str | None) -> dict | None:
    t.step(5, TOTAL, "Your first spec")
    t.p("  Claude asks questions, you answer, and the acceptance criteria take shape.")
    t.p("  You can edit any criterion yourself. Nothing is frozen until you say so.")
    t.p()
    if goal is None:
        goal = t.ask(f"  {t.c('?', 'cyan', 'bold')} What do you want built? A sentence or two. Enter to skip> ").strip()
    if not goal:
        t.p("  " + t.c("Skipped. Run `claimcheck spec draft` whenever you are ready.", "grey"))
        return None
    cfg = C.load(repo)
    spinning = _SpinningProvider(provider, t, "Claude is thinking")
    say, ask = indented(t)
    draft, status = specdraft.run_interview(spinning, repo, goal, say=say, ask=ask)
    if status == "quit":
        t.p("  " + t.c("Left without writing. Your answers are kept: `claimcheck spec draft --resume` picks up here.", "grey"))
        return None
    t.p()
    t.box([f"{i}. {c.text}" for i, c in enumerate(draft.criteria, 1)], title="acceptance criteria")
    if not t.yes_no("Freeze these and commit them on a new branch?", default=True):
        specdraft.write_spec(repo, draft)
        t.p("  " + t.c("Wrote .claimcheck/spec.md. Freeze it later with `claimcheck spec freeze`.", "grey"))
        return None
    out = specdraft.finish(repo, cfg, draft)
    t.p()
    t.decode("  criteria locked", out["lock_sha256"], duration=1.0)
    if out.get("branch") and out.get("commit"):
        t.p(f"  Committed {t.c(out['commit'][:8], 'cyan')} on branch {t.c(out['branch'], 'cyan')}.")
    return out


def _finish(t: Term, spec_result: dict | None) -> None:
    t.p()
    t.rule("done")
    t.p()
    steps = []
    if spec_result and spec_result.get("branch"):
        steps.append(f"Have your coding agent build it on {spec_result['branch']}.")
    else:
        steps.append("Write the spec:        claimcheck spec draft")
    steps.append("Check the result:      claimcheck run")
    steps.append("See the board:         the Desk app in app/ (see the README)")
    t.box([f"{i}. {s}" for i, s in enumerate(steps, 1)], title="next", style="green")
    t.p()


# ---- entry point ------------------------------------------------------------

def run_onboarding(t: Term, repo: Path, *, tour: bool = True, goal: str | None = None, assume_yes: bool = False) -> int:
    try:
        _banner(t)
        if tour:
            for scene in (_scene_problem, _scene_checks):
                if scene(t) == "skip":
                    break
        result = _scene_setup(t, repo, assume_yes=assume_yes)
        provider, _ = _connection(t)
        spec_result = None
        if provider is not None:
            try:
                spec_result = _scene_spec(t, repo, provider, goal=goal)
            except ClaimcheckError as e:
                t.p(f"  {t.c(t.g['bad'], 'red', 'bold')} {e}")
                t.p("  " + t.c("Setup is done. Try `claimcheck spec draft` again when ready.", "grey"))
        _finish(t, spec_result)
        _ = result
        return 0
    except (KeyboardInterrupt, EOFError):
        t.restore()
        t.p()
        t.p("  " + t.c("Stopped. Whatever finished is kept. Run `claimcheck init` again to continue.", "grey"))
        return 130
