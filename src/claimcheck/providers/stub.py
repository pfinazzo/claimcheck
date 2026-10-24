"""Deterministic offline provider for tests and dry runs.

@author Patrick Finazzo
"""

from __future__ import annotations

import json
import os
import re

STUB_FILE_ENV = "CLAIMCHECK_STUB_FILE"
_CLAIMS_BLOCK = re.compile(r"## Claims\s*```json\s*(.*?)\s*```", re.DOTALL)


class StubProvider:
    def complete(self, system: str, user: str, *, schema: dict) -> str:
        path = os.environ.get(STUB_FILE_ENV)
        if path:
            with open(path, encoding="utf-8") as f:
                return f.read()
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
