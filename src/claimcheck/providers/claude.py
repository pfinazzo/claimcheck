"""Claude provider via the official `anthropic` SDK. Optional extra `claimcheck[claude]`.

@author Patrick Finazzo
"""

from __future__ import annotations

try:
    import anthropic
except ImportError as e:  # pragma: no cover - exercised only without the extra installed
    raise ImportError(
        'the claude provider needs the anthropic SDK: pip install "claimcheck[claude]"'
    ) from e

DEFAULT_MODEL = "claude-opus-5-5"


class ClaudeProvider:
    def __init__(self, model: str | None = None):
        self.model = model or DEFAULT_MODEL
        self.client = anthropic.Anthropic()

    def complete(self, system: str, user: str, *, schema: dict) -> str:
        response = self.client.messages.create(
            model=self.model,
            max_tokens=16000,
            system=system,
            messages=[{"role": "user", "content": user}],
            output_config={"format": {"type": "json_schema", "schema": schema}},
        )
        return next(b.text for b in response.content if b.type == "text")
