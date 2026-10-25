"""Mutation harness: four text-level mutation classes applied to added lines only.

@author Patrick Finazzo
"""

from __future__ import annotations

import hashlib
import json
import os
import random
import re
import shutil
import signal
import subprocess
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path

from . import ClaimsError, MutateLockError, ProviderError, SpecError, gitio
from . import claims as CL
from . import config as C
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
        if op in ("<", "<=") and (prev in ("<", "=") or nxt in ("<", "-")):
            continue
        if op in (">", ">=") and (prev in (">", "-", "=") or nxt == ">"):
            continue
        if op == "<" and nxt == ">":
            continue
        rep = {"<": "<=", "<=": "<", ">": ">=", ">=": ">"}[op]
        out.append(line[:i] + rep + line[j:])
    return out


def generate(line: str, file: str = "", line_no: int = 0) -> list[Mutant]:
    """Every applicable mutation of the four classes for one line (no newline)."""
    spans = _string_spans(line)
    mutations = (
        ("sign_flip", _sign_flip),
        ("off_by_one", _off_by_one),
        ("swap_args", _swap_args),
        ("boundary", _boundary),
    )
    return [
        Mutant(file, line_no, cls, line, mutated)
        for cls, fn in mutations
        for mutated in fn(line, spans)
        if mutated != line
    ]


_HUNK_RE = re.compile(r"^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")
_BOM = "﻿"
_GIT_ESCAPES = {"n": 10, "t": 9, "r": 13, "a": 7, "b": 8, "f": 12, "v": 11, '"': 34, "\\": 92}


def _unquote_git_path(s: str) -> str:
    """Undo git's C-style quoting of a path in a diff header ("caf\\303\\251.py")."""
    if len(s) < 2 or s[0] != '"' or s[-1] != '"':
        return s
    body = s[1:-1]
    out = bytearray()
    i = 0
    while i < len(body):
        chunk, i = _read_quoted_char(body, i)
        out += chunk
    return out.decode("utf-8", "replace")


def _read_quoted_char(body: str, i: int) -> tuple[bytes, int]:
    """The bytes for the character or escape at `i` in a git-quoted path, and where the next one starts."""
    nxt = body[i + 1] if body[i] == "\\" and i + 1 < len(body) else ""
    if nxt and nxt in "01234567":
        j = i + 1
        while j < len(body) and j < i + 4 and body[j] in "01234567":
            j += 1
        return bytes([int(body[i + 1 : j], 8) & 0xFF]), j
    if nxt and nxt in _GIT_ESCAPES:
        return bytes([_GIT_ESCAPES[nxt]]), i + 2
    return body[i].encode("utf-8"), i + 1


def _header_path(raw: str) -> str | None:
    """File named by a `+++ ` header line, or None for /dev/null."""
    target = raw[4:].rstrip("\r")
    if not target.startswith('"'):
        # Git appends a tab after names that contain spaces.
        target = target.split("\t")[0]
    target = _unquote_git_path(target)
    if target == "/dev/null":
        return None
    return target[2:] if target.startswith("b/") else target


def _step_hunk_body(
    raw: str, file: str | None, line_no: int, old_left: int, new_left: int
) -> tuple[list[tuple[str, int, str]], int, int, int]:
    """One line inside a hunk. Returns (lines it adds, line_no, old_left, new_left) after it."""
    if raw.startswith("\\"):
        return [], line_no, old_left, new_left
    if raw.startswith("+"):
        added = [(file, line_no, raw[1:].rstrip("\r"))] if file is not None else []
        return added, line_no + 1, old_left, new_left - 1
    if raw.startswith("-"):
        return [], line_no, old_left - 1, new_left
    return [], line_no + 1, old_left - 1, new_left - 1


def _is_file_boundary(raw: str, prev: str) -> bool:
    """Whether this line starts a new file in the diff: its header, its `+++` name, or a binary marker."""
    return raw.startswith(("diff --git", "Binary files", "GIT binary patch")) or (raw.startswith("+++ ") and prev.startswith("--- "))


def _file_after_boundary(raw: str, ignore: list[str]) -> str | None:
    """The file later `+` lines belong to: the `+++` name unless ignored, else none yet."""
    file = _header_path(raw) if raw.startswith("+++ ") else None
    return None if file is None or C.is_ignored(file, ignore) else file


def added_lines(diff: str, ignore: list[str]) -> list[tuple[str, int, str]]:
    """[(file, post-diff line_no, text)] for every `+` line in non-ignored text files.

    Hunk bodies are consumed by the line counts in their `@@` header, so a content line that
    happens to look like a file header (`+++ x` inside an ignored markdown hunk) is never
    mistaken for one. The diff is split on newline only: form feeds and U+2028 are content.
    """
    out: list[tuple[str, int, str]] = []
    file: str | None = None
    line_no = 0
    old_left = new_left = 0
    prev = ""
    for raw in diff.split("\n"):
        hunk = _HUNK_RE.match(raw)
        if old_left > 0 or new_left > 0:
            added, line_no, old_left, new_left = _step_hunk_body(raw, file, line_no, old_left, new_left)
            out.extend(added)
        elif _is_file_boundary(raw, prev):
            file = _file_after_boundary(raw, ignore)
        elif hunk:
            old_left = int(hunk.group(1)) if hunk.group(1) is not None else 1
            line_no = int(hunk.group(2))
            new_left = int(hunk.group(3)) if hunk.group(3) is not None else 1
        elif file is not None and raw.startswith("+") and not raw.startswith("+++ "):
            # Tolerate a hand-written hunk whose header under-counts its lines.
            out.append((file, line_no, raw[1:].rstrip("\r")))
            line_no += 1
        prev = raw
    return [
        (f, n, t[len(_BOM) :] if n == 1 and t.startswith(_BOM) else t) for f, n, t in out
    ]


def collect(diff: str, ignore: list[str]) -> list[Mutant]:
    """Every mutant for every added line in the diff, skipping ignored files."""
    mutants: list[Mutant] = []
    for file, line_no, text in added_lines(diff, ignore):
        mutants.extend(generate(text, file, line_no))
    return mutants


_TEST_ENV_OVERRIDES = {
    # A planted bug must never be baked into a .pyc: Python keys a .pyc on (mtime in whole
    # seconds, size), so a same-size mutant restored within the same second would keep
    # being imported after the file is back to normal.
    "PYTHONDONTWRITEBYTECODE": "1",
}


# taskkill and a killed process normally finish at once; these stop a stuck one from hanging the run.
_KILL_TIMEOUT_S = 10


def _signal_tree(proc: subprocess.Popen) -> None:
    """Send the kill to the test command's whole process tree."""
    if os.name == "nt":
        try:
            subprocess.run(
                ["taskkill", "/T", "/F", "/PID", str(proc.pid)],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL, check=False,
                timeout=_KILL_TIMEOUT_S,
            )
        except subprocess.TimeoutExpired:
            # taskkill hung. _kill_tree still kills the shell itself right after this.
            return
        return
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except ProcessLookupError:
        # The test command already exited, so its group is gone and there is nothing left to signal.
        return


def _kill_tree(proc: subprocess.Popen) -> None:
    """Kill the test command and everything it started (shell=True only gives us the shell)."""
    _signal_tree(proc)
    proc.kill()
    try:
        proc.wait(timeout=_KILL_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        # A process stuck in the kernel can ignore SIGKILL for a while. The run moves on rather
        # than hang; the operating system reaps the process once it lets go.
        return


def _run_tests(repo: Path, cmd: str, timeout: int) -> tuple[str, float]:
    t0 = time.monotonic()
    env = dict(os.environ)
    env.update(_TEST_ENV_OVERRIDES)
    # mypy only narrows on sys.platform, so the Windows-only flag is guarded by it.
    kw: dict = {}
    if sys.platform == "win32":
        kw["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        kw["start_new_session"] = True
    proc = subprocess.Popen(
        cmd, shell=True, cwd=repo, env=env,
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **kw,
    )
    try:
        rc = proc.wait(timeout=timeout)
        outcome = "survived" if rc == 0 else "killed"
    except subprocess.TimeoutExpired:
        _kill_tree(proc)
        outcome = "timeout"
    except BaseException:
        _kill_tree(proc)
        raise
    return outcome, round(time.monotonic() - t0, 3)


# ---- file model: bytes in, bytes out, line endings kept per line -----------------------

_UTF8_BOM = b"\xef\xbb\xbf"


@dataclass
class _FileState:
    data: bytes
    sha: str
    atime_ns: int
    mtime_ns: int
    bom: bool
    # (content without its line ending, that line's own ending)
    lines: list[tuple[bytes, bytes]]

    def render(self, idx: int, new_content: bytes) -> bytes:
        parts = [_UTF8_BOM] if self.bom else []
        for i, (content, eol) in enumerate(self.lines):
            parts.append(new_content + eol if i == idx else content + eol)
        return b"".join(parts)


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _parse_bytes(data: bytes, atime_ns: int = 0, mtime_ns: int = 0) -> _FileState:
    body = data
    bom = body.startswith(_UTF8_BOM)
    if bom:
        body = body[len(_UTF8_BOM) :]
    *ended, tail = body.split(b"\n")
    lines = [(part[:-1], b"\r\n") if part.endswith(b"\r") else (part, b"\n") for part in ended]
    # A last line with no newline is kept; an empty tail is just the final newline.
    lines += [(tail, b"")] if tail else []
    return _FileState(data, _sha(data), atime_ns, mtime_ns, bom, lines)


def _load(repo: Path, rel: str) -> _FileState:
    root = repo.resolve()
    p = (repo / rel).resolve()
    if root != p and root not in p.parents:
        raise OSError("path is outside the repository")
    st = p.stat()
    return _parse_bytes(p.read_bytes(), st.st_atime_ns, st.st_mtime_ns)


def _check(state: _FileState | None, m: Mutant) -> str:
    """'ok', 'undecodable' (skip the line), or 'mismatch' (the file is not what the diff says)."""
    if state is None:
        return "mismatch"
    idx = m.line_no - 1
    if idx < 0 or idx >= len(state.lines):
        return "mismatch"
    try:
        text = state.lines[idx][0].decode("utf-8")
    except UnicodeDecodeError:
        return "undecodable"
    return "ok" if text == m.original else "mismatch"


def _drift_message(m: Mutant) -> str:
    return f"{m.file} line {m.line_no} no longer matches the diff; commit or stash your edits and rerun"


def _write_times(path: Path, atime_ns: int, mtime_ns: int) -> None:
    """Set a file's access and modified times."""
    try:
        os.utime(path, ns=(atime_ns, mtime_ns))
    except PermissionError:
        # Some filesystems refuse to set times on files we can still write. The bytes are what
        # make the file correct; a refused time only makes tools like make rebuild it.
        return


def _restore_file(path: Path, original: bytes, times: tuple[int, int] | None = None) -> None:
    """Put the original bytes back after a mutant run (separate so tests can make it fail).

    `times` is (atime_ns, mtime_ns) of the original file: putting them back keeps the file
    looking untouched to Python's .pyc cache, make, and friends.
    """
    path.write_bytes(original)
    if times is not None:
        _write_times(path, *times)


# ---- sentinel and backups ----------------------------------------------------------------

def _write_sentinel(path: Path, files: dict[str, dict]) -> None:
    payload = {"version": 2, "ts": C.utc_now_iso(), "files": files}
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def _read_sentinel(path: Path) -> dict[str, dict]:
    """Recorded per-file hashes, or {} when the sentinel is missing, old, or unreadable."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        files = data.get("files", {})
        return files if isinstance(files, dict) else {}
    except (OSError, ValueError, AttributeError):
        return {}


def _why_not_restorable(info: object, bak: bytes, cur: bytes | None) -> str | None:
    """The reason a backup may not be written over the current file, or None when it may."""
    if not isinstance(info, dict):
        return "the lock file has no record of what the run wrote, so your edits cannot be told apart from the planted bug"
    if info.get("original_sha256") != _sha(bak):
        return "the backup does not match the recorded original"
    if cur is None:
        return "the file is missing or not a regular file"
    if _sha(cur) not in (info["original_sha256"], info.get("mutated_sha256")):
        return "it changed since the run (it is neither the original nor the planted bug)"
    return None


def _restore_one(repo: Path, backup_file: Path, record: dict[str, dict]) -> tuple[bool, str | None]:
    """Put one backup back.

    Returns (whether the original was written, the reason the file was kept or None). A file that
    already equals the original only loses its backup.
    """
    rel = backup_file.relative_to(C.cc_dir(repo) / C.MUTATE_BACKUP_DIR).as_posix()
    dest = repo / rel
    info = record.get(rel)
    try:
        bak = backup_file.read_bytes()
        cur = dest.read_bytes() if dest.is_file() else None
    except OSError as e:
        return False, f"cannot read it ({e})"
    why = _why_not_restorable(info, bak, cur)
    if why is not None or info is None or cur is None:
        return False, why
    if _sha(cur) == info["original_sha256"]:
        backup_file.unlink()
        return False, None
    try:
        dest.write_bytes(bak)
        if "mtime_ns" in info:
            _write_times(dest, int(info.get("atime_ns", info["mtime_ns"])), int(info["mtime_ns"]))
    except OSError as e:
        return False, f"writing it failed ({e})"
    backup_file.unlink()
    return True, None


def restore(repo: Path) -> list[str]:
    """`--restore`: put backed-up originals back, but never over work the run did not write.

    A file is overwritten only when its current bytes equal the mutated text this run last
    wrote. A file that already equals the original is left alone; a file that equals
    neither was edited by the user, so it is kept, its backup stays, and a line on stderr
    says which file and why. Returns the restored paths.
    """
    cc = C.cc_dir(repo)
    backup = cc / C.MUTATE_BACKUP_DIR
    sentinel = cc / C.MUTATE_SENTINEL
    record = _read_sentinel(sentinel)
    backups = sorted(p for p in backup.rglob("*") if p.is_file()) if backup.exists() else []
    outcomes = {f.relative_to(backup).as_posix(): _restore_one(repo, f, record) for f in backups}
    restored = [rel for rel, (was_written, _) in outcomes.items() if was_written]
    refused = {rel: record.get(rel) or {} for rel, (_, why) in outcomes.items() if why is not None}
    for rel, (_, why) in outcomes.items():
        if why is not None:
            sys.stderr.write(
                f"claimcheck: not restoring {rel}: {why}. The file was left as it is and the backup "
                f"is still at {C.CLAIMCHECK_DIR}/{C.MUTATE_BACKUP_DIR}/{rel}. "
                f"Delete {C.CLAIMCHECK_DIR}/{C.MUTATE_SENTINEL} once you have sorted it out.\n"
            )
    if refused:
        _write_sentinel(sentinel, refused)
        return restored
    if backup.exists():
        _rmtree(backup)
    if sentinel.exists():
        sentinel.unlink()
    return restored


def _rmtree(path: Path) -> None:
    shutil.rmtree(path, ignore_errors=True)


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


def _load_or_none(repo: Path, rel: str) -> _FileState | None:
    """The file's state, or None when it cannot be read; validation then names it as drifted."""
    try:
        return _load(repo, rel)
    except (OSError, ValueError):
        return None


def _prepare(repo: Path, all_mutants: list[Mutant]) -> tuple[list[Mutant], dict[str, _FileState | None], int]:
    """Read every file once; drop mutants on lines that are not valid UTF-8.

    Returns (usable mutants, file states, number skipped). A file that cannot be read stays
    in the map as None so validation can name it.
    """
    states = {rel: _load_or_none(repo, rel) for rel in dict.fromkeys(m.file for m in all_mutants)}
    usable = [m for m in all_mutants if _check(states[m.file], m) != "undecodable"]
    return usable, states, len(all_mutants) - len(usable)


def _per_claim_summaries(claims_file: CL.ClaimsFile, records: list[dict], all_mutants: list[Mutant]) -> dict[str, dict]:
    """Each claim's catch summary over the mutants in its files, plus how many candidates it had."""
    return {
        c.id: {
            **_summary([r for r in records if r["file"] in c.files]),
            "candidates": sum(1 for m in all_mutants if m.file in c.files),
        }
        for c in claims_file.claims
    }


def _warn_unjudged(claim_id: str, candidates: int) -> None:
    """Tell the person a claim got no mutation result, so the catch-rate gate cannot judge it."""
    if candidates == 0:
        why = "none of its files produced a mutation candidate, so nothing was planted"
    else:
        why = f"none of its {candidates} candidates were sampled (max_mutants)"
    sys.stderr.write(
        f"claimcheck: warning: claim {claim_id} has no mutation result: {why}; "
        f"the min_catch_rate gate cannot judge it.\n"
    )


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
    """Plant each sampled mutant, run the tests, and restore. Returns the result and exit code (2 below min_catch_rate)."""
    base = base or cfg.base
    test_cmd = test_cmd or cfg.test_cmd
    max_mutants = cfg.mutate_max_mutants if max_mutants is None else max_mutants
    timeout = cfg.mutate_timeout_s

    check_sentinel(repo)
    sentinel = C.cc_dir(repo) / C.MUTATE_SENTINEL
    # An empty diff has nothing to plant bugs in.
    gitio.require_diff(repo, base, worktree)

    if not criteria_checked:
        S.enforce_open_diff_rules(repo, cfg, base)
        S.verify(repo)

    if claims_file is None:
        try:
            claims_file = CL.load_file(CL.claims_path(repo), S.lock_ids(S.read_lock(repo)))
        except (ClaimsError, SpecError):
            claims_file = None

    diff = gitio.diff_text(repo, base, worktree)
    all_mutants, states, skipped = _prepare(repo, collect(diff, cfg.ignore))
    rng = random.Random(seed)
    selected = list(all_mutants)
    rng.shuffle(selected)
    selected = selected[:max_mutants]
    selected.sort(key=lambda m: (m.file, m.line_no, CLASSES.index(m.cls), m.mutated))

    # Validate every mutant against the bytes on disk BEFORE touching anything or writing the
    # sentinel: a file edited after the commit must fail here, with nothing left to clean up.
    for m in selected:
        if _check(states[m.file], m) != "ok":
            raise ProviderError(_drift_message(m))

    baseline, baseline_s = _run_tests(repo, test_cmd, timeout)
    if baseline != "survived":
        raise ProviderError("baseline tests fail; fix them first")

    backup_dir = C.cc_dir(repo) / C.MUTATE_BACKUP_DIR
    records: list[dict] = []
    if selected:
        loaded = {rel: state for rel, state in states.items() if state is not None}
        _run_planted(repo, selected, loaded, test_cmd, timeout, backup_dir, sentinel, records)

    per_claim = None if claims_file is None else _per_claim_summaries(claims_file, records, all_mutants)
    for claim_id, s in (per_claim or {}).items():
        if cfg.mutate_min_catch_rate > 0 and s["total"] == 0:
            _warn_unjudged(claim_id, s["candidates"])

    summary = _summary(records)
    result: dict = {
        "run_id": C.new_run_id(),
        "ts": C.utc_now_iso(),
        "base": gitio.rev_parse(repo, base),
        "head": "worktree" if worktree else gitio.head_sha(repo),
        "test_cmd": test_cmd,
        "baseline_s": baseline_s,
        "seed": seed,
        "candidates": len(all_mutants),
        "skipped_undecodable": skipped,
        "mutants": records,
        "summary": summary,
    }
    if per_claim is not None:
        result["per_claim"] = per_claim

    runs = C.cc_dir(repo) / C.RUNS_DIR
    runs.mkdir(parents=True, exist_ok=True)
    (runs / f"{result['run_id']}-mutate.json").write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    rate = summary["catch_rate"]
    code = 0 if rate is None or rate >= cfg.mutate_min_catch_rate else 2
    return result, code


def _retry_restore(path: Path, state: _FileState) -> bool:
    """One last try at putting a file back. False when it is still not the original.

    A failure here is expected to be rare, and it is not lost: the backup and the sentinel stay
    behind, and `claimcheck mutate --restore` finishes the job.
    """
    try:
        _restore_file(path, state.data, (state.atime_ns, state.mtime_ns))
        return _sha(path.read_bytes()) == state.sha
    except OSError:
        return False


def _run_planted(
    repo: Path,
    selected: list[Mutant],
    states: dict[str, _FileState],
    test_cmd: str,
    timeout: int,
    backup_dir: Path,
    sentinel: Path,
    records: list[dict],
) -> None:
    """Plant each mutant, run the tests, put the file back. Cleans up only when all is restored."""
    C.cc_dir(repo).mkdir(parents=True, exist_ok=True)
    backup_dir.mkdir(parents=True, exist_ok=True)
    recorded = {rel: _back_up(states[rel], backup_dir / rel) for rel in dict.fromkeys(m.file for m in selected)}
    _write_sentinel(sentinel, recorded)
    # Files that may currently hold a planted bug.
    dirty: set[str] = set()
    try:
        for k, m in enumerate(selected):
            records.append(_plant_and_test(repo, m, k, states[m.file], test_cmd, timeout, sentinel, recorded, dirty))
    finally:
        # Even after an exception or Ctrl-C: one more try at anything still dirty, then clean
        # up only if every file is back. A failed restore leaves backup + sentinel for --restore.
        still_dirty = {rel for rel in dirty if not _retry_restore(repo / rel, states[rel])}
        if not still_dirty:
            _rmtree(backup_dir)
            sentinel.unlink(missing_ok=True)


def _back_up(st: _FileState, dest: Path) -> dict:
    """Copy the original into the backup folder; returns its sentinel entry."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(st.data)
    return {
        "original_sha256": st.sha,
        "mutated_sha256": st.sha,
        "atime_ns": st.atime_ns,
        "mtime_ns": st.mtime_ns,
    }


def _plant_and_test(
    repo: Path,
    m: Mutant,
    k: int,
    st: _FileState,
    test_cmd: str,
    timeout: int,
    sentinel: Path,
    recorded: dict[str, dict],
    dirty: set[str],
) -> dict:
    """Plant mutant number `k`, run the tests, and put the file back. Returns its record."""
    path = repo / m.file
    mutated = st.render(m.line_no - 1, m.mutated.encode("utf-8"))
    # Record what is about to be written BEFORE writing it, so --restore can always
    # recognise the file as ours.
    recorded[m.file]["mutated_sha256"] = _sha(mutated)
    _write_sentinel(sentinel, recorded)
    dirty.add(m.file)
    path.write_bytes(mutated)
    # A distinct mtime second per mutant, so no stale .pyc keyed on the original's
    # (mtime, size) can be mistaken for the mutant's.
    _write_times(path, st.atime_ns, st.mtime_ns + (k + 1) * 2_000_000_000)
    try:
        outcome, dur = _run_tests(repo, test_cmd, timeout)
    finally:
        _restore_file(path, st.data, (st.atime_ns, st.mtime_ns))
        if _sha(path.read_bytes()) == st.sha:
            dirty.discard(m.file)
    return {**asdict(m), "outcome": outcome, "duration_s": dur}
