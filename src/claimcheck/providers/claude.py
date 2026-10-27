"""Claude provider via the official `anthropic` SDK. Optional extra `claimcheck[claude]`.

@author Patrick Finazzo
"""

from __future__ import annotations

from .. import redact
from .shapes import Provider, Request, make_provider

try:
    import anthropic
except ImportError as error:  # pragma: no cover - exercised only without the extra installed
    raise ImportError(
        'the claude provider needs the anthropic SDK: pip install "claimcheck[claude]"'
    ) from error

DEFAULT_MODEL = "claude-opus-5-5"
# The same budget the Claude Code CLI provider gets. Without it the SDK waits up to ten minutes
# per attempt, and a stalled connection freezes the run.
API_TIMEOUT_S = 300


def make_claude_provider(*, model: str | None = None) -> Provider:
    """A provider that asks Claude through the API, with the key in ANTHROPIC_API_KEY."""
    chosen = model or DEFAULT_MODEL
    client = anthropic.Anthropic(timeout=API_TIMEOUT_S)

    def answer_request(request: Request) -> str:
        """One structured-output request; returns the reply's text."""
        # Last line of defence: whatever built these strings, nothing secret-looking leaves the process.
        system, user = redact.redact_text(request["system"])[0], redact.redact_text(request["user"])[0]
        response = client.messages.create(
            model=chosen,
            max_tokens=16000,
            system=system,
            messages=[{"role": "user", "content": user}],
            output_config={"format": {"type": "json_schema", "schema": request["schema"]}},
        )
        return next(part.text for part in response.content if part.type == "text")

    return make_provider("claude", complete=answer_request, model=chosen)
