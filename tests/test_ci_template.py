"""The CI workflow `init --ci github` writes, and the README install line that must match it.

@author Patrick Finazzo
"""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml

from claimcheck import ci

README = (Path(__file__).resolve().parents[1] / "README.md").read_text(encoding="utf-8")
STACKS = [None, "python", "node", "go", "rust", "maven", "gradle"]


def _steps(stack):
    return yaml.safe_load(ci.render(stack))["jobs"]["claimcheck"]["steps"]


@pytest.mark.parametrize("stack", STACKS)
def test_the_workflow_does_not_assume_a_private_repo_or_a_token(stack):
    text = ci.render(stack).lower()
    assert "private" not in text
    assert "token" not in text


@pytest.mark.parametrize("stack", STACKS)
def test_the_workflow_installs_from_the_public_address_and_runs_against_the_base(stack):
    steps = _steps(stack)
    install = [s["run"] for s in steps if s.get("run", "").startswith("pip install")]
    assert install == [f'pip install "claimcheck[claude] @ git+{ci.INSTALL_URL}"']
    assert ci.INSTALL_URL == "https://github.com/pfinazzo/claimcheck.git"
    run = next(s for s in steps if s.get("run", "").startswith("claimcheck run"))
    assert run["run"] == "claimcheck run --provider claude --base origin/${{ github.base_ref }}"
    assert run["env"] == {"ANTHROPIC_API_KEY": "${{ secrets.ANTHROPIC_API_KEY }}"}


def test_the_readme_install_command_uses_the_templates_address():
    address = ci.INSTALL_URL.removesuffix(".git")
    command = f'pip install "claimcheck[claude] @ git+{address}"'
    assert README.count(command) >= 2  # the install section and the "use it in your own repo" steps


def test_the_readme_no_longer_says_the_repository_is_private():
    assert "while the claimcheck repository is private" not in README.lower()


def test_the_readme_has_the_use_it_in_your_own_repo_section_and_lists_it():
    assert "\n## Use it in your own repo\n" in README
    assert "- [Use it in your own repo](#use-it-in-your-own-repo)" in README
