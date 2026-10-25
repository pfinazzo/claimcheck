"""Checker providers. This module never imports `anthropic`.

@author Patrick Finazzo
"""

from __future__ import annotations

from typing import Protocol


class Provider(Protocol):
    def complete(self, system: str, user: str, *, schema: dict) -> str:
        """Return raw JSON text conforming to `schema`."""
        ...


NAMES = ("auto", "claude", "claude-cli", "stub")


def _load_cli_or_explain(model: str | None) -> Provider:
    """The Claude Code CLI provider, or a ProviderError that says how to reach Claude at all."""
    from .. import ProviderError
    from .claude_cli import find_claude

    if find_claude():
        return load("claude-cli", model)
    raise ProviderError(
        "no way to reach Claude: sign in to Claude Code (run `claude` once), "
        "or set ANTHROPIC_API_KEY and install claimcheck[claude]."
    )


def load(name: str, model: str | None = None) -> Provider:
    """`auto` picks the API when ANTHROPIC_API_KEY is set, otherwise the person's own Claude Code
    sign-in through the `claude` CLI. Either can be named directly."""
    import os

    if name == "auto" and os.environ.get("ANTHROPIC_API_KEY"):
        try:
            return load("claude", model)
        except ImportError:
            # The SDK extra is not installed, so the person's Claude Code sign-in is the way left.
            return _load_cli_or_explain(model)
    if name == "auto":
        return _load_cli_or_explain(model)
    if name == "claude":
        from .claude import ClaudeProvider

        return ClaudeProvider(model=model)
    if name == "claude-cli":
        from .claude_cli import ClaudeCliProvider

        return ClaudeCliProvider(model=model)
    if name == "stub":
        from .stub import StubProvider

        return StubProvider()
    raise ValueError(f"unknown provider: {name!r} (expected one of {', '.join(NAMES)})")
