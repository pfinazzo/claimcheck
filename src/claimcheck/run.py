"""`claimcheck run`: spec verify -> claims validate -> check -> mutate -> ledger append.

@author Patrick Finazzo
"""

from __future__ import annotations

from pathlib import Path

from . import checker, claims, config, gitio, ledger, mutate, spec


def run_all(
    repo: Path,
    *, settings: config.Config,
    base: str | None = None,
    worktree: bool = False,
    provider_name: str | None = None,
    model: str | None = None,
    test_cmd: str | None = None,
    max_mutants: int | None = None,
    seed: int = 0,
) -> tuple[dict, int]:
    """`check` then `mutate` on the same diff. Returns the combined result and the worse exit code."""
    base = base or settings["base"]
    # Before paying for a checker call.
    mutate.check_sentinel(repo)
    # Nothing to verify: stop before the checker, mutation or ledger.
    gitio.ensure_diff(repo, base=base, worktree=worktree)
    spec.check_open_diff_rules(repo, settings=settings, base=base)
    criteria = spec.validate_spec(repo)
    lock = spec.read_lock(repo)
    cf = claims.load_file(claims.resolve_claims_path(repo), lock_ids=spec.list_lock_ids(lock))

    check_result, check_code = checker.run_check(
        repo, settings=settings, base=base, provider_name=provider_name, model=model, worktree=worktree,
        criteria=criteria, claims_file=cf,
    )
    mutate_result, mutate_code = mutate.run_mutate(
        repo, settings=settings, base=base, worktree=worktree, test_cmd=test_cmd, max_mutants=max_mutants,
        seed=seed, criteria_checked=True, claims_file=cf,
    )

    verdict_by_id = {verdict["id"]: verdict for verdict in check_result["verdicts"]}
    per_claim = mutate_result.get("per_claim", {})
    run_id = check_result["run_id"]
    ts = config.format_utc_now()
    rid = config.compute_repo_id(repo)
    records = []
    for claim in cf["claims"]:
        value = verdict_by_id.get(claim["id"], {"verdict": "UNVERIFIABLE", "reason": "no verdict", "evidence": []})
        records.append(
            ledger.build_claim_record(
                timestamp=ts,
                run_id=run_id,
                repo_id=rid,
                base=check_result["base"],
                head=check_result["head"],
                spec_lock=check_result["spec_lock"],
                author=cf["author"],
                claim_id=claim["id"],
                claim=claim["claim"],
                confidence=claim["confidence"],
                criteria=claim["criteria"],
                files=claim["files"],
                kill_condition=claim["kill_condition"],
                checker={
                    "provider": check_result["provider"],
                    "model": check_result["model"],
                    "verdict": value["verdict"],
                    "reason": value["reason"],
                    "evidence": value.get("evidence", []),
                },
                mutation=per_claim.get(claim["id"], mutate._summarize([])),
            )
        )
    appended = ledger.append_atomic(repo, records=records)
    outcome = {
        "run_id": run_id,
        "check": check_result,
        "mutate": mutate_result,
        "ledger_lines_appended": appended,
    }
    return outcome, max(check_code, mutate_code)
