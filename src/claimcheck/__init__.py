"""claimcheck — a verification ledger for AI-written diffs.

@author Patrick Finazzo
"""

__version__ = "0.1.0"


class ClaimcheckError(Exception):
    """Base error. `code` is the process exit code the CLI maps it to."""

    code = 1

    def __init__(self, message: str, code: int | None = None):
        super().__init__(message)
        if code is not None:
            self.code = code


class SpecError(ClaimcheckError):
    """Spec parse, freeze, or verify refusal (exit 3)."""

    code = 3


class ClaimsError(ClaimcheckError):
    """Claims file or pre-commit hook failure (exit 4)."""

    code = 4


class ProviderError(ClaimcheckError):
    """Checker provider or baseline-test failure (exit 5)."""

    code = 5


class EmptyDiffError(ClaimcheckError):
    """There is nothing to verify: the diff is empty (exit 7)."""

    code = 7


class MutateLockError(ClaimcheckError):
    """A stale mutate sentinel is present (exit 6)."""

    code = 6
