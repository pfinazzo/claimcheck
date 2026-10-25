"""The GitHub Actions workflow `init --ci github` writes.

@author Patrick Finazzo
"""

from __future__ import annotations

from pathlib import Path

WORKFLOW_PATH = ".github/workflows/claimcheck.yml"
INSTALL_URL = "https://github.com/pfinazzo/claimcheck.git"

_SETUP = {
    "node": "      - uses: actions/setup-node@v4\n        with:\n          node-version: \"20\"\n      - run: npm ci\n",
    "python": "      # Install your project's own dependencies and test tools here, for example:\n      # - run: pip install -r requirements.txt\n",
    "go": "      - uses: actions/setup-go@v5\n        with:\n          go-version: stable\n",
    "rust": "      - uses: dtolnay/rust-toolchain@stable\n",
    "maven": "      - uses: actions/setup-java@v4\n        with:\n          distribution: temurin\n          java-version: \"21\"\n",
    "gradle": "      - uses: actions/setup-java@v4\n        with:\n          distribution: temurin\n          java-version: \"21\"\n",
}


def render(stack_name: str | None) -> str:
    """The GitHub Actions workflow text, with the install step for the detected stack."""
    setup = _SETUP.get(stack_name or "", "      # Install your project's dependencies and test tools here.\n")
    return f"""\
# Written by `claimcheck init --ci github`. Edit freely.
# Runs claimcheck on every pull request: blind check of each claim, then planted bugs against your tests.
name: claimcheck
on: pull_request

jobs:
  claimcheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0              # the diff needs history back to the base branch
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
{setup}      - run: pip install "claimcheck[claude] @ git+{INSTALL_URL}"
      - run: claimcheck run --provider claude --base origin/${{{{ github.base_ref }}}}
        env:
          ANTHROPIC_API_KEY: ${{{{ secrets.ANTHROPIC_API_KEY }}}}
"""


def install_github(repo: Path, stack_name: str | None) -> tuple[str, str]:
    """Returns (relative path, action). Never overwrites an existing workflow."""
    path = repo / WORKFLOW_PATH
    if path.exists():
        return WORKFLOW_PATH, "exists"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(render(stack_name), encoding="utf-8", newline="\n")
    return WORKFLOW_PATH, "created"
