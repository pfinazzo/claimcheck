"""Provider that talks to the person's own Claude Code sign-in through the `claude` CLI.

No API key is needed. The prompt goes in on stdin, tools are switched off, and the reply comes back
as JSON. On Windows `claude` is a `.cmd` shim, and running a shim through cmd.exe would mangle
quotes in the arguments, so the shim is read and the real executable is launched directly.

@author Patrick Finazzo
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from collections.abc import Mapping
from pathlib import Path

from .. import ProviderError, config, redact
from .shapes import Provider, Request, make_provider

DEFAULT_TIMEOUT_S = 300
# Tools off: the model gets text in and gives text out, nothing else.
DISALLOWED = ["Bash", "Edit", "Write", "Read", "Glob", "Grep", "WebFetch", "WebSearch", "Task", "NotebookEdit"]
SIGN_IN = re.compile(r"not logged in|please run /login|invalid api key|unauthorized|authentication|credit balance", re.I)


def find_claude(env: Mapping[str, str] | None = None) -> str | None:
    """The `claude` binary: CLAUDE_BIN when it exists, else the one on PATH, else None."""
    env = env if env is not None else os.environ
    override = env.get("CLAUDE_BIN")
    if override and Path(override).exists():
        return override
    return shutil.which("claude", path=env.get("PATH"))


def resolve_launch(binary: str) -> tuple[list[str], bool]:
    """(argv prefix, direct). `direct` is False only when a .cmd shim could not be unwrapped."""
    if not binary.lower().endswith((".cmd", ".bat")):
        return [binary], True
    shim = Path(binary)
    try:
        target = _read_shim_target(shim)
    except OSError:
        # An unreadable shim is not fatal: the packaged locations are tried next.
        target = None
    if not target or not target.exists():
        target = _find_packaged_claude(shim)
    if not target:
        return [binary], False
    if target.suffix.lower() in (".js", ".mjs", ".cjs"):
        return ["node", str(target)], True
    return [str(target)], True


def _read_shim_target(shim: Path) -> Path | None:
    """The program a .cmd shim launches, read from the shim itself; None if it names none."""
    text = shim.read_text(encoding="utf-8", errors="ignore")
    found = re.findall(r'"%~?dp0%?\\?([^"]+)"', text)
    # A classic npm shim names node.exe first and the real script last. Never pick node itself.
    found = [file for file in found if Path(file.replace("\\", "/")).name.lower() not in ("node", "node.exe")]
    return shim.parent / found[-1] if found else None


def _find_packaged_claude(shim: Path) -> Path | None:
    """Where npm puts Claude Code next to a .cmd shim, if it is there."""
    base = shim.parent / "node_modules" / "@anthropic-ai" / "claude-code"
    return next((base / rel for rel in (Path("bin") / "claude.exe", Path("cli.js")) if (base / rel).exists()), None)


def parse_output(stdout: str) -> str:
    """The reply text from `--output-format json`. Prefers the structured field."""
    try:
        raw = json.loads(stdout)
    except json.JSONDecodeError:
        raise ProviderError(f"claude CLI gave non-JSON output: {stdout[:200]!r}") from None
    if not isinstance(raw, dict):
        raise ProviderError("claude CLI output was not an object")
    if raw.get("is_error"):
        msg = str(raw.get("result") or raw.get("subtype") or "unknown error")
        if SIGN_IN.search(msg):
            raise ProviderError("Claude Code is not signed in. Run `claude` once and sign in, then retry.")
        raise ProviderError(f"claude CLI reported an error: {msg[:300]}")
    structured = raw.get("structured_output")
    if isinstance(structured, (dict, list)):
        return json.dumps(structured)
    outcome = raw.get("result")
    if isinstance(outcome, str) and outcome.strip():
        return outcome
    raise ProviderError("claude CLI returned no result")


def make_claude_cli_provider(*, model: str | None = None, binary: str | None = None, timeout_s: int = DEFAULT_TIMEOUT_S) -> Provider:
    """A provider that asks the person's own Claude Code sign-in through the `claude` CLI.

    Raises ProviderError when the CLI cannot be found.
    """
    found = binary or find_claude()
    if not found:
        raise ProviderError(
            "the claude CLI was not found on PATH. Install Claude Code and sign in, "
            "or set ANTHROPIC_API_KEY to use the API provider."
        )

    def answer_request(request: Request) -> str:
        """Run `claude -p` once, read-only and without tools, and return its reply."""
        return _run_claude(request, binary=found, model=model, timeout_s=timeout_s)

    return make_provider("claude-cli", complete=answer_request, model=model)


def _run_claude(request: Request, *, binary: str, model: str | None, timeout_s: int) -> str:
    """One `claude -p` call. Raises ProviderError, saying what to do, when it fails."""
    # Last line of defence: whatever built these strings, nothing secret-looking leaves the process.
    system, user = redact.redact_text(request["system"])[0], redact.redact_text(request["user"])[0]
    schema = request["schema"]
    prefix, direct = resolve_launch(binary)
    args = [
        *prefix, "-p", "--output-format", "json", "--system-prompt", system,
        "--no-session-persistence", "--strict-mcp-config", "--disallowedTools", *DISALLOWED,
    ]
    if model:
        args += ["--model", model]
    if direct:
        args += ["--json-schema", json.dumps(schema)]
    # Without --json-schema (shim fallback) the schema has to ride in the prompt itself.
    stdin = user if direct else user + "\n\nReply with JSON only, matching this schema:\n" + json.dumps(schema)
    try:
        proc = subprocess.run(
            args, input=stdin, capture_output=True, text=True, encoding="utf-8",
            timeout=timeout_s, cwd=config.read_temp_dir(),
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0,
        )
    except subprocess.TimeoutExpired:
        raise ProviderError(f"claude CLI did not answer within {timeout_s}s") from None
    except OSError as error:
        raise ProviderError(f"claude CLI could not be started: {error}") from error
    if proc.returncode != 0 and not proc.stdout.strip():
        err = (proc.stderr or "").strip()
        if SIGN_IN.search(err):
            raise ProviderError("Claude Code is not signed in. Run `claude` once and sign in, then retry.")
        raise ProviderError(f"claude CLI exited {proc.returncode}: {err[:300]}")
    return parse_output(proc.stdout)
