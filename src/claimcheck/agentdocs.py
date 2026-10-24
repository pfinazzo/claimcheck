"""Keeps a claimcheck instruction block inside the repo's agent instruction files.

`init` calls this so nobody has to paste anything into CLAUDE.md or AGENTS.md by hand. The block
sits between two marker comments, so running it again updates the block in place and never
duplicates it. Only files that already exist are touched, unless the caller asks for one to be
created.

@author Patrick Finazzo
"""

from __future__ import annotations

from pathlib import Path

BEGIN = "<!-- claimcheck:begin (managed by `claimcheck init`; edits inside this block are overwritten) -->"
END = "<!-- claimcheck:end -->"

# Files agents read, in the order we report them. Root-level first.
CANDIDATES = ("CLAUDE.md", ".claude/CLAUDE.md", "AGENTS.md")
CREATABLE = {"claude": "CLAUDE.md", "agents": "AGENTS.md"}

BLOCK_BODY = """\
## claimcheck

This repo uses claimcheck. Every change carries frozen acceptance criteria and a list of claims
about the diff, and an independent checker and a planted-bug test run grade them.

Before writing code for a task:
1. Run `claimcheck spec verify`. If `.claimcheck/spec.lock` is missing or does not match
   `.claimcheck/spec.md`, stop and ask the human. Do not edit `spec.md` or `spec.lock` yourself.
   If the human has no spec yet, run `claimcheck spec draft` and let them answer its questions.

With every commit that changes code:
2. Update `.claimcheck/claims.yaml`. One claim per thing you assert about the diff.
3. Give each claim a confidence between 0 and 1 that reflects how sure you actually are.
   Do not round up. Low confidence is useful information.
4. Give each claim a `kill_condition` that would prove it wrong: `test:`, `cmd:` or `obs:`.
   It must be something other than the claim restated.
5. List every changed code file in some claim's `files`, and cite criteria by number.

Before finishing:
6. Run `claimcheck run`. Report any claim that is REFUTED or has a low catch rate. Fix the tests
   or narrow the claim. Never edit the checker, the ledger or the config to make a run pass.
"""


def block() -> str:
    return f"{BEGIN}\n{BLOCK_BODY}{END}\n"


def _read(path: Path) -> tuple[str, str, bool]:
    """(text with \\n newlines, newline style, had BOM)."""
    raw = path.read_bytes()
    bom = raw.startswith(b"\xef\xbb\xbf")
    text = raw.decode("utf-8-sig", errors="replace")
    newline = "\r\n" if "\r\n" in text else "\n"
    return text.replace("\r\n", "\n"), newline, bom


def _write(path: Path, text: str, newline: str, bom: bool) -> None:
    data = text.replace("\n", newline).encode("utf-8")
    path.write_bytes((b"\xef\xbb\xbf" if bom else b"") + data)


def apply_to_text(text: str) -> tuple[str, str]:
    """Return (new_text, action) where action is added, updated or unchanged."""
    new_block = block()
    start = text.find("<!-- claimcheck:begin")
    if start != -1:
        end = text.find(END, start)
        if end != -1:
            end += len(END)
            if text[end : end + 1] == "\n":
                end += 1
            updated = text[:start] + new_block + text[end:]
            return updated, ("unchanged" if updated == text else "updated")
    sep = "" if not text else ("\n" if text.endswith("\n") else "\n\n")
    return text + sep + new_block, "added"


def install(repo: Path, *, create: str | None = None) -> list[tuple[str, str]]:
    """Add or refresh the block in every existing agent file. Returns [(relative path, action)].

    `create` is "claude" or "agents": make that file when no agent file exists at all.
    """
    results: list[tuple[str, str]] = []
    for rel in CANDIDATES:
        path = repo / rel
        if not path.is_file():
            continue
        text, newline, bom = _read(path)
        new_text, action = apply_to_text(text)
        if action != "unchanged":
            _write(path, new_text, newline, bom)
        results.append((rel, action))
    if not results and create:
        rel = CREATABLE[create]
        path = repo / rel
        path.write_text(f"# {repo.name}\n\n" + block(), encoding="utf-8", newline="\n")
        results.append((rel, "created"))
    return results
