"""Keeps a claimcheck instruction block inside the repo's agent instruction files.

`init` calls this so nobody has to paste anything into CLAUDE.md or AGENTS.md by hand. The block
sits between two marker comments, so running it again updates the block in place and never
duplicates it. Only files that already exist are touched, unless the caller asks for one to be
created.

@author Patrick Finazzo
"""

from __future__ import annotations

from pathlib import Path

from . import config

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
6. Run `claimcheck run`. Report any claim that is REFUTED, UNVERIFIABLE or has a low catch rate.
   Fix the tests or narrow the claim. Never edit the checker, the ledger or the config to make a
   run pass. Only a person runs `claimcheck accept`; never run it yourself.
"""


TASK_FOLDER_NOTE = """
In this repo each task's files live in `.claimcheck/tasks/<task>/`. `<task>` is your branch name
with every character outside A-Z, a-z, 0-9, `.`, `_` and `-` turned into `-`.
"""

# The block for each layout. The tasks layout names the task folder in every path.
BLOCK_BODIES = {
    "single": BLOCK_BODY,
    "tasks": BLOCK_BODY.replace("`.claimcheck/", "`.claimcheck/tasks/<task>/") + TASK_FOLDER_NOTE,
}


def build_block(*, layout: str = "single") -> str:
    """The marked block of agent instructions, begin and end markers included."""
    return f"{BEGIN}\n{BLOCK_BODIES[layout]}{END}\n"


def _read(path: Path) -> tuple[str, str, bool]:
    """(text with \\n newlines, newline style, had BOM)."""
    raw = path.read_bytes()
    bom = raw.startswith(b"\xef\xbb\xbf")
    text = raw.decode("utf-8-sig", errors="replace")
    newline = "\r\n" if "\r\n" in text else "\n"
    return text.replace("\r\n", "\n"), newline, bom


def _write(path: Path, *, text: str, newline: str, bom: bool) -> None:
    raw = text.replace("\n", newline).encode("utf-8")
    path.write_bytes((b"\xef\xbb\xbf" if bom else b"") + raw)


def _find_block(text: str) -> tuple[int, int] | None:
    """Where the existing block sits, as (start, end) with its trailing newline; None if absent."""
    start = text.find("<!-- claimcheck:begin")
    end = text.find(END, start) if start != -1 else -1
    if end == -1:
        return None
    end += len(END)
    return start, end + 1 if text[end : end + 1] == "\n" else end


def _make_separator_before_block(text: str) -> str:
    """The blank line a new block needs after existing text: none for an empty file."""
    if not text:
        return ""
    return "\n" if text.endswith("\n") else "\n\n"


def apply_to_text(text: str, *, layout: str = "single") -> tuple[str, str]:
    """Return (new_text, action) where action is added, updated or unchanged."""
    new_block = build_block(layout=layout)
    span = _find_block(text)
    if span is None:
        return text + _make_separator_before_block(text) + new_block, "added"
    updated = text[: span[0]] + new_block + text[span[1] :]
    return updated, ("unchanged" if updated == text else "updated")


def install(repo: Path, *, create: str | None = None) -> list[tuple[str, str]]:
    """Add or refresh the block in every existing agent file. Returns [(relative path, action)].

    `create` is "claude" or "agents": make that file when no agent file exists at all.
    """
    layout = config.load(repo)["layout"]
    results: list[tuple[str, str]] = []
    for rel in CANDIDATES:
        path = repo / rel
        if not path.is_file():
            continue
        text, newline, bom = _read(path)
        new_text, action = apply_to_text(text, layout=layout)
        if action != "unchanged":
            _write(path, text=new_text, newline=newline, bom=bom)
        results.append((rel, action))
    if not results and create:
        rel = CREATABLE[create]
        path = repo / rel
        path.write_text(f"# {repo.name}\n\n" + build_block(layout=layout), encoding="utf-8", newline="\n")
        results.append((rel, "created"))
    return results
