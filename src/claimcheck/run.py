"""`claimcheck run`: spec verify -> claims validate -> check -> mutate -> ledger append.

@author Patrick Finazzo
"""

from __future__ import annotations

from pathlib import Path

from . import checker, gitio, ledger, mutate
from . import claims as CL
from . import config as C
from . import spec as S


def run_all(
    repo: Path,
    cfg: C.Config,
    *,
    base: str | None = None,
    worktree: bool = False,
    provider_name: str | None = None,
    model: str | None = None,
    test_cmd: str | None = None,
    max_mutants: int | None = None,
    seed: int = 0,
) -> tuple[dict, int]:
    base = base or cfg.base
    mutate.check_sentinel(repo)  # before paying for a checker call
    gitio.require_diff(repo, base, worktree)  # nothing to verify: stop before the checker, mutation or ledger
    S.enforce_open_diff_rules(repo, cfg, base)
    criteria = S.verify(repo)
    lock = S.read_lock(repo)
    cf = CL.load_file(CL.claims_path(repo), S.lock_ids(lock))

    check_result, check_code = checker.run_check(
        repo, cfg, base=base, provider_name=provider_name, model=model, worktree=worktree,
        criteria=criteria, claims_file=cf,
    )
    mutate_result, mutate_code = mutate.run_mutate(
        repo, cfg, base=base, worktree=worktree, test_cmd=test_cmd, max_mutants=max_mutants,
        seed=seed, criteria_checked=True, claims_file=cf,
    )

    verdict_by_id = {v["id"]: v for v in check_result["verdicts"]}
    per_claim = mutate_result.get("per_claim", {})
    run_id = check_result["run_id"]
    ts = C.utc_now_iso()
    rid = C.repo_id(repo)
    records = []
    for c in cf.claims:
        v = verdict_by_id.get(c.id, {"verdict": "UNVERIFIABLE", "reason": "no verdict", "evidence": []})
        records.append(
            ledger.claim_record(
                ts=ts,
                run_id=run_id,
                repo_id=rid,
                base=check_result["base"],
                head=check_result["head"],
                spec_lock=check_result["spec_lock"],
                author=cf.author,
                claim_id=c.id,
                claim=c.claim,
                confidence=c.confidence,
                criteria=c.criteria,
                files=c.files,
                kill_condition=c.kill_condition,
                checker={
                    "provider": check_result["provider"],
                    "model": check_result["model"],
                    "verdict": v["verdict"],
                    "reason": v["reason"],
                    "evidence": v.get("evidence", []),
                },
                mutation=per_claim.get(c.id, mutate._summary([])),
            )
        )
    appended = ledger.append_atomic(repo, records)
    result = {
        "run_id": run_id,
        "check": check_result,
        "mutate": mutate_result,
        "ledger_lines_appended": appended,
    }
    return result, max(check_code, mutate_code)
