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
from pathlib import Path
from typing import TypedDict

from . import (
    ClaimsError,
    MutateLockError,
    ProviderError,
    SpecError,
    claims,
    config,
    gitio,
    spec,
)

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


# One planted bug: the `cls` mutation of the line at `line_no` in `file`.
Mutant = TypedDict("Mutant", {"file": str, "line_no": int, "cls": str, "original": str, "mutated": str})


def make_mutant(*, file: str, line_no: int, cls: str, original: str, mutated: str) -> Mutant:
    """A Mutant from its parts."""
    return {"file": file, "line_no": line_no, "cls": cls, "original": original, "mutated": mutated}


def _find_string_spans(line: str) -> list[tuple[int, int]]:
    return [(match.start(), match.end()) for match in _STRING_RE.finditer(line)]


def _is_in_string(pos: int, *, spans: list[tuple[int, int]]) -> bool:
    return any(start <= pos < end for start, end in spans)


def _is_unary_minus(line: str, *, index: int) -> bool:
    """`-` at i, directly followed by an identifier/number, not a binary operator."""
    if index + 1 >= len(line) or not (line[index + 1].isalnum() or line[index + 1] in "_."):
        return False
    inner_index = index - 1
    while inner_index >= 0 and line[inner_index] in " \t":
        inner_index -= 1
    if inner_index < 0:
        return True
    prev = line[inner_index]
    if prev in "([{,=:+*/%<>!&|^~":
        return True
    if prev.isalnum() or prev == "_":
        key = inner_index
        while key >= 0 and (line[key].isalnum() or line[key] == "_"):
            key -= 1
        word = line[key + 1 : inner_index + 1]
        return word in _UNARY_PREV_WORDS
    return False


def _make_sign_flips(line: str, *, spans: list[tuple[int, int]]) -> list[str]:
    variants: list[str] = []
    for match in re.finditer(r" \+ | - ", line):
        if _is_in_string(match.start(), spans=spans):
            continue
        rep = " - " if match.group(0) == " + " else " + "
        variants.append(line[: match.start()] + rep + line[match.end() :])
    for i, char in enumerate(line):
        if char == "-" and not _is_in_string(i, spans=spans) and _is_unary_minus(line, index=i):
            variants.append(line[:i] + line[i + 1 :])
    return variants


def _make_off_by_ones(line: str, *, spans: list[tuple[int, int]]) -> list[str]:
    variants: list[str] = []
    for match in _INT_RE.finditer(line):
        if _is_in_string(match.start(), spans=spans):
            continue
        count = int(match.group(0))
        variants.append(line[: match.start()] + str(count + 1) + line[match.end() :])
    return variants


def _make_arg_swaps(line: str, *, spans: list[tuple[int, int]]) -> list[str]:
    for match in _SWAP_RE.finditer(line):
        if _is_in_string(match.start(), spans=spans):
            continue
        before = line[: match.start()].rstrip()
        prev_word = before.split()[-1] if before.split() else ""
        if prev_word in _DEF_KEYWORDS:
            continue
        name, a, b = match.group(1), match.group(2), match.group(3)
        return [line[: match.start()] + f"{name}({b}, {a})" + line[match.end() :]]
    return []


def _make_boundary_mutants(line: str, *, spans: list[tuple[int, int]]) -> list[str]:
    variants: list[str] = []
    for match in _CMP_RE.finditer(line):
        i, j = match.start(), match.end()
        if _is_in_string(i, spans=spans):
            continue
        operator = match.group(0)
        prev = line[i - 1] if i > 0 else ""
        nxt = line[j] if j < len(line) else ""
        if operator in ("<", "<=") and (prev in ("<", "=") or nxt in ("<", "-")):
            continue
        if operator in (">", ">=") and (prev in (">", "-", "=") or nxt == ">"):
            continue
        if operator == "<" and nxt == ">":
            continue
        rep = {"<": "<=", "<=": "<", ">": ">=", ">=": ">"}[operator]
        variants.append(line[:i] + rep + line[j:])
    return variants


def make_mutants(line: str, *, file: str = "", line_no: int = 0) -> list[Mutant]:
    """Every applicable mutation of the four classes for one line (no newline)."""
    spans = _find_string_spans(line)
    mutations = (
        ("sign_flip", _make_sign_flips),
        ("off_by_one", _make_off_by_ones),
        ("swap_args", _make_arg_swaps),
        ("boundary", _make_boundary_mutants),
    )
    return [
        make_mutant(file=file, line_no=line_no, cls=cls, original=line, mutated=mutated)
        for cls, func in mutations
        for mutated in func(line, spans=spans)
        if mutated != line
    ]


_HUNK_RE = re.compile(r"^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")
_BOM = "﻿"
_GIT_ESCAPES = {"n": 10, "t": 9, "r": 13, "a": 7, "b": 8, "f": 12, "v": 11, '"': 34, "\\": 92}


def _strip_git_quotes(s: str) -> str:
    """Undo git's C-style quoting of a path in a diff header ("caf\\303\\251.py")."""
    if len(s) < 2 or s[0] != '"' or s[-1] != '"':
        return s
    body = s[1:-1]
    output = bytearray()
    i = 0
    while i < len(body):
        chunk, i = _read_quoted_char(body, index=i)
        output += chunk
    return output.decode("utf-8", "replace")


def _read_quoted_char(body: str, *, index: int) -> tuple[bytes, int]:
    """The bytes for the character or escape at `i` in a git-quoted path, and where the next one starts."""
    nxt = body[index + 1] if body[index] == "\\" and index + 1 < len(body) else ""
    if nxt and nxt in "01234567":
        inner_index = index + 1
        while inner_index < len(body) and inner_index < index + 4 and body[inner_index] in "01234567":
            inner_index += 1
        return bytes([int(body[index + 1 : inner_index], 8) & 0xFF]), inner_index
    if nxt and nxt in _GIT_ESCAPES:
        return bytes([_GIT_ESCAPES[nxt]]), index + 2
    return body[index].encode("utf-8"), index + 1


def _parse_header_path(raw: str) -> str | None:
    """File named by a `+++ ` header line, or None for /dev/null."""
    target = raw[4:].rstrip("\r")
    if not target.startswith('"'):
        # Git appends a tab after names that contain spaces.
        target = target.split("\t")[0]
    target = _strip_git_quotes(target)
    if target == "/dev/null":
        return None
    return target[2:] if target.startswith("b/") else target


def _read_hunk_step(
    raw: str, *, file: str | None, line_no: int, old_left: int, new_left: int
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


def _is_file_boundary(raw: str, *, prev: str) -> bool:
    """Whether this line starts a new file in the diff: its header, its `+++` name, or a binary marker."""
    return raw.startswith(("diff --git", "Binary files", "GIT binary patch")) or (raw.startswith("+++ ") and prev.startswith("--- "))


def _read_file_after_boundary(raw: str, *, ignore: list[str]) -> str | None:
    """The file later `+` lines belong to: the `+++` name unless ignored, else none yet."""
    file = _parse_header_path(raw) if raw.startswith("+++ ") else None
    return None if file is None or config.is_ignored(file, globs=ignore) else file


def list_added_lines(diff: str, *, ignore: list[str]) -> list[tuple[str, int, str]]:
    """[(file, post-diff line_no, text)] for every `+` line in non-ignored text files.

    Hunk bodies are consumed by the line counts in their `@@` header, so a content line that
    happens to look like a file header (`+++ x` inside an ignored markdown hunk) is never
    mistaken for one. The diff is split on newline only: form feeds and U+2028 are content.
    """
    collected: list[tuple[str, int, str]] = []
    file: str | None = None
    line_no = 0
    old_left = new_left = 0
    prev = ""
    for raw in diff.split("\n"):
        hunk = _HUNK_RE.match(raw)
        if old_left > 0 or new_left > 0:
            added, line_no, old_left, new_left = _read_hunk_step(raw, file=file, line_no=line_no, old_left=old_left, new_left=new_left)
            collected.extend(added)
        elif _is_file_boundary(raw, prev=prev):
            file = _read_file_after_boundary(raw, ignore=ignore)
        elif hunk:
            old_left = int(hunk.group(1)) if hunk.group(1) is not None else 1
            line_no = int(hunk.group(2))
            new_left = int(hunk.group(3)) if hunk.group(3) is not None else 1
        elif file is not None and raw.startswith("+") and not raw.startswith("+++ "):
            # Tolerate a hand-written hunk whose header under-counts its lines.
            collected.append((file, line_no, raw[1:].rstrip("\r")))
            line_no += 1
        prev = raw
    return [
        (file_path, number, text[len(_BOM) :] if number == 1 and text.startswith(_BOM) else text) for file_path, number, text in collected
    ]


def collect(diff: str, *, ignore: list[str]) -> list[Mutant]:
    """Every mutant for every added line in the diff, skipping ignored files."""
    mutants: list[Mutant] = []
    for file, line_no, text in list_added_lines(diff, ignore=ignore):
        mutants.extend(make_mutants(text, file=file, line_no=line_no))
    return mutants


_TEST_ENV_OVERRIDES = {
    # A planted bug must never be baked into a .pyc: Python keys a .pyc on (mtime in whole
    # seconds, size), so a same-size mutant restored within the same second would keep
    # being imported after the file is back to normal.
    "PYTHONDONTWRITEBYTECODE": "1",
}


# taskkill and a killed process normally finish at once; these stop a stuck one from hanging the run.
_KILL_TIMEOUT_S = 10


def _send_tree_kill(proc: subprocess.Popen) -> None:
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
    _send_tree_kill(proc)
    proc.kill()
    try:
        proc.wait(timeout=_KILL_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        # A process stuck in the kernel can ignore SIGKILL for a while. The run moves on rather
        # than hang; the operating system reaps the process once it lets go.
        return


def _run_tests(repo: Path, *, command: str, timeout: int) -> tuple[str, float]:
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
        command, shell=True, cwd=repo, env=env,
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **kw,
    )
    try:
        return_code = proc.wait(timeout=timeout)
        outcome = "survived" if return_code == 0 else "killed"
    except subprocess.TimeoutExpired:
        _kill_tree(proc)
        outcome = "timeout"
    except BaseException:
        _kill_tree(proc)
        raise
    return outcome, round(time.monotonic() - t0, 3)


# ---- file model: bytes in, bytes out, line endings kept per line -----------------------

_UTF8_BOM = b"\xef\xbb\xbf"


# A file as read before any mutant touched it. `lines` holds (content without its line
# ending, that line's own ending), so a file renders back byte for byte.
_FileState = TypedDict(
    "_FileState",
    {"data": bytes, "sha": str, "atime_ns": int, "mtime_ns": int, "bom": bool, "lines": list[tuple[bytes, bytes]]},
)


def _render_with_line(state: _FileState, *, index: int, new_content: bytes) -> bytes:
    """The file's bytes with line `index` (0-based) replaced, every line ending and the BOM kept."""
    bom = [_UTF8_BOM] if state["bom"] else []
    body = [(new_content if i == index else content) + eol for i, (content, eol) in enumerate(state["lines"])]
    return b"".join(bom + body)


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _parse_bytes(data: bytes, *, atime_ns: int = 0, mtime_ns: int = 0) -> _FileState:
    body = data
    bom = body.startswith(_UTF8_BOM)
    if bom:
        body = body[len(_UTF8_BOM) :]
    *ended, tail = body.split(b"\n")
    lines = [(part[:-1], b"\r\n") if part.endswith(b"\r") else (part, b"\n") for part in ended]
    # A last line with no newline is kept; an empty tail is just the final newline.
    lines += [(tail, b"")] if tail else []
    return {"data": data, "sha": _sha(data), "atime_ns": atime_ns, "mtime_ns": mtime_ns, "bom": bom, "lines": lines}


def _load(repo: Path, *, rel_path: str) -> _FileState:
    root = repo.resolve()
    target = (repo / rel_path).resolve()
    if root != target and root not in target.parents:
        raise OSError("path is outside the repository")
    state = target.stat()
    return _parse_bytes(target.read_bytes(), atime_ns=state.st_atime_ns, mtime_ns=state.st_mtime_ns)


def _check(state: _FileState | None, *, mutant: Mutant) -> str:
    """'ok', 'undecodable' (skip the line), or 'mismatch' (the file is not what the diff says)."""
    if state is None:
        return "mismatch"
    idx = mutant["line_no"] - 1
    if idx < 0 or idx >= len(state["lines"]):
        return "mismatch"
    try:
        text = state["lines"][idx][0].decode("utf-8")
    except UnicodeDecodeError:
        return "undecodable"
    return "ok" if text == mutant["original"] else "mismatch"


def _describe_drift(m: Mutant) -> str:
    return f"{m['file']} line {m['line_no']} no longer matches the diff; commit or stash your edits and rerun"


def _write_times(path: Path, *, atime_ns: int, mtime_ns: int) -> None:
    """Set a file's access and modified times."""
    try:
        os.utime(path, ns=(atime_ns, mtime_ns))
    except PermissionError:
        # Some filesystems refuse to set times on files we can still write. The bytes are what
        # make the file correct; a refused time only makes tools like make rebuild it.
        return


def _reset_file(path: Path, *, original: bytes, times: tuple[int, int] | None = None) -> None:
    """Put the original bytes back after a mutant run (separate so tests can make it fail).

    `times` is (atime_ns, mtime_ns) of the original file: putting them back keeps the file
    looking untouched to Python's .pyc cache, make, and friends.
    """
    path.write_bytes(original)
    if times is not None:
        _write_times(path, atime_ns=times[0], mtime_ns=times[1])


# ---- sentinel and backups ----------------------------------------------------------------

def _write_sentinel(path: Path, *, files: dict[str, dict]) -> None:
    payload = {"version": 2, "ts": config.format_utc_now(), "files": files}
    scratch = path.with_name(path.name + ".tmp")
    scratch.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(scratch, path)


def _read_sentinel(path: Path) -> dict[str, dict]:
    """Recorded per-file hashes, or {} when the sentinel is missing, old, or unreadable."""
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        files = raw.get("files", {})
        return files if isinstance(files, dict) else {}
    except (OSError, ValueError, AttributeError):
        return {}


def _describe_unrestorable(info: object, *, backup: bytes, current: bytes | None) -> str | None:
    """The reason a backup may not be written over the current file, or None when it may."""
    if not isinstance(info, dict):
        return "the lock file has no record of what the run wrote, so your edits cannot be told apart from the planted bug"
    if info.get("original_sha256") != _sha(backup):
        return "the backup does not match the recorded original"
    if current is None:
        return "the file is missing or not a regular file"
    if _sha(current) not in (info["original_sha256"], info.get("mutated_sha256")):
        return "it changed since the run (it is neither the original nor the planted bug)"
    return None


def _reset_one(repo: Path, *, backup_file: Path, record: dict[str, dict]) -> tuple[bool, str | None]:
    """Put one backup back.

    Returns (whether the original was written, the reason the file was kept or None). A file that
    already equals the original only loses its backup.
    """
    rel = backup_file.relative_to(config.resolve_cc_dir(repo) / config.MUTATE_BACKUP_DIR).as_posix()
    dest = repo / rel
    details = record.get(rel)
    try:
        bak = backup_file.read_bytes()
        cur = dest.read_bytes() if dest.is_file() else None
    except OSError as error:
        return False, f"cannot read it ({error})"
    why = _describe_unrestorable(details, backup=bak, current=cur)
    if why is not None or details is None or cur is None:
        return False, why
    if _sha(cur) == details["original_sha256"]:
        backup_file.unlink()
        return False, None
    try:
        dest.write_bytes(bak)
        if "mtime_ns" in details:
            _write_times(dest, atime_ns=int(details.get("atime_ns", details["mtime_ns"])), mtime_ns=int(details["mtime_ns"]))
    except OSError as error:
        return False, f"writing it failed ({error})"
    backup_file.unlink()
    return True, None


def reset_from_backups(repo: Path) -> list[str]:
    """`--restore`: put backed-up originals back, but never over work the run did not write.

    A file is overwritten only when its current bytes equal the mutated text this run last
    wrote. A file that already equals the original is left alone; a file that equals
    neither was edited by the user, so it is kept, its backup stays, and a line on stderr
    says which file and why. Returns the restored paths.
    """
    cc = config.resolve_cc_dir(repo)
    backup = cc / config.MUTATE_BACKUP_DIR
    sentinel = cc / config.MUTATE_SENTINEL
    record = _read_sentinel(sentinel)
    backups = sorted(path for path in backup.rglob("*") if path.is_file()) if backup.exists() else []
    outcomes = {file_name.relative_to(backup).as_posix(): _reset_one(repo, backup_file=file_name, record=record) for file_name in backups}
    restored = [rel for rel, (was_written, _) in outcomes.items() if was_written]
    refused = {rel: record.get(rel) or {} for rel, (_, why) in outcomes.items() if why is not None}
    for rel, (_, why) in outcomes.items():
        if why is not None:
            sys.stderr.write(
                f"claimcheck: not restoring {rel}: {why}. The file was left as it is and the backup "
                f"is still at {config.CLAIMCHECK_DIR}/{config.MUTATE_BACKUP_DIR}/{rel}. "
                f"Delete {config.CLAIMCHECK_DIR}/{config.MUTATE_SENTINEL} once you have sorted it out.\n"
            )
    if refused:
        _write_sentinel(sentinel, files=refused)
        return restored
    if backup.exists():
        _remove_tree(backup)
    if sentinel.exists():
        sentinel.unlink()
    return restored


def _remove_tree(path: Path) -> None:
    shutil.rmtree(path, ignore_errors=True)


def check_sentinel(repo: Path) -> None:
    """Exit 6 when a previous run left its sentinel behind."""
    if (config.resolve_cc_dir(repo) / config.MUTATE_SENTINEL).exists():
        raise MutateLockError(
            f"{config.CLAIMCHECK_DIR}/{config.MUTATE_SENTINEL} exists: a previous mutate run did not finish. "
            "Run `claimcheck mutate --restore` to put the backed-up files back."
        )


def _summarize(records: list[dict]) -> dict:
    killed = sum(1 for record in records if record["outcome"] == "killed")
    survived = sum(1 for each_record in records if each_record["outcome"] == "survived")
    timeout = sum(1 for record in records if record["outcome"] == "timeout")
    total = killed + survived + timeout
    rate = round((killed + timeout) / total, 4) if total else None
    return {"total": total, "killed": killed, "survived": survived, "timeout": timeout, "catch_rate": rate}


def _load_or_none(repo: Path, *, rel_path: str) -> _FileState | None:
    """The file's state, or None when it cannot be read; validation then names it as drifted."""
    try:
        return _load(repo, rel_path=rel_path)
    except (OSError, ValueError):
        return None


def _select_mutants(repo: Path, *, all_mutants: list[Mutant]) -> tuple[list[Mutant], dict[str, _FileState | None], int]:
    """Read every file once; drop mutants on lines that are not valid UTF-8.

    Returns (usable mutants, file states, number skipped). A file that cannot be read stays
    in the map as None so validation can name it.
    """
    states = {rel: _load_or_none(repo, rel_path=rel) for rel in dict.fromkeys(candidate["file"] for candidate in all_mutants)}
    usable = [all_mutant for all_mutant in all_mutants if _check(states[all_mutant["file"]], mutant=all_mutant) != "undecodable"]
    return usable, states, len(all_mutants) - len(usable)


def _summarize_per_claim(claims_file: claims.ClaimsFile, *, records: list[dict], all_mutants: list[Mutant]) -> dict[str, dict]:
    """Each claim's catch summary over the mutants in its files, plus how many candidates it had."""
    return {
        claim["id"]: {
            **_summarize([record for record in records if record["file"] in claim["files"]]),
            "candidates": sum(1 for candidate in all_mutants if candidate["file"] in claim["files"]),
        }
        for claim in claims_file["claims"]
    }


def _log_unjudged(claim_id: str, *, candidates: int) -> None:
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
    *, settings: config.Config,
    base: str | None = None,
    worktree: bool = False,
    test_cmd: str | None = None,
    max_mutants: int | None = None,
    seed: int = 0,
    criteria_checked: bool = False,
    claims_file: claims.ClaimsFile | None = None,
) -> tuple[dict, int]:
    """Plant each sampled mutant, run the tests, and restore. Returns the result and exit code (2 below min_catch_rate)."""
    base = base or settings["base"]
    test_cmd = test_cmd or settings["test_cmd"]
    max_mutants = settings["mutate_max_mutants"] if max_mutants is None else max_mutants
    timeout = settings["mutate_timeout_s"]

    check_sentinel(repo)
    sentinel = config.resolve_cc_dir(repo) / config.MUTATE_SENTINEL
    # An empty diff has nothing to plant bugs in.
    gitio.ensure_diff(repo, base=base, worktree=worktree)

    if not criteria_checked:
        spec.check_open_diff_rules(repo, settings=settings, base=base)
        spec.validate_spec(repo)

    if claims_file is None:
        try:
            claims_file = claims.load_file(claims.resolve_claims_path(repo), lock_ids=spec.list_lock_ids(spec.read_lock(repo)))
        except (ClaimsError, SpecError):
            claims_file = None

    diff = gitio.read_diff(repo, base=base, worktree=worktree)
    all_mutants, states, skipped = _select_mutants(repo, all_mutants=collect(diff, ignore=settings["ignore"]))
    rng = random.Random(seed)
    selected = list(all_mutants)
    rng.shuffle(selected)
    selected = selected[:max_mutants]
    selected.sort(key=lambda mutant: (mutant["file"], mutant["line_no"], CLASSES.index(mutant["cls"]), mutant["mutated"]))

    # Validate every mutant against the bytes on disk BEFORE touching anything or writing the
    # sentinel: a file edited after the commit must fail here, with nothing left to clean up.
    for mutant in selected:
        if _check(states[mutant["file"]], mutant=mutant) != "ok":
            raise ProviderError(_describe_drift(mutant))

    baseline, baseline_s = _run_tests(repo, command=test_cmd, timeout=timeout)
    if baseline != "survived":
        raise ProviderError("baseline tests fail; fix them first")

    backup_dir = config.resolve_cc_dir(repo) / config.MUTATE_BACKUP_DIR
    records: list[dict] = []
    if selected:
        loaded = {rel: state for rel, state in states.items() if state is not None}
        _run_planted(repo, selected=selected, states=loaded, test_cmd=test_cmd, timeout=timeout, backup_dir=backup_dir, sentinel=sentinel, records=records)

    per_claim = None if claims_file is None else _summarize_per_claim(claims_file, records=records, all_mutants=all_mutants)
    for claim_id, value in (per_claim or {}).items():
        if settings["mutate_min_catch_rate"] > 0 and value["total"] == 0:
            _log_unjudged(claim_id, candidates=value["candidates"])

    summary = _summarize(records)
    report: dict = {
        "run_id": config.make_run_id(),
        "ts": config.format_utc_now(),
        "base": gitio.resolve_ref(repo, ref=base),
        "head": "worktree" if worktree else gitio.read_head_sha(repo),
        "test_cmd": test_cmd,
        "baseline_s": baseline_s,
        "seed": seed,
        "candidates": len(all_mutants),
        "skipped_undecodable": skipped,
        "mutants": records,
        "summary": summary,
    }
    if per_claim is not None:
        report["per_claim"] = per_claim

    runs = config.resolve_cc_dir(repo) / config.RUNS_DIR
    runs.mkdir(parents=True, exist_ok=True)
    (runs / f"{report['run_id']}-mutate.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    rate = summary["catch_rate"]
    code = 0 if rate is None or rate >= settings["mutate_min_catch_rate"] else 2
    return report, code


def _retry_restore(path: Path, *, state: _FileState) -> bool:
    """One last try at putting a file back. False when it is still not the original.

    A failure here is expected to be rare, and it is not lost: the backup and the sentinel stay
    behind, and `claimcheck mutate --restore` finishes the job.
    """
    try:
        _reset_file(path, original=state["data"], times=(state["atime_ns"], state["mtime_ns"]))
        return _sha(path.read_bytes()) == state["sha"]
    except OSError:
        return False


def _run_planted(
    repo: Path,
    *, selected: list[Mutant],
    states: dict[str, _FileState],
    test_cmd: str,
    timeout: int,
    backup_dir: Path,
    sentinel: Path,
    records: list[dict],
) -> None:
    """Plant each mutant, run the tests, put the file back. Cleans up only when all is restored."""
    config.resolve_cc_dir(repo).mkdir(parents=True, exist_ok=True)
    backup_dir.mkdir(parents=True, exist_ok=True)
    recorded = {rel: _back_up(states[rel], dest=backup_dir / rel) for rel in dict.fromkeys(mutant["file"] for mutant in selected)}
    _write_sentinel(sentinel, files=recorded)
    # Files that may currently hold a planted bug.
    dirty: set[str] = set()
    try:
        for index, mutant in enumerate(selected):
            records.append(_plant_and_test(repo, mutant=mutant, number=index, state=states[mutant["file"]], test_cmd=test_cmd, timeout=timeout, sentinel=sentinel, recorded=recorded, dirty=dirty))
    finally:
        # Even after an exception or Ctrl-C: one more try at anything still dirty, then clean
        # up only if every file is back. A failed restore leaves backup + sentinel for --restore.
        still_dirty = {rel for rel in dirty if not _retry_restore(repo / rel, state=states[rel])}
        if not still_dirty:
            _remove_tree(backup_dir)
            sentinel.unlink(missing_ok=True)


def _back_up(st: _FileState, *, dest: Path) -> dict:
    """Copy the original into the backup folder; returns its sentinel entry."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(st["data"])
    return {
        "original_sha256": st["sha"],
        "mutated_sha256": st["sha"],
        "atime_ns": st["atime_ns"],
        "mtime_ns": st["mtime_ns"],
    }


def _plant_and_test(
    repo: Path,
    *, mutant: Mutant,
    number: int,
    state: _FileState,
    test_cmd: str,
    timeout: int,
    sentinel: Path,
    recorded: dict[str, dict],
    dirty: set[str],
) -> dict:
    """Plant mutant number `k`, run the tests, and put the file back. Returns its record."""
    path = repo / mutant["file"]
    mutated = _render_with_line(state, index=mutant["line_no"] - 1, new_content=mutant["mutated"].encode("utf-8"))
    # Record what is about to be written BEFORE writing it, so --restore can always
    # recognise the file as ours.
    recorded[mutant["file"]]["mutated_sha256"] = _sha(mutated)
    _write_sentinel(sentinel, files=recorded)
    dirty.add(mutant["file"])
    path.write_bytes(mutated)
    # A distinct mtime second per mutant, so no stale .pyc keyed on the original's
    # (mtime, size) can be mistaken for the mutant's.
    _write_times(path, atime_ns=state["atime_ns"], mtime_ns=state["mtime_ns"] + (number + 1) * 2_000_000_000)
    try:
        outcome, dur = _run_tests(repo, command=test_cmd, timeout=timeout)
    finally:
        _reset_file(path, original=state["data"], times=(state["atime_ns"], state["mtime_ns"]))
        if _sha(path.read_bytes()) == state["sha"]:
            dirty.discard(mutant["file"])
    return {**mutant, "outcome": outcome, "duration_s": dur}
