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
from pathlib import Path

from .. import ProviderError, redact

DEFAULT_TIMEOUT_S = 300
# Tools off: the model gets text in and gives text out, nothing else.
DISALLOWED = ["Bash", "Edit", "Write", "Read", "Glob", "Grep", "WebFetch", "WebSearch", "Task", "NotebookEdit"]
SIGN_IN = re.compile(r"not logged in|please run /login|invalid api key|unauthorized|authentication|credit balance", re.I)


def find_claude(env: dict | None = None) -> str | None:
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
    target = None
    try:
        text = shim.read_text(encoding="utf-8", errors="ignore")
        found = re.findall(r'"%~?dp0%?\\?([^"]+)"', text)
        # A classic npm shim names node.exe first and the real script last. Never pick node itself.
        found = [f for f in found if Path(f.replace("\\", "/")).name.lower() not in ("node", "node.exe")]
        if found:
            target = shim.parent / found[-1]
    except OSError:
        target = None
    if not target or not target.exists():
        base = shim.parent / "node_modules" / "@anthropic-ai" / "claude-code"
        for rel in (Path("bin") / "claude.exe", Path("cli.js")):
            if (base / rel).exists():
                target = base / rel
                break
    if target and target.exists():
        if target.suffix.lower() in (".js", ".mjs", ".cjs"):
            return ["node", str(target)], True
        return [str(target)], True
    return [binary], False


def parse_output(stdout: str) -> str:
    """The reply text from `--output-format json`. Prefers the structured field."""
    try:
        data = json.loads(stdout)
    except json.JSONDecodeError:
        raise ProviderError(f"claude CLI gave non-JSON output: {stdout[:200]!r}")
    if not isinstance(data, dict):
        raise ProviderError("claude CLI output was not an object")
    if data.get("is_error"):
        msg = str(data.get("result") or data.get("subtype") or "unknown error")
        if SIGN_IN.search(msg):
            raise ProviderError("Claude Code is not signed in. Run `claude` once and sign in, then retry.")
        raise ProviderError(f"claude CLI reported an error: {msg[:300]}")
    structured = data.get("structured_output")
    if isinstance(structured, (dict, list)):
        return json.dumps(structured)
    result = data.get("result")
    if isinstance(result, str) and result.strip():
        return result
    raise ProviderError("claude CLI returned no result")


class ClaudeCliProvider:
    def __init__(self, model: str | None = None, binary: str | None = None, timeout_s: int = DEFAULT_TIMEOUT_S):
        self.model = model
        self.binary = binary or find_claude()
        self.timeout_s = timeout_s
        if not self.binary:
            raise ProviderError(
                "the claude CLI was not found on PATH. Install Claude Code and sign in, "
                "or set ANTHROPIC_API_KEY to use the API provider."
            )

    def complete(self, system: str, user: str, *, schema: dict) -> str:
        # Last line of defence: whatever built these strings, nothing secret-looking leaves the process.
        system, user = redact.redact_text(system)[0], redact.redact_text(user)[0]
        prefix, direct = resolve_launch(self.binary)
        args = [
            *prefix, "-p", "--output-format", "json", "--system-prompt", system,
            "--no-session-persistence", "--strict-mcp-config", "--disallowedTools", *DISALLOWED,
        ]
        if self.model:
            args += ["--model", self.model]
        if direct:
            args += ["--json-schema", json.dumps(schema)]
        # Without --json-schema (shim fallback) the schema has to ride in the prompt itself.
        stdin = user if direct else user + "\n\nReply with JSON only, matching this schema:\n" + json.dumps(schema)
        try:
            proc = subprocess.run(
                args, input=stdin, capture_output=True, text=True, encoding="utf-8",
                timeout=self.timeout_s, cwd=os.environ.get("TEMP") or None,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0,
            )
        except subprocess.TimeoutExpired:
            raise ProviderError(f"claude CLI did not answer within {self.timeout_s}s")
        except OSError as e:
            raise ProviderError(f"claude CLI could not be started: {e}")
        if proc.returncode != 0 and not proc.stdout.strip():
            err = (proc.stderr or "").strip()
            if SIGN_IN.search(err):
                raise ProviderError("Claude Code is not signed in. Run `claude` once and sign in, then retry.")
            raise ProviderError(f"claude CLI exited {proc.returncode}: {err[:300]}")
        return parse_output(proc.stdout)
