"""Checker providers. This module never imports `anthropic`.

@author Patrick Finazzo
"""

from __future__ import annotations

from typing import Protocol

from .. import ProviderError, config
from . import claude_cli
from .stub import StubProvider


class Provider(Protocol):
    def complete(self, system: str, user: str, *, schema: dict) -> str:
        """Return raw JSON text conforming to `schema`."""
        ...


NAMES = ("auto", "claude", "claude-cli", "stub")


def _load_cli_or_explain(model: str | None) -> Provider:
    """The Claude Code CLI provider, or a ProviderError that says how to reach Claude at all."""
    if claude_cli.find_claude():
        return load("claude-cli", model)
    raise ProviderError(
        "no way to reach Claude: sign in to Claude Code (run `claude` once), "
        "or set ANTHROPIC_API_KEY and install claimcheck[claude]."
    )


def load(name: str, model: str | None = None) -> Provider:
    """`auto` picks the API when ANTHROPIC_API_KEY is set, otherwise the person's own Claude Code
    sign-in through the `claude` CLI. Either can be named directly."""
    if name == "auto" and config.has_api_key():
        try:
            return load("claude", model)
        except ImportError:
            # The SDK extra is not installed, so the person's Claude Code sign-in is the way left.
            return _load_cli_or_explain(model)
    if name == "auto":
        return _load_cli_or_explain(model)
    if name == "claude":
        # Lazy on purpose: this is the only path that imports the optional `anthropic` SDK, and
        # an ImportError here is how `auto` learns the extra is missing.
        from .claude import ClaudeProvider  # noqa: PLC0415

        return ClaudeProvider(model=model)
    if name == "claude-cli":
        return claude_cli.ClaudeCliProvider(model=model)
    if name == "stub":
        return StubProvider()
    raise ValueError(f"unknown provider: {name!r} (expected one of {', '.join(NAMES)})")
