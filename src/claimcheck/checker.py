"""Independent checker: a fresh model sees only the frozen criteria, the diff, and redacted claims.

@author Patrick Finazzo
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from . import ProviderError, claims, config, gitio, providers, redact, spec
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


def _to_redacted(source: claims.ClaimsFile | list[claims.Claim] | list[dict] | None) -> list[dict]:
    """Accept a ClaimsFile, a list of Claim, or already-redacted dicts; never leak confidence / verified_by."""
    if isinstance(source, dict):
        return claims.redact(source)
    return claims.redact_claims([char for char in source or [] if isinstance(char, dict)])


def build_prompt(criteria: list[Criterion], *, diff_text: str, claims: claims.ClaimsFile | list[claims.Claim] | list[dict] | None) -> tuple[str, str]:
    """Pure: (system, user). Redacts the claims itself, so confidence / verified_by never reach the model."""
    redacted_claims = _to_redacted(claims)
    crit_lines = "\n".join(f"{criterion['id']}. {criterion['text']}" for criterion in criteria)
    user = (
        "## Frozen acceptance criteria\n"
        f"{crit_lines}\n\n"
        "## Claims\n"
        "```json\n"
        f"{json.dumps(redacted_claims, indent=2, ensure_ascii=False)}\n"
        "```\n\n"
        "## Diff\n"
        "```diff\n"
        f"{diff_text}\n"
        "```\n\n"
        "Return one verdict per claim id."
    )
    return SYSTEM_PROMPT, user


def validate_verdicts(obj: object, *, claim_ids: set[str]) -> list[str]:
    """Hand-written check of the VERDICT_SCHEMA shape plus id coverage."""
    errs: list[str] = []
    if not isinstance(obj, dict) or set(obj.keys()) != {"verdicts"}:
        return ["top level must be an object with only 'verdicts'"]
    vs = obj["verdicts"]
    if not isinstance(vs, list):
        return ["'verdicts' must be a list"]
    seen: set[str] = set()
    for index, value in enumerate(vs):
        errs.extend(_collect_verdict_errors(index, verdict=value, claim_ids=claim_ids))
        verdict_id = value.get("id") if isinstance(value, dict) and set(value.keys()) == VERDICT_KEYS else None
        if not isinstance(verdict_id, str):
            continue
        if verdict_id in seen:
            errs.append(f"verdicts[{index}] duplicate verdict for {verdict_id!r}")
        seen.add(verdict_id)
    missing = sorted(claim_ids - seen)
    if missing:
        errs.append(f"missing verdicts for {missing}")
    return errs


VERDICT_KEYS = {"id", "verdict", "reason", "evidence"}


def _collect_verdict_errors(i: int, *, verdict: Any, claim_ids: set[str]) -> list[str]:
    """What is wrong with one verdict object, on its own (duplicates are checked by the caller)."""
    if not isinstance(verdict, dict):
        return [f"verdicts[{i}] must be an object"]
    if set(verdict.keys()) != VERDICT_KEYS:
        return [f"verdicts[{i}] has wrong keys: {sorted(verdict.keys())}"]
    checks = [
        (not isinstance(verdict["id"], str) or verdict["id"] not in claim_ids, f"verdicts[{i}] unknown id {verdict['id']!r}"),
        (verdict["verdict"] not in VERDICTS, f"verdicts[{i}] bad verdict {verdict['verdict']!r}"),
        (not isinstance(verdict["reason"], str), f"verdicts[{i}] reason must be a string"),
        (
            not isinstance(verdict["evidence"], list) or any(not isinstance(error, str) for error in verdict["evidence"]),
            f"verdicts[{i}] evidence must be a list of strings",
        ),
    ]
    return [message for failed, message in checks if failed]


def _parse_json_or_none(raw: str) -> Any:
    """The parsed reply, or None when the model did not answer in JSON. ask() then retries."""
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


def _extract_salvageable(raw: str, *, claim_ids: set[str]) -> dict[str, dict]:
    """Best-effort: keep individually valid verdicts from an otherwise invalid reply."""
    verdicts_by_id: dict[str, dict] = {}
    parsed = _parse_json_or_none(raw)
    vs = parsed.get("verdicts") if isinstance(parsed, dict) else None
    if not isinstance(vs, list):
        return verdicts_by_id
    for value in vs:
        if (
            isinstance(value, dict)
            and isinstance(value.get("id"), str)
            and value["id"] in claim_ids
            and value.get("verdict") in VERDICTS
            and isinstance(value.get("reason"), str)
            and isinstance(value.get("evidence"), list)
            and all(isinstance(error, str) for error in value["evidence"])
        ):
            mine = {"id": value["id"], "verdict": value["verdict"], "reason": value["reason"], "evidence": value["evidence"]}
            verdicts_by_id[value["id"]] = _pick_worse(verdicts_by_id.get(value["id"]), other=mine)
    return verdicts_by_id


_SEVERITY = {"REFUTED": 2, "UNVERIFIABLE": 1, "SUPPORTED": 0}


def _pick_worse(a: dict | None, *, other: dict) -> dict:
    """Of two verdicts for one claim keep the harsher one. A refutation is never quietly overwritten."""
    if a is None:
        return other
    return a if _SEVERITY[a["verdict"]] >= _SEVERITY[other["verdict"]] else other


def ask(provider: providers.Provider, *, system: str, user: str, claim_ids: list[str]) -> list[dict]:
    """Call the provider, retry once on an invalid reply, then fill gaps with UNVERIFIABLE."""
    ids = set(claim_ids)
    salvaged: dict[str, dict] = {}
    for _attempt in range(2):
        raw = providers.ask_model(provider, system=system, user=user, schema=VERDICT_SCHEMA)
        parsed = _parse_json_or_none(raw)
        if parsed is None:
            continue
        if not validate_verdicts(parsed, claim_ids=ids):
            by_id = {each_verdict["id"]: each_verdict for each_verdict in parsed["verdicts"]}
            return [by_id[claim_id] for claim_id in claim_ids]
        # Keep what was usable from this reply: a REFUTED in a flawed first reply must survive a
        # second reply that is also flawed.
        for cid, value in _extract_salvageable(raw, claim_ids=ids).items():
            salvaged[cid] = _pick_worse(salvaged.get(cid), other=value)
    return [
        salvaged.get(
            claim_id, {"id": claim_id, "verdict": "UNVERIFIABLE", "reason": "provider output unparseable", "evidence": []}
        )
        for claim_id in claim_ids
    ]


def run_check(
    repo: Path,
    *, settings: config.Config,
    base: str | None = None,
    provider_name: str | None = None,
    model: str | None = None,
    worktree: bool = False,
    criteria: list[Criterion] | None = None,
    claims_file: claims.ClaimsFile | None = None,
) -> tuple[dict, int]:
    """Returns (result, exit_code). Raises SpecError / ClaimsError / ProviderError."""
    base = base or settings["base"]
    provider_name = provider_name or settings["checker_provider"]
    model = model or settings["checker_model"]

    # Before any spec, claims or provider work.
    raw_diff = gitio.ensure_diff(repo, base=base, worktree=worktree)

    if criteria is None:
        spec.check_open_diff_rules(repo, settings=settings, base=base)
        criteria = spec.validate_spec(repo)
    lock = spec.read_lock(repo)
    if claims_file is None:
        claims_file = claims.load_file(claims.resolve_claims_path(repo), lock_ids=spec.list_lock_ids(lock))

    # Whatever leaves this process is filtered first: secret files withheld, secret-looking values
    # redacted, size capped. What was held back is recorded in the result (never its content).
    diff, sent = redact.filter_diff(raw_diff)
    system, user = build_prompt(criteria, diff_text=diff, claims=claims_file)
    claim_ids = [claim["id"] for claim in claims_file["claims"]]

    try:
        provider = providers.load(provider_name, model=model)
        verdicts = ask(provider, system=system, user=user, claim_ids=claim_ids) if claim_ids else []
    except ValueError as error:
        raise ProviderError(str(error)) from error
    # SDK errors, network, import errors.
    except Exception as error:
        raise ProviderError(f"{type(error).__name__}: {error}") from error

    outcome = {
        "run_id": config.make_run_id(),
        "ts": config.format_utc_now(),
        "base": gitio.resolve_ref(repo, ref=base),
        "head": "worktree" if worktree else gitio.read_head_sha(repo),
        "spec_lock": config.hash_bytes(spec.resolve_lock_path(repo).read_bytes()),
        "provider": provider_name,
        "model": None if provider_name == "stub" else model,
        "verdicts": verdicts,
        "sent": dict(sent),
    }
    runs = config.resolve_cc_dir(repo) / config.RUNS_DIR
    runs.mkdir(parents=True, exist_ok=True)
    (runs / f"{outcome['run_id']}-check.json").write_text(json.dumps(outcome, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    code = 2 if any(each_verdict["verdict"] == "REFUTED" for each_verdict in verdicts) else 0
    return outcome, code
