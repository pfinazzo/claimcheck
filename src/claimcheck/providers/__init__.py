"""Checker providers. This module never imports `anthropic`.

@author Patrick Finazzo
"""

from __future__ import annotations

from typing import Protocol


class Provider(Protocol):
    def complete(self, system: str, user: str, *, schema: dict) -> str:
        """Return raw JSON text conforming to `schema`."""
        ...


def load(name: str, model: str | None = None) -> Provider:
    if name == "claude":
        from .claude import ClaudeProvider

        return ClaudeProvider(model=model)
    if name == "stub":
        from .stub import StubProvider

        return StubProvider()
    raise ValueError(f"unknown provider: {name!r} (expected 'claude' or 'stub')")
