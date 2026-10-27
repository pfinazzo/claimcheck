"""argparse CLI: init, spec, claims, check, mutate, run, hook.

Exit codes: 0 ok, 2 verdict/threshold failure, 3 spec refusal, 4 claims/hook failure,
5 provider or baseline-test failure, 6 stale mutate sentinel.

@author Patrick Finazzo
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import (
    ClaimcheckError,
    __version__,
    checker,
    claims,
    config,
    gitio,
    hook,
    initflow,
    ledger,
    mutate,
    onboard,
    providers,
    run,
    spec,
    specdraft,
    tui,
)


def _write_out(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, indent=2, sort_keys=True) + "\n")


def _write_err(msg: str) -> None:
    sys.stderr.write(f"claimcheck: {msg}\n")


def _write_if_missing(path: Path, *, content: str) -> bool:
    if path.exists():
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8", newline="\n")
    return True


def _is_interactive() -> bool:
    return bool(sys.stdin.isatty() and sys.stdout.isatty())


def handle_init(args: argparse.Namespace) -> int:
    """`claimcheck init`: guided setup in a terminal, or a plain summary with --yes or --json."""
    repo = config.find_repo_root()
    if args.json:
        _write_out(initflow.run_setup(repo, create_agent_doc=args.agent_doc, ci_provider=args.ci))
        return 0
    if _is_interactive() and not args.yes:
        term = tui.make_term(animate=False if args.no_animation else None)
        tui.set_windows_vt()
        return onboard.run_onboarding(term, repo=repo, tour=not args.no_tour, goal=args.goal)
    # Plain mode: same work, no prompts, no animation. This is what scripts and CI get.
    row = initflow.run_setup(repo, create_agent_doc=args.agent_doc, ci_provider=args.ci)
    hook_word = "installed" if row["hook"]["status"] == "installed" else "already present"
    _write_err(f"init: created {row['created'] or 'nothing new'}; hook {hook_word}")
    sec = row["secrets"]
    if sec["created"] or sec["added"]:
        _write_err(f"init: secrets first: .gitignore {'created' if sec['created'] else 'updated'} so .env and key files are ignored")
    for tracked in sec["tracked"]:
        _write_err(f"init: WARNING {tracked} is already committed; ignoring does not remove it. Run: git rm --cached {tracked}")
    if row["gitignore_added"]:
        _write_err(f"init: added {len(row['gitignore_added'])} lines to .gitignore")
    for doc in row["agent_docs"]:
        _write_err(f"init: {doc['path']}: {doc['action']}")
    if row["ci"]:
        _write_err(f"init: {row['ci']['path']}: {row['ci']['action']}")
    _write_err(f"init: test command is {row['stack']['test_cmd']!r}" + (f" (detected {row['stack']['name']})" if row["stack"]["name"] else " (nothing detected; edit .claimcheck/config.toml)"))
    _write_err("init: next, write the spec with `claimcheck spec draft`")
    return 0


def _read_spec_state(repo: Path) -> tuple[str, int]:
    """("none" | "draft" | "frozen", number of criteria). A repo with no readable spec is ("none", 0)."""
    try:
        text, crit = spec.read_spec(repo)
    except ClaimcheckError:
        return "none", 0
    try:
        spec.validate_spec(repo)
    except ClaimcheckError:
        return ("none" if "Replace this placeholder" in text else "draft"), len(crit)
    return "frozen", len(crit)


def handle_status(args: argparse.Namespace) -> int:
    """`claimcheck status`: what is set up in this repo and where the spec stands."""
    repo = config.find_repo_root()
    cfg = config.load(repo)
    initialized = (config.resolve_cc_dir(repo) / config.CONFIG_FILE).exists()
    spec_state, criteria = _read_spec_state(repo)
    try:
        hook_on = "claimcheck" in hook.resolve_hook_file(repo).read_text(encoding="utf-8", errors="replace")
    except OSError:
        hook_on = False
    details = {
        "initialized": initialized,
        "spec": spec_state,
        "criteria": criteria,
        "hook": hook_on,
        "base": cfg["base"],
        "branch": gitio.read_current_branch(repo) or None,
        "provider": cfg["checker_provider"],
    }
    if args.json:
        _write_out(details)
    else:
        _write_err(f"initialized: {details['initialized']}; spec: {spec_state} ({criteria} criteria); hook: {hook_on}; branch: {details['branch']}")
    return 0


def _read_json_stdin() -> dict:
    try:
        raw = json.loads(sys.stdin.read())
    except json.JSONDecodeError as error:
        raise ClaimcheckError(f"stdin is not valid JSON: {error}") from error
    if not isinstance(raw, dict):
        raise ClaimcheckError("stdin must be a JSON object")
    return raw


def handle_spec_draft(args: argparse.Namespace) -> int:
    """`claimcheck spec draft`: the spec interview, one stateless round (--step), or writing the result (--finish)."""
    repo = config.find_repo_root()
    cfg = config.load(repo)
    provider_name = args.provider or "auto"

    # One round, stateless: the caller keeps the conversation.
    if args.step:
        round_draft = specdraft.draft_from_dict(_read_json_stdin())
        if not round_draft["goal"].strip():
            raise ClaimcheckError("a goal is needed")
        provider = providers.load(provider_name, model=None)
        reply = specdraft.next_round(provider, draft=round_draft, files=specdraft.list_repo_files(repo), round_no=len(round_draft["rounds"]) + 1, max_rounds=args.max_rounds)
        _write_out(
            {
                "questions": [dict(question) for question in reply["questions"]],
                "criteria": [dict(criterion) for criterion in reply["criteria"]],
                "out_of_scope": reply["out_of_scope"],
                "concerns": reply["concerns"],
                "ready": reply["ready"],
                "lint": {str(key): value for key, value in specdraft.check_criteria(reply["criteria"]).items()},
            }
        )
        return 0

    if args.finish:
        piped_draft = specdraft.draft_from_dict(_read_json_stdin())
        if not piped_draft["criteria"]:
            raise ClaimcheckError("the draft has no criteria")
        _write_out(
            specdraft.apply_draft(
                repo, settings=cfg, draft=piped_draft, freeze=not args.no_freeze, branch=args.branch, new_branch=not args.no_branch
            )
        )
        return 0

    # interactive conversation in the terminal
    term = tui.make_term()
    tui.set_windows_vt()
    draft = specdraft.load_draft(repo) if args.resume else None
    goal = args.goal or (draft["goal"] if draft else "")
    if not goal:
        if not _is_interactive():
            raise ClaimcheckError("pass --goal, or run this in a terminal to be asked")
        goal = tui.ask(term, prompt=f"{tui.format_styled(term, text='?', styles=('cyan', 'bold'))} What do you want built? A sentence or two> ").strip()
    provider = onboard.wrap_with_spinner(providers.load(provider_name), term=term, label="Claude is thinking")
    draft, status = specdraft.run_interview(
        provider, repo=repo, goal=goal, say=lambda line: tui.write_line(term, text=line), ask=lambda question: tui.ask(term, prompt=question), max_rounds=args.max_rounds, draft=draft
    )
    if status == "quit":
        tui.write_line(term, text=tui.format_styled(term, text="Left without writing. `claimcheck spec draft --resume` picks up here.", styles=("grey",)))
        return 0
    freeze = not args.no_freeze and (args.yes or (_is_interactive() and tui.ask_yes_no(term, question="Freeze these and commit them on a new branch?", default=True)))
    output = specdraft.apply_draft(repo, settings=cfg, draft=draft, freeze=freeze, branch=args.branch, new_branch=not args.no_branch)
    if output["frozen"]:
        tui.show_decode(term, label="criteria locked", final=output["lock_sha256"])
        if output["commit"]:
            tui.write_line(term, text=f"Committed {output['commit'][:8]} on {output['branch']}.")
    else:
        tui.write_line(term, text=tui.format_styled(term, text="Wrote .claimcheck/spec.md. Freeze it with `claimcheck spec freeze`.", styles=("grey",)))
    return 0


def handle_spec_freeze(args: argparse.Namespace) -> int:
    """`claimcheck spec freeze`: write spec.lock for the current criteria."""
    repo = config.find_repo_root()
    lock = spec.freeze(repo, settings=config.load(repo))
    _write_out(lock)
    return 0


def handle_spec_verify(args: argparse.Namespace) -> int:
    """`claimcheck spec verify`: fail when the spec no longer matches its lock."""
    repo = config.find_repo_root()
    criteria = spec.validate_spec(repo)
    _write_err(f"spec verify: {len(criteria)} criteria match the lock")
    return 0


def handle_claims_validate(args: argparse.Namespace) -> int:
    """`claimcheck claims validate`: check the claims file against the schema and the lock."""
    repo = config.find_repo_root()
    path = Path(args.path) if args.path else claims.resolve_claims_path(repo)
    lock_ids: set[int] | None
    try:
        lock_ids = spec.list_lock_ids(spec.read_lock(repo))
    except ClaimcheckError:
        # No lock: any cited criterion is a violation.
        lock_ids = None
    claims_file = claims.load_file(path, lock_ids=lock_ids)
    _write_err(f"claims validate: {len(claims_file['claims'])} claims ok")
    return 0


def handle_check(args: argparse.Namespace) -> int:
    """`claimcheck check`: the blind check of each claim against the diff."""
    repo = config.find_repo_root()
    report, code = checker.run_check(
        repo, settings=config.load(repo), base=args.base, provider_name=args.provider, model=args.model,
        worktree=args.worktree,
    )
    _write_out(report)
    return code


def handle_mutate(args: argparse.Namespace) -> int:
    """`claimcheck mutate`: plant bugs and run the tests, or put files back with --restore."""
    repo = config.find_repo_root()
    if args.restore:
        restored = mutate.reset_from_backups(repo)
        # A file was refused: do not report success.
        if (config.resolve_cc_dir(repo) / config.MUTATE_SENTINEL).exists():
            _write_out({"restored": restored, "refused": True})
            return 6
        _write_out({"restored": restored})
        return 0
    report, code = mutate.run_mutate(
        repo, settings=config.load(repo), base=args.base, worktree=args.worktree, test_cmd=args.test_cmd,
        max_mutants=args.max_mutants, seed=args.seed,
    )
    _write_out(report)
    return code


def handle_run(args: argparse.Namespace) -> int:
    """`claimcheck run`: check, then mutate."""
    repo = config.find_repo_root()
    report, code = run.run_all(
        repo, settings=config.load(repo), base=args.base, worktree=args.worktree, provider_name=args.provider,
        model=args.model, test_cmd=args.test_cmd, max_mutants=args.max_mutants, seed=args.seed,
    )
    _write_out(report)
    return code


def handle_verify_ledger(args: argparse.Namespace) -> int:
    """`claimcheck verify-ledger`: the hash chain is intact and, with --base, the ledger only grew."""
    repo = config.find_repo_root()
    path = ledger.resolve_ledger_path(repo)
    lines = ledger.split_ledger_lines(path.read_bytes() if path.exists() else b"")
    outcome = ledger.check_chain(lines)
    if args.base:
        # A base that does not exist is an error, not "no ledger there".
        gitio.resolve_ref(repo, ref=args.base)
        text = gitio.show_file_at(repo, ref=args.base, path=f"{config.CLAIMCHECK_DIR}/{config.LEDGER_FILE}")
        ledger.check_grew_only(lines, base_lines=ledger.split_ledger_lines((text or "").encode("utf-8")), ref=args.base)
    outcome["base"] = args.base
    _write_err(
        f"ledger ok: {outcome['lines']} lines, {outcome['chained']} chained"
        + (f", {outcome['legacy']} older without a hash" if outcome["legacy"] else "")
        + (f", unchanged beginning of {args.base}" if args.base else "")
    )
    _write_out(outcome)
    return 0


def handle_hook_pre_commit(args: argparse.Namespace) -> int:
    """The pre-commit hook: refuse a commit whose code changes no claim covers."""
    repo = config.find_repo_root()
    return hook.run_pre_commit(repo, settings=config.load(repo))


def _add_diff_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("--base", default=None, help="git ref the diff is measured against (config: base)")
    p.add_argument("--worktree", action="store_true", help="diff base against the working tree instead of base...HEAD")


def build_parser() -> argparse.ArgumentParser:
    """The argument parser for every claimcheck command."""
    parser = argparse.ArgumentParser(prog="claimcheck", description="A verification ledger for AI-written diffs.")
    parser.add_argument("--version", action="version", version=f"claimcheck {__version__}")
    sub = parser.add_subparsers(dest="command")
    sub.required = True

    command_parser = sub.add_parser("init", help="guided setup: config, commit hook, .gitignore, agent instructions, first spec")
    command_parser.add_argument("--yes", "-y", action="store_true", help="no prompts and no animation; do the setup and print a summary")
    command_parser.add_argument("--json", action="store_true", help="no prompts; print what was done as one JSON document")
    command_parser.add_argument("--no-tour", action="store_true", help="skip the short explanation and go straight to setup")
    command_parser.add_argument("--no-animation", action="store_true", help="keep the guided flow but turn the animations off")
    command_parser.add_argument("--goal", default=None, help="what you want built; starts the spec conversation with it")
    command_parser.add_argument("--ci", choices=["github"], default=None, help="also write a CI workflow")
    command_parser.add_argument("--agent-doc", choices=["claude", "agents"], default=None, help="create CLAUDE.md or AGENTS.md when neither exists")
    command_parser.set_defaults(func=handle_init)

    command_parser = sub.add_parser("status", help="where this repo is: set up, spec state, hook, branch")
    command_parser.add_argument("--json", action="store_true")
    command_parser.set_defaults(func=handle_status)

    command_parser = sub.add_parser("spec", help="write, freeze or verify the acceptance criteria")
    spec_commands = command_parser.add_subparsers(dest="spec_command")
    spec_commands.required = True
    spec_commands.add_parser("freeze", help="hash the criteria into spec.lock").set_defaults(func=handle_spec_freeze)
    spec_commands.add_parser("verify", help="refuse if the spec drifted from the lock").set_defaults(func=handle_spec_verify)
    draft_parser = spec_commands.add_parser("draft", help="write the spec as a conversation with Claude")
    draft_parser.add_argument("--goal", default=None, help="what you want built")
    draft_parser.add_argument("--resume", action="store_true", help="continue the saved conversation")
    draft_parser.add_argument("--provider", default=None, help="auto | claude | claude-cli | stub (default auto)")
    draft_parser.add_argument("--max-rounds", dest="max_rounds", type=int, default=6)
    draft_parser.add_argument("--yes", "-y", action="store_true", help="freeze and commit without asking")
    draft_parser.add_argument("--no-freeze", dest="no_freeze", action="store_true", help="write spec.md only")
    draft_parser.add_argument("--no-branch", dest="no_branch", action="store_true", help="commit on the current branch")
    draft_parser.add_argument("--branch", default=None, help="name for the task branch")
    draft_parser.add_argument("--step", action="store_true", help="machine mode: one round, JSON on stdin and stdout")
    draft_parser.add_argument("--finish", action="store_true", help="machine mode: write, freeze and commit a JSON draft from stdin")
    draft_parser.set_defaults(func=handle_spec_draft)

    command_parser = sub.add_parser("claims", help="validate claims.yaml")
    claims_commands = command_parser.add_subparsers(dest="claims_command")
    claims_commands.required = True
    cv = claims_commands.add_parser("validate", help="schema-check a claims file")
    cv.add_argument("path", nargs="?", default=None)
    cv.set_defaults(func=handle_claims_validate)

    command_parser = sub.add_parser("check", help="independent model verdict per claim")
    _add_diff_args(command_parser)
    command_parser.add_argument("--provider", default=None, help="claude | stub")
    command_parser.add_argument("--model", default=None)
    command_parser.set_defaults(func=handle_check)

    command_parser = sub.add_parser("mutate", help="planted-bug catch rate on the changed lines")
    _add_diff_args(command_parser)
    command_parser.add_argument("--test-cmd", dest="test_cmd", default=None)
    command_parser.add_argument("--max-mutants", dest="max_mutants", type=int, default=None)
    command_parser.add_argument("--seed", type=int, default=0)
    command_parser.add_argument("--restore", action="store_true", help="put backed-up files back after a crashed run")
    command_parser.set_defaults(func=handle_mutate)

    command_parser = sub.add_parser("run", help="verify, validate, check, mutate, then append to the ledger")
    _add_diff_args(command_parser)
    command_parser.add_argument("--provider", default=None)
    command_parser.add_argument("--model", default=None)
    command_parser.add_argument("--test-cmd", dest="test_cmd", default=None)
    command_parser.add_argument("--max-mutants", dest="max_mutants", type=int, default=None)
    command_parser.add_argument("--seed", type=int, default=0)
    command_parser.set_defaults(func=handle_run)

    command_parser = sub.add_parser("verify-ledger", help="fail if a ledger line was removed, edited, moved or inserted")
    command_parser.add_argument("--base", default=None, help="also require the ledger at this git ref to be an unchanged beginning of the current one")
    command_parser.set_defaults(func=handle_verify_ledger)

    command_parser = sub.add_parser("hook", help="git hook entry points")
    hook_commands = command_parser.add_subparsers(dest="hook_command")
    hook_commands.required = True
    hook_commands.add_parser("pre-commit", help="reject commits without a covering claims file").set_defaults(func=handle_hook_pre_commit)

    return parser


def main(argv: list[str] | None = None) -> int:
    """Run the command line. Returns the exit code; a ClaimcheckError becomes its message and code."""
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.func(args))
    except ClaimcheckError as problem:
        _write_err(str(problem))
        if getattr(args, "json", False) or getattr(args, "step", False) or getattr(args, "finish", False):
            # Machine callers read stdout.
            _write_out({"error": str(problem), "code": problem.code})
        return problem.code
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
