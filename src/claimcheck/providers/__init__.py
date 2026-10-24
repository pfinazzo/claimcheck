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


def load(name: str, model: str | None = None) -> Provider:
    """`auto` picks the API when ANTHROPIC_API_KEY is set, otherwise the person's own Claude Code
    sign-in through the `claude` CLI. Either can be named directly."""
    import os

    if name == "auto":
        if os.environ.get("ANTHROPIC_API_KEY"):
            try:
                return load("claude", model)
            except ImportError:
                pass  # the SDK extra is not installed: fall through to the CLI
        from .claude_cli import find_claude

        if find_claude():
            return load("claude-cli", model)
        from .. import ProviderError

        raise ProviderError(
            "no way to reach Claude: sign in to Claude Code (run `claude` once), "
            "or set ANTHROPIC_API_KEY and install claimcheck[claude]."
        )
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
