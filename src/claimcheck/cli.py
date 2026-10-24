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
from . import checker, hook, ledger, mutate, run
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


def cmd_init(args: argparse.Namespace) -> int:
    repo = C.find_repo_root()
    d = C.cc_dir(repo)
    d.mkdir(parents=True, exist_ok=True)
    created = []
    for name, content in (
        (C.CONFIG_FILE, C.DEFAULT_CONFIG_TOML),
        (C.SPEC_FILE, C.DEFAULT_SPEC_MD),
        (C.CLAIMS_FILE, C.DEFAULT_CLAIMS_YAML),
        (C.LEDGER_FILE, ""),
    ):
        if _write_if_missing(d / name, content):
            created.append(name)
    (d / C.RUNS_DIR).mkdir(exist_ok=True)
    hook_changed = hook.install(repo)
    _err(f"init: created {created or 'nothing new'}; hook {'installed' if hook_changed else 'already present'}")
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

    p = sub.add_parser("init", help="create .claimcheck/ and install the pre-commit hook")
    p.set_defaults(func=cmd_init)

    p = sub.add_parser("spec", help="freeze or verify the acceptance criteria")
    ss = p.add_subparsers(dest="spec_command")
    ss.required = True
    ss.add_parser("freeze", help="hash the criteria into spec.lock").set_defaults(func=cmd_spec_freeze)
    ss.add_parser("verify", help="refuse if the spec drifted from the lock").set_defaults(func=cmd_spec_verify)

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
        return e.code
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
