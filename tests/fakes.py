"""Fake checker providers for tests: canned replies, and a record of what each was asked.

@author Patrick Finazzo
"""

from __future__ import annotations

import json

from claimcheck.providers import Provider, Request, make_provider


def make_sequence_provider(*replies: str) -> tuple[Provider, list[str]]:
    """A provider that answers with each reply in turn, and the list of user messages it is sent."""
    pending, users = list(replies), []

    def answer_request(request: Request) -> str:
        """Record the user message and hand back the next canned reply."""
        users.append(request["user"])
        return pending.pop(0)

    return make_provider("sequence", complete=answer_request), users


def make_capturing_provider() -> tuple[Provider, list[str]]:
    """A provider that answers every claim in the prompt UNVERIFIABLE, and the user messages it saw."""
    users: list[str] = []

    def answer_request(request: Request) -> str:
        """Record the prompt and answer each claim in its claims block UNVERIFIABLE."""
        users.append(request["user"])
        ids = [char["id"] for char in json.loads(request["user"].split("```json", 1)[1].split("```", 1)[0])]
        return json.dumps({"verdicts": [{"id": claim_id, "verdict": "UNVERIFIABLE", "reason": "capture", "evidence": []} for claim_id in ids]})

    return make_provider("capturing", complete=answer_request), users


def make_failing_provider(error: Exception) -> Provider:
    """A provider whose every call raises `error`, like a dropped network connection."""

    def answer_request(request: Request) -> str:
        """Fail the way the real provider would."""
        raise error

    return make_provider("failing", complete=answer_request)
