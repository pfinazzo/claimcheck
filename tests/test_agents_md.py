"""AGENTS.md and CLAUDE.md hold the same repo rules.

Claude Code reads CLAUDE.md. OpenAI's Codex and other agents read AGENTS.md. If the two
drifted, an agent on one would follow rules the other had dropped.

@author Patrick Finazzo
"""

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def test_agents_md_matches_claude_md_word_for_word():
    assert (ROOT / "AGENTS.md").read_text(encoding="utf-8") == (ROOT / "CLAUDE.md").read_text(encoding="utf-8")
