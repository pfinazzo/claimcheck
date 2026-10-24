"""Independent checker: a fresh model sees only the frozen criteria, the diff, and redacted claims.

@author Patrick Finazzo
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from . import ClaimsError, ProviderError
from . import claims as CL
from . import config as C
from . import gitio
from . import providers
from . import spec as S
from .spec import Criterion

VERDICTS = ("SUPPORTED", "REFUTED", "UNVERIFIABLE")

VERDICT_SCHEMA: dict = {
    "type": "object",
    "properties": {
        "verdicts": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "verdict": {"type": "string", "enum": list(VERDICTS)},
                    "reason": {"type": "string"},
                    "evidence": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["id", "verdict", "reason", "evidence"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["verdicts"],
    "additionalProperties": False,
}

SYSTEM_PROMPT = """\
You are an independent code checker. You receive three things and nothing else: a frozen list of
acceptance criteria, a unified diff, and a list of claims the diff's author makes about it. You were
not given the author's reasoning, confidence, or evidence on purpose. Judge each claim only from the
diff text and the criteria.

For every claim id return exactly one verdict:
- SUPPORTED: the diff text itself demonstrates the claim is true.
- REFUTED: the diff text contradicts the claim, or the kill condition would clearly trip.
- UNVERIFIABLE: the diff alone cannot settle it (needs runtime, other files, or data you do not have).

`evidence` is a list of verbatim lines copied from the diff that drove the verdict (empty for
UNVERIFIABLE). Be literal and skeptical. Reply with JSON only."""


def _redacted(claims: object) -> list[dict]:
    """Accept a ClaimsFile, a list of Claim, or already-redacted dicts; never leak confidence / verified_by."""
    if isinstance(claims, CL.ClaimsFile):
        return CL.redact(claims)
    out: list[dict] = []
    for c in claims or []:  # type: ignore[union-attr]
        if isinstance(c, CL.Claim):
            out.append(CL.redact(CL.ClaimsFile(1, "", "", [c]))[0])
        elif isinstance(c, dict):
            out.append({k: c[k] for k in ("id", "claim", "criteria", "files", "kill_condition") if k in c})
    return out


def build_prompt(criteria: list[Criterion], diff_text: str, claims: object) -> tuple[str, str]:
    """Pure: (system, user). Redacts the claims itself, so confidence / verified_by never reach the model."""
    claims = _redacted(claims)
    crit_lines = "\n".join(f"{c.id}. {c.text}" for c in criteria)
    user = (
        "## Frozen acceptance criteria\n"
        f"{crit_lines}\n\n"
        "## Claims\n"
        "```json\n"
        f"{json.dumps(claims, indent=2, ensure_ascii=False)}\n"
        "```\n\n"
        "## Diff\n"
        "```diff\n"
        f"{diff_text}\n"
        "```\n\n"
        "Return one verdict per claim id."
    )
    return SYSTEM_PROMPT, user


def validate_verdicts(obj: object, claim_ids: set[str]) -> list[str]:
    """Hand-written check of the VERDICT_SCHEMA shape plus id coverage."""
    errs: list[str] = []
    if not isinstance(obj, dict) or set(obj.keys()) != {"verdicts"}:
        return ["top level must be an object with only 'verdicts'"]
    vs = obj["verdicts"]
    if not isinstance(vs, list):
        return ["'verdicts' must be a list"]
    seen: set[str] = set()
    for i, v in enumerate(vs):
        if not isinstance(v, dict):
            errs.append(f"verdicts[{i}] must be an object")
            continue
        if set(v.keys()) != {"id", "verdict", "reason", "evidence"}:
            errs.append(f"verdicts[{i}] has wrong keys: {sorted(v.keys())}")
            continue
        if not isinstance(v["id"], str) or v["id"] not in claim_ids:
            errs.append(f"verdicts[{i}] unknown id {v['id']!r}")
        if v["verdict"] not in VERDICTS:
            errs.append(f"verdicts[{i}] bad verdict {v['verdict']!r}")
        if not isinstance(v["reason"], str):
            errs.append(f"verdicts[{i}] reason must be a string")
        if not isinstance(v["evidence"], list) or any(not isinstance(e, str) for e in v["evidence"]):
            errs.append(f"verdicts[{i}] evidence must be a list of strings")
        if isinstance(v.get("id"), str):
            if v["id"] in seen:
                errs.append(f"verdicts[{i}] duplicate verdict for {v['id']!r}")
            seen.add(v["id"])
    missing = sorted(claim_ids - seen)
    if missing:
        errs.append(f"missing verdicts for {missing}")
    return errs


def _salvage(raw: str, claim_ids: set[str]) -> dict[str, dict]:
    """Best-effort: keep individually valid verdicts from an otherwise invalid reply."""
    out: dict[str, dict] = {}
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError:
        return out
    vs = obj.get("verdicts") if isinstance(obj, dict) else None
    if not isinstance(vs, list):
        return out
    for v in vs:
        if (
            isinstance(v, dict)
            and isinstance(v.get("id"), str)
            and v["id"] in claim_ids
            and v.get("verdict") in VERDICTS
            and isinstance(v.get("reason"), str)
            and isinstance(v.get("evidence"), list)
            and all(isinstance(e, str) for e in v["evidence"])
        ):
            mine = {"id": v["id"], "verdict": v["verdict"], "reason": v["reason"], "evidence": v["evidence"]}
            out[v["id"]] = _worse(out.get(v["id"]), mine)
    return out


_SEVERITY = {"REFUTED": 2, "UNVERIFIABLE": 1, "SUPPORTED": 0}


def _worse(a: dict | None, b: dict) -> dict:
    """Of two verdicts for one claim keep the harsher one. A refutation is never quietly overwritten."""
    if a is None:
        return b
    return a if _SEVERITY[a["verdict"]] >= _SEVERITY[b["verdict"]] else b


def ask(provider: providers.Provider, system: str, user: str, claim_ids: list[str]) -> list[dict]:
    """Call the provider, retry once on an invalid reply, then fill gaps with UNVERIFIABLE."""
    ids = set(claim_ids)
    salvaged: dict[str, dict] = {}
    for _attempt in range(2):
        raw = provider.complete(system, user, schema=VERDICT_SCHEMA)
        try:
            obj = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if not validate_verdicts(obj, ids):
            by_id = {v["id"]: v for v in obj["verdicts"]}
            return [by_id[i] for i in claim_ids]
        # Keep what was usable from this reply: a REFUTED in a flawed first reply must survive a
        # second reply that is also flawed.
        for cid, v in _salvage(raw, ids).items():
            salvaged[cid] = _worse(salvaged.get(cid), v)
    return [
        salvaged.get(
            i, {"id": i, "verdict": "UNVERIFIABLE", "reason": "provider output unparseable", "evidence": []}
        )
        for i in claim_ids
    ]


def run_check(
    repo: Path,
    cfg: C.Config,
    *,
    base: str | None = None,
    provider_name: str | None = None,
    model: str | None = None,
    worktree: bool = False,
    criteria: list[Criterion] | None = None,
    claims_file: CL.ClaimsFile | None = None,
) -> tuple[dict, int]:
    """Returns (result, exit_code). Raises SpecError / ClaimsError / ProviderError."""
    base = base or cfg.base
    provider_name = provider_name or cfg.checker_provider
    model = model or cfg.checker_model

    if criteria is None:
        S.enforce_open_diff_rules(repo, cfg, base)
        criteria = S.verify(repo)
    lock = S.read_lock(repo)
    if claims_file is None:
        claims_file = CL.load_file(CL.claims_path(repo), S.lock_ids(lock))

    diff = gitio.diff_text(repo, base, worktree)
    system, user = build_prompt(criteria, diff, claims_file)
    claim_ids = [c.id for c in claims_file.claims]

    try:
        provider = providers.load(provider_name, model=model)
        verdicts = ask(provider, system, user, claim_ids) if claim_ids else []
    except ValueError as e:
        raise ProviderError(str(e))
    except Exception as e:  # SDK errors, network, import errors
        raise ProviderError(f"{type(e).__name__}: {e}")

    result = {
        "run_id": C.new_run_id(),
        "ts": C.utc_now_iso(),
        "base": gitio.rev_parse(repo, base),
        "head": "worktree" if worktree else gitio.head_sha(repo),
        "spec_lock": C.sha256_bytes(S.lock_path(repo).read_bytes()),
        "provider": provider_name,
        "model": None if provider_name == "stub" else model,
        "verdicts": verdicts,
    }
    runs = C.cc_dir(repo) / C.RUNS_DIR
    runs.mkdir(parents=True, exist_ok=True)
    (runs / f"{result['run_id']}-check.json").write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    code = 2 if any(v["verdict"] == "REFUTED" for v in verdicts) else 0
    return result, code
