"""The shapes every checker provider shares: what a model is asked, and what a provider is.

They live apart from the package so each provider module can use them without importing the
package that loads the providers.

@author Patrick Finazzo
"""

from __future__ import annotations

from collections.abc import Callable
from typing import TypedDict

# One question for the model: the system prompt, the user message, and the JSON schema the reply must match.
Request = TypedDict("Request", {"system": str, "user": str, "schema": dict})

# A way to reach a model. `complete` returns raw JSON text conforming to the request's schema.
# `name` is the provider's name as `load` takes it; `model` is the model it asks (None: its default).
Provider = TypedDict("Provider", {"name": str, "model": str | None, "complete": Callable[[Request], str]})


def make_provider(name: str, *, complete: Callable[[Request], str], model: str | None = None) -> Provider:
    """A Provider from its name and the function that asks the model."""
    return {"name": name, "model": model, "complete": complete}


def make_request(*, system: str, user: str, schema: dict) -> Request:
    """A Request from its parts."""
    return {"system": system, "user": user, "schema": schema}
