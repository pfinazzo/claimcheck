"""Deterministic offline provider for tests and dry runs.

@author Patrick Finazzo
"""

from __future__ import annotations

import json
import re

from .. import config

_CLAIMS_BLOCK = re.compile(r"## Claims\s*```json\s*(.*?)\s*```", re.DOTALL)


def _draft_reply(user: str) -> str:
    """Deterministic spec-interview reply for offline demos and tests.

    Round 1 (no answers yet): two questions and a first criterion built from the goal.
    Later rounds: no questions, the criteria kept, ready.
    """
    goal_m = re.search(r"<answer>(.*?)</answer>", user, re.S)
    goal = " ".join((goal_m.group(1) if goal_m else "the change").split())
    answered = "## Interview so far" in user
    criteria = [{"text": f"{goal[:150].rstrip('.')}.", "check": "A test exercises the behavior described in the goal."}]
    if answered:
        criteria.append({"text": "Anything that should not change keeps its current behavior.", "check": "The existing tests still pass."})
    questions = [] if answered else [
        {"id": "q1", "text": "What should happen at the edges, for example the smallest and largest valid input?", "why": "It decides what the first criterion must pin down."},
        {"id": "q2", "text": "What must not change as a result of this work?", "why": "It becomes an out-of-scope line and a regression criterion."},
    ]
    return json.dumps(
        {"questions": questions, "criteria": criteria, "out_of_scope": [], "concerns": [] if answered else ["Offline stub: these are placeholders, not real analysis."], "ready": answered}
    )


class StubProvider:
    def complete(self, system: str, user: str, *, schema: dict) -> str:
        path = config.stub_reply_file()
        if path:
            with open(path, encoding="utf-8") as f:
                return f.read()
        if "questions" in schema.get("properties", {}):
            return _draft_reply(user)
        ids: list[str] = []
        m = _CLAIMS_BLOCK.search(user)
        if m:
            try:
                ids = [str(c["id"]) for c in json.loads(m.group(1))]
            except (json.JSONDecodeError, TypeError, KeyError):
                ids = []
        return json.dumps(
            {
                "verdicts": [
                    {"id": i, "verdict": "UNVERIFIABLE", "reason": "stub provider", "evidence": []}
                    for i in ids
                ]
            }
        )
