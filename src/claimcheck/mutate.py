"""Mutation harness: four text-level mutation classes applied to added lines only.

@author Patrick Finazzo
"""

from __future__ import annotations

import json
import random
import re
import shutil
import subprocess
import time
from dataclasses import asdict, dataclass
from pathlib import Path

from . import ClaimsError, MutateLockError, ProviderError, SpecError
from . import claims as CL
from . import config as C
from . import gitio
from . import spec as S

CLASSES = ("sign_flip", "off_by_one", "swap_args", "boundary")

_STRING_RE = re.compile(r'"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'')
_INT_RE = re.compile(r"(?<![\w.])\d+(?![\w.])")
_SWAP_RE = re.compile(r"(\w+)\(\s*([^(),\[\]]+?)\s*,\s*([^(),\[\]]+?)\s*\)")
_CMP_RE = re.compile(r"<=|>=|<|>")
_DEF_KEYWORDS = ("def", "function", "fn", "func", "sub", "proc")
_UNARY_PREV_WORDS = {
    "return", "yield", "in", "not", "and", "or", "if", "else", "elif", "while",
    "is", "lambda", "assert", "print", "await", "case", "when", "then", "do",
}


@dataclass
class Mutant:
    file: str
    line_no: int
    cls: str
    original: str
    mutated: str


def _string_spans(line: str) -> list[tuple[int, int]]:
    return [(m.start(), m.end()) for m in _STRING_RE.finditer(line)]


def _in_string(pos: int, spans: list[tuple[int, int]]) -> bool:
    return any(a <= pos < b for a, b in spans)


def _is_unary_minus(line: str, i: int) -> bool:
    """`-` at i, directly followed by an identifier/number, not a binary operator."""
    if i + 1 >= len(line) or not (line[i + 1].isalnum() or line[i + 1] in "_."):
        return False
    j = i - 1
    while j >= 0 and line[j] in " \t":
        j -= 1
    if j < 0:
        return True
    prev = line[j]
    if prev in "([{,=:+*/%<>!&|^~":
        return True
    if prev.isalnum() or prev == "_":
        k = j
        while k >= 0 and (line[k].isalnum() or line[k] == "_"):
            k -= 1
        word = line[k + 1 : j + 1]
        return word in _UNARY_PREV_WORDS
    return False


def _sign_flip(line: str, spans: list[tuple[int, int]]) -> list[str]:
    out: list[str] = []
    for m in re.finditer(r" \+ | - ", line):
        if _in_string(m.start(), spans):
            continue
        rep = " - " if m.group(0) == " + " else " + "
        out.append(line[: m.start()] + rep + line[m.end() :])
    for i, ch in enumerate(line):
        if ch == "-" and not _in_string(i, spans) and _is_unary_minus(line, i):
            out.append(line[:i] + line[i + 1 :])
    return out


def _off_by_one(line: str, spans: list[tuple[int, int]]) -> list[str]:
    out: list[str] = []
    for m in _INT_RE.finditer(line):
        if _in_string(m.start(), spans):
            continue
        n = int(m.group(0))
        out.append(line[: m.start()] + str(n + 1) + line[m.end() :])
    return out


def _swap_args(line: str, spans: list[tuple[int, int]]) -> list[str]:
    for m in _SWAP_RE.finditer(line):
        if _in_string(m.start(), spans):
            continue
        before = line[: m.start()].rstrip()
        prev_word = before.split()[-1] if before.split() else ""
        if prev_word in _DEF_KEYWORDS:
            continue
        name, a, b = m.group(1), m.group(2), m.group(3)
        return [line[: m.start()] + f"{name}({b}, {a})" + line[m.end() :]]
    return []


def _boundary(line: str, spans: list[tuple[int, int]]) -> list[str]:
    out: list[str] = []
    for m in _CMP_RE.finditer(line):
        i, j = m.start(), m.end()
        if _in_string(i, spans):
            continue
        op = m.group(0)
        prev = line[i - 1] if i > 0 else ""
        nxt = line[j] if j < len(line) else ""
        if op in ("<", "<="):
            if prev == "<" or nxt == "<" or nxt == "-" or prev == "=":
                continue
        if op in (">", ">="):
            if prev == ">" or nxt == ">" or prev == "-" or prev == "=":
                continue
        if op == "<" and nxt == ">":
            continue
        rep = {"<": "<=", "<=": "<", ">": ">=", ">=": ">"}[op]
        out.append(line[:i] + rep + line[j:])
    return out


def generate(line: str, file: str = "", line_no: int = 0) -> list[Mutant]:
    """Every applicable mutation of the four classes for one line (no newline)."""
    spans = _string_spans(line)
    mutants: list[Mutant] = []
    for cls, fn in (
        ("sign_flip", _sign_flip),
        ("off_by_one", _off_by_one),
        ("swap_args", _swap_args),
        ("boundary", _boundary),
    ):
        for mutated in fn(line, spans):
            if mutated != line:
                mutants.append(Mutant(file, line_no, cls, line, mutated))
    return mutants


_HUNK_RE = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@")


def added_lines(diff: str, ignore: list[str]) -> list[tuple[str, int, str]]:
    """[(file, post-diff line_no, text)] for every `+` line in non-ignored text files."""
    out: list[tuple[str, int, str]] = []
    file: str | None = None
    line_no = 0
    in_hunk = False
    for raw in diff.splitlines():
        if raw.startswith("diff --git"):
            file = None
            in_hunk = False
            continue
        if raw.startswith("+++ ") and not in_hunk:
            target = raw[4:].strip()
            if target == "/dev/null":
                file = None
            else:
                file = target[2:] if target.startswith("b/") else target
                if C.is_ignored(file, ignore):
                    file = None
            in_hunk = False
            continue
        if raw.startswith("Binary files"):
            file = None
            continue
        m = _HUNK_RE.match(raw)
        if m:
            line_no = int(m.group(1))
            in_hunk = file is not None
            continue
        if not in_hunk or file is None:
            continue
        if raw.startswith("\\"):
            continue
        if raw.startswith("+"):
            out.append((file, line_no, raw[1:]))
            line_no += 1
        elif raw.startswith("-"):
            pass
        else:
            line_no += 1
    return out


def collect(diff: str, ignore: list[str]) -> list[Mutant]:
    mutants: list[Mutant] = []
    for file, line_no, text in added_lines(diff, ignore):
        mutants.extend(generate(text, file, line_no))
    return mutants


def _run_tests(repo: Path, cmd: str, timeout: int) -> tuple[str, float]:
    t0 = time.monotonic()
    try:
        proc = subprocess.run(cmd, shell=True, cwd=repo, capture_output=True, timeout=timeout)
        outcome = "survived" if proc.returncode == 0 else "killed"
    except subprocess.TimeoutExpired:
        outcome = "timeout"
    return outcome, round(time.monotonic() - t0, 3)


def _apply(repo: Path, m: Mutant) -> bytes:
    """Write the mutant; return the original file bytes."""
    p = repo / m.file
    original = p.read_bytes()
    text = original.decode("utf-8")
    nl = "\r\n" if "\r\n" in text else "\n"
    lines = text.split(nl)
    idx = m.line_no - 1
    if idx < 0 or idx >= len(lines) or lines[idx] != m.original:
        raise ProviderError(
            f"{m.file}:{m.line_no} does not match the diff (working tree differs from the diff under test)"
        )
    lines[idx] = m.mutated
    p.write_bytes(nl.join(lines).encode("utf-8"))
    return original


def _restore_file(path: Path, original: bytes) -> None:
    """Put the original bytes back after a mutant run (separate so tests can make it fail)."""
    path.write_bytes(original)


def restore(repo: Path) -> list[str]:
    """`--restore`: copy every backup back, remove the sentinel. Returns restored paths."""
    backup = C.cc_dir(repo) / C.MUTATE_BACKUP_DIR
    restored: list[str] = []
    if backup.exists():
        for f in sorted(p for p in backup.rglob("*") if p.is_file()):
            rel = f.relative_to(backup)
            dest = repo / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(f, dest)
            restored.append(rel.as_posix())
        shutil.rmtree(backup, ignore_errors=True)
    sentinel = C.cc_dir(repo) / C.MUTATE_SENTINEL
    if sentinel.exists():
        sentinel.unlink()
    return restored


def check_sentinel(repo: Path) -> None:
    """Exit 6 when a previous run left its sentinel behind."""
    if (C.cc_dir(repo) / C.MUTATE_SENTINEL).exists():
        raise MutateLockError(
            f"{C.CLAIMCHECK_DIR}/{C.MUTATE_SENTINEL} exists: a previous mutate run did not finish. "
            "Run `claimcheck mutate --restore` to put the backed-up files back."
        )


def _summary(records: list[dict]) -> dict:
    killed = sum(1 for r in records if r["outcome"] == "killed")
    survived = sum(1 for r in records if r["outcome"] == "survived")
    timeout = sum(1 for r in records if r["outcome"] == "timeout")
    total = killed + survived + timeout
    rate = round((killed + timeout) / total, 4) if total else None
    return {"total": total, "killed": killed, "survived": survived, "timeout": timeout, "catch_rate": rate}


def run_mutate(
    repo: Path,
    cfg: C.Config,
    *,
    base: str | None = None,
    worktree: bool = False,
    test_cmd: str | None = None,
    max_mutants: int | None = None,
    seed: int = 0,
    criteria_checked: bool = False,
    claims_file: CL.ClaimsFile | None = None,
) -> tuple[dict, int]:
    base = base or cfg.base
    test_cmd = test_cmd or cfg.test_cmd
    max_mutants = cfg.mutate_max_mutants if max_mutants is None else max_mutants
    timeout = cfg.mutate_timeout_s

    check_sentinel(repo)
    sentinel = C.cc_dir(repo) / C.MUTATE_SENTINEL

    if not criteria_checked:
        S.enforce_open_diff_rules(repo, cfg, base)
        S.verify(repo)

    if claims_file is None:
        try:
            claims_file = CL.load_file(CL.claims_path(repo), S.lock_ids(S.read_lock(repo)))
        except (ClaimsError, SpecError):
            claims_file = None

    diff = gitio.diff_text(repo, base, worktree)
    all_mutants = collect(diff, cfg.ignore)
    rng = random.Random(seed)
    selected = list(all_mutants)
    rng.shuffle(selected)
    selected = selected[:max_mutants]
    selected.sort(key=lambda m: (m.file, m.line_no, CLASSES.index(m.cls), m.mutated))

    baseline, baseline_s = _run_tests(repo, test_cmd, timeout)
    if baseline != "survived":
        raise ProviderError("baseline tests fail; fix them first")

    backup_dir = C.cc_dir(repo) / C.MUTATE_BACKUP_DIR
    records: list[dict] = []
    if selected:
        backup_dir.mkdir(parents=True, exist_ok=True)
        C.cc_dir(repo).mkdir(parents=True, exist_ok=True)
        sentinel.write_text(C.utc_now_iso() + "\n", encoding="utf-8")
        backed_up: set[str] = set()
        # No outer finally on purpose: if a restore fails, the backup dir and the
        # sentinel stay behind so `claimcheck mutate --restore` can recover.
        for m in selected:
            if m.file not in backed_up:
                dest = backup_dir / m.file
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(repo / m.file, dest)
                backed_up.add(m.file)
            original = _apply(repo, m)
            try:
                outcome, dur = _run_tests(repo, test_cmd, timeout)
            finally:
                _restore_file(repo / m.file, original)
            rec = asdict(m)
            rec.update({"outcome": outcome, "duration_s": dur})
            records.append(rec)
        # Every restore succeeded: clean exit.
        shutil.rmtree(backup_dir, ignore_errors=True)
        if sentinel.exists():
            sentinel.unlink()

    per_claim: dict[str, dict] | None = None
    if claims_file is not None:
        per_claim = {}
        for c in claims_file.claims:
            per_claim[c.id] = _summary([r for r in records if r["file"] in c.files])

    result = {
        "run_id": C.new_run_id(),
        "ts": C.utc_now_iso(),
        "base": gitio.rev_parse(repo, base),
        "head": "worktree" if worktree else gitio.head_sha(repo),
        "test_cmd": test_cmd,
        "baseline_s": baseline_s,
        "seed": seed,
        "candidates": len(all_mutants),
        "mutants": records,
        "summary": _summary(records),
    }
    if per_claim is not None:
        result["per_claim"] = per_claim

    runs = C.cc_dir(repo) / C.RUNS_DIR
    runs.mkdir(parents=True, exist_ok=True)
    (runs / f"{result['run_id']}-mutate.json").write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    rate = result["summary"]["catch_rate"]
    code = 0 if rate is None or rate >= cfg.mutate_min_catch_rate else 2
    return result, code
