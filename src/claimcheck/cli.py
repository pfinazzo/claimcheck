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

from . import ClaimcheckError, __version__
from . import checker, gitio, hook, initflow, ledger, mutate, onboard, providers, run, specdraft, tui
from . import claims as CL
from . import config as C
from . import spec as S


def _out(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, indent=2, sort_keys=True) + "\n")


def _err(msg: str) -> None:
    sys.stderr.write(f"claimcheck: {msg}\n")


def _write_if_missing(path: Path, content: str) -> bool:
    if path.exists():
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8", newline="\n")
    return True


def _interactive() -> bool:
    return bool(sys.stdin.isatty() and sys.stdout.isatty())


def cmd_init(args: argparse.Namespace) -> int:
    repo = C.find_repo_root()
    if args.json:
        _out(initflow.run_setup(repo, create_agent_doc=args.agent_doc, ci_provider=args.ci))
        return 0
    if _interactive() and not args.yes:
        term = tui.Term(animate=False if args.no_animation else None)
        tui.enable_windows_vt()
        return onboard.run_onboarding(term, repo, tour=not args.no_tour, goal=args.goal)
    # Plain mode: same work, no prompts, no animation. This is what scripts and CI get.
    r = initflow.run_setup(repo, create_agent_doc=args.agent_doc, ci_provider=args.ci)
    hook_word = "installed" if r["hook"]["status"] == "installed" else "already present"
    _err(f"init: created {r['created'] or 'nothing new'}; hook {hook_word}")
    sec = r["secrets"]
    if sec["created"] or sec["added"]:
        _err(f"init: secrets first: .gitignore {'created' if sec['created'] else 'updated'} so .env and key files are ignored")
    for tracked in sec["tracked"]:
        _err(f"init: WARNING {tracked} is already committed; ignoring does not remove it. Run: git rm --cached {tracked}")
    if r["gitignore_added"]:
        _err(f"init: added {len(r['gitignore_added'])} lines to .gitignore")
    for doc in r["agent_docs"]:
        _err(f"init: {doc['path']}: {doc['action']}")
    if r["ci"]:
        _err(f"init: {r['ci']['path']}: {r['ci']['action']}")
    _err(f"init: test command is {r['stack']['test_cmd']!r}" + (f" (detected {r['stack']['name']})" if r["stack"]["name"] else " (nothing detected; edit .claimcheck/config.toml)"))
    _err("init: next, write the spec with `claimcheck spec draft`")
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    repo = C.find_repo_root()
    cfg = C.load(repo)
    initialized = (C.cc_dir(repo) / C.CONFIG_FILE).exists()
    spec_state, criteria = "none", 0
    try:
        text, crit = S.read_spec(repo)
        criteria = len(crit)
        placeholder = "Replace this placeholder" in text
        try:
            S.verify(repo)
            spec_state = "frozen"
        except ClaimcheckError:
            spec_state = "none" if placeholder else "draft"
    except ClaimcheckError:
        pass
    try:
        hook_on = "claimcheck" in hook.hook_file(repo).read_text(encoding="utf-8", errors="replace")
    except OSError:
        hook_on = False
    info = {
        "initialized": initialized,
        "spec": spec_state,
        "criteria": criteria,
        "hook": hook_on,
        "base": cfg.base,
        "branch": gitio.current_branch(repo) or None,
        "provider": cfg.checker_provider,
    }
    if args.json:
        _out(info)
    else:
        _err(f"initialized: {info['initialized']}; spec: {spec_state} ({criteria} criteria); hook: {hook_on}; branch: {info['branch']}")
    return 0


def _read_json_stdin() -> dict:
    try:
        data = json.loads(sys.stdin.read())
    except json.JSONDecodeError as e:
        raise ClaimcheckError(f"stdin is not valid JSON: {e}")
    if not isinstance(data, dict):
        raise ClaimcheckError("stdin must be a JSON object")
    return data


def cmd_spec_draft(args: argparse.Namespace) -> int:
    repo = C.find_repo_root()
    cfg = C.load(repo)
    provider_name = args.provider or "auto"

    if args.step:  # one round, stateless: the caller keeps the conversation
        draft = specdraft.Draft.from_dict(_read_json_stdin())
        if not draft.goal.strip():
            raise ClaimcheckError("a goal is needed")
        provider = providers.load(provider_name, model=None)
        reply = specdraft.next_round(provider, draft, specdraft.repo_files(repo), len(draft.rounds) + 1, args.max_rounds)
        _out(
            {
                "questions": [vars(q) for q in reply.questions],
                "criteria": [vars(c) for c in reply.criteria],
                "out_of_scope": reply.out_of_scope,
                "concerns": reply.concerns,
                "ready": reply.ready,
                "lint": {str(i): w for i, w in specdraft.lint(reply.criteria).items()},
            }
        )
        return 0

    if args.finish:
        draft = specdraft.Draft.from_dict(_read_json_stdin())
        if not draft.criteria:
            raise ClaimcheckError("the draft has no criteria")
        _out(
            specdraft.finish(
                repo, cfg, draft, freeze=not args.no_freeze, branch=args.branch, new_branch=not args.no_branch
            )
        )
        return 0

    # interactive conversation in the terminal
    term = tui.Term()
    tui.enable_windows_vt()
    draft = specdraft.load_draft(repo) if args.resume else None
    goal = args.goal or (draft.goal if draft else "")
    if not goal:
        if not _interactive():
            raise ClaimcheckError("pass --goal, or run this in a terminal to be asked")
        goal = term.ask(f"{term.c('?', 'cyan', 'bold')} What do you want built? A sentence or two> ").strip()
    provider = onboard._SpinningProvider(providers.load(provider_name), term, "Claude is thinking")
    draft, status = specdraft.run_interview(
        provider, repo, goal, say=term.p, ask=term.ask, max_rounds=args.max_rounds, draft=draft
    )
    if status == "quit":
        term.p(term.c("Left without writing. `claimcheck spec draft --resume` picks up here.", "grey"))
        return 0
    freeze = not args.no_freeze and (args.yes or (_interactive() and term.yes_no("Freeze these and commit them on a new branch?", default=True)))
    out = specdraft.finish(repo, cfg, draft, freeze=freeze, branch=args.branch, new_branch=not args.no_branch)
    if out["frozen"]:
        term.decode("criteria locked", out["lock_sha256"])
        if out["commit"]:
            term.p(f"Committed {out['commit'][:8]} on {out['branch']}.")
    else:
        term.p(term.c("Wrote .claimcheck/spec.md. Freeze it with `claimcheck spec freeze`.", "grey"))
    return 0


def cmd_spec_freeze(args: argparse.Namespace) -> int:
    repo = C.find_repo_root()
    lock = S.freeze(repo, C.load(repo))
    _out(lock)
    return 0


def cmd_spec_verify(args: argparse.Namespace) -> int:
    repo = C.find_repo_root()
    criteria = S.verify(repo)
    _err(f"spec verify: {len(criteria)} criteria match the lock")
    return 0


def cmd_claims_validate(args: argparse.Namespace) -> int:
    repo = C.find_repo_root()
    path = Path(args.path) if args.path else CL.claims_path(repo)
    lock_ids: set[int] | None
    try:
        lock_ids = S.lock_ids(S.read_lock(repo))
    except ClaimcheckError:
        lock_ids = None  # no lock: any cited criterion is a violation
    cf = CL.load_file(path, lock_ids)
    _err(f"claims validate: {len(cf.claims)} claims ok")
    return 0


def cmd_check(args: argparse.Namespace) -> int:
    repo = C.find_repo_root()
    result, code = checker.run_check(
        repo, C.load(repo), base=args.base, provider_name=args.provider, model=args.model,
        worktree=args.worktree,
    )
    _out(result)
    return code


def cmd_mutate(args: argparse.Namespace) -> int:
    repo = C.find_repo_root()
    if args.restore:
        restored = mutate.restore(repo)
        if (C.cc_dir(repo) / C.MUTATE_SENTINEL).exists():  # a file was refused: do not report success
            _out({"restored": restored, "refused": True})
            return 6
        _out({"restored": restored})
        return 0
    result, code = mutate.run_mutate(
        repo, C.load(repo), base=args.base, worktree=args.worktree, test_cmd=args.test_cmd,
        max_mutants=args.max_mutants, seed=args.seed,
    )
    _out(result)
    return code


def cmd_run(args: argparse.Namespace) -> int:
    repo = C.find_repo_root()
    result, code = run.run_all(
        repo, C.load(repo), base=args.base, worktree=args.worktree, provider_name=args.provider,
        model=args.model, test_cmd=args.test_cmd, max_mutants=args.max_mutants, seed=args.seed,
    )
    _out(result)
    return code


def cmd_hook_pre_commit(args: argparse.Namespace) -> int:
    repo = C.find_repo_root()
    return hook.pre_commit(repo, C.load(repo))


def _add_diff_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("--base", default=None, help="git ref the diff is measured against (config: base)")
    p.add_argument("--worktree", action="store_true", help="diff base against the working tree instead of base...HEAD")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="claimcheck", description="A verification ledger for AI-written diffs.")
    parser.add_argument("--version", action="version", version=f"claimcheck {__version__}")
    sub = parser.add_subparsers(dest="command")
    sub.required = True

    p = sub.add_parser("init", help="guided setup: config, commit hook, .gitignore, agent instructions, first spec")
    p.add_argument("--yes", "-y", action="store_true", help="no prompts and no animation; do the setup and print a summary")
    p.add_argument("--json", action="store_true", help="no prompts; print what was done as one JSON document")
    p.add_argument("--no-tour", action="store_true", help="skip the short explanation and go straight to setup")
    p.add_argument("--no-animation", action="store_true", help="keep the guided flow but turn the animations off")
    p.add_argument("--goal", default=None, help="what you want built; starts the spec conversation with it")
    p.add_argument("--ci", choices=["github"], default=None, help="also write a CI workflow")
    p.add_argument("--agent-doc", choices=["claude", "agents"], default=None, help="create CLAUDE.md or AGENTS.md when neither exists")
    p.set_defaults(func=cmd_init)

    p = sub.add_parser("status", help="where this repo is: set up, spec state, hook, branch")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_status)

    p = sub.add_parser("spec", help="write, freeze or verify the acceptance criteria")
    ss = p.add_subparsers(dest="spec_command")
    ss.required = True
    ss.add_parser("freeze", help="hash the criteria into spec.lock").set_defaults(func=cmd_spec_freeze)
    ss.add_parser("verify", help="refuse if the spec drifted from the lock").set_defaults(func=cmd_spec_verify)
    d = ss.add_parser("draft", help="write the spec as a conversation with Claude")
    d.add_argument("--goal", default=None, help="what you want built")
    d.add_argument("--resume", action="store_true", help="continue the saved conversation")
    d.add_argument("--provider", default=None, help="auto | claude | claude-cli | stub (default auto)")
    d.add_argument("--max-rounds", dest="max_rounds", type=int, default=6)
    d.add_argument("--yes", "-y", action="store_true", help="freeze and commit without asking")
    d.add_argument("--no-freeze", dest="no_freeze", action="store_true", help="write spec.md only")
    d.add_argument("--no-branch", dest="no_branch", action="store_true", help="commit on the current branch")
    d.add_argument("--branch", default=None, help="name for the task branch")
    d.add_argument("--step", action="store_true", help="machine mode: one round, JSON on stdin and stdout")
    d.add_argument("--finish", action="store_true", help="machine mode: write, freeze and commit a JSON draft from stdin")
    d.set_defaults(func=cmd_spec_draft)

    p = sub.add_parser("claims", help="validate claims.yaml")
    cs = p.add_subparsers(dest="claims_command")
    cs.required = True
    cv = cs.add_parser("validate", help="schema-check a claims file")
    cv.add_argument("path", nargs="?", default=None)
    cv.set_defaults(func=cmd_claims_validate)

    p = sub.add_parser("check", help="independent model verdict per claim")
    _add_diff_args(p)
    p.add_argument("--provider", default=None, help="claude | stub")
    p.add_argument("--model", default=None)
    p.set_defaults(func=cmd_check)

    p = sub.add_parser("mutate", help="planted-bug catch rate on the changed lines")
    _add_diff_args(p)
    p.add_argument("--test-cmd", dest="test_cmd", default=None)
    p.add_argument("--max-mutants", dest="max_mutants", type=int, default=None)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--restore", action="store_true", help="put backed-up files back after a crashed run")
    p.set_defaults(func=cmd_mutate)

    p = sub.add_parser("run", help="verify, validate, check, mutate, then append to the ledger")
    _add_diff_args(p)
    p.add_argument("--provider", default=None)
    p.add_argument("--model", default=None)
    p.add_argument("--test-cmd", dest="test_cmd", default=None)
    p.add_argument("--max-mutants", dest="max_mutants", type=int, default=None)
    p.add_argument("--seed", type=int, default=0)
    p.set_defaults(func=cmd_run)

    p = sub.add_parser("hook", help="git hook entry points")
    hs = p.add_subparsers(dest="hook_command")
    hs.required = True
    hs.add_parser("pre-commit", help="reject commits without a covering claims file").set_defaults(func=cmd_hook_pre_commit)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.func(args))
    except ClaimcheckError as e:
        _err(str(e))
        if getattr(args, "json", False) or getattr(args, "step", False) or getattr(args, "finish", False):
            _out({"error": str(e), "code": e.code})  # machine callers read stdout
        return e.code
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
