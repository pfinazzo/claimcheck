"""The claimcheck block that `init` keeps inside CLAUDE.md / AGENTS.md.

@author Patrick Finazzo
"""

from __future__ import annotations

from claimcheck import agentdocs


def test_adds_block_to_existing_files_only(tmp_path):
    (tmp_path / "CLAUDE.md").write_text("# Project\n\nUse tabs.\n", encoding="utf-8")
    out = agentdocs.install(tmp_path)
    assert out == [("CLAUDE.md", "added")]
    text = (tmp_path / "CLAUDE.md").read_text(encoding="utf-8")
    assert text.startswith("# Project\n\nUse tabs.\n\n<!-- claimcheck:begin")
    assert "claimcheck spec draft" in text and text.rstrip().endswith(agentdocs.END)
    assert not (tmp_path / "AGENTS.md").exists()


def test_handles_every_candidate_that_exists(tmp_path):
    (tmp_path / ".claude").mkdir()
    (tmp_path / ".claude" / "CLAUDE.md").write_text("a\n", encoding="utf-8")
    (tmp_path / "AGENTS.md").write_text("b\n", encoding="utf-8")
    assert agentdocs.install(tmp_path) == [(".claude/CLAUDE.md", "added"), ("AGENTS.md", "added")]


def test_second_run_is_unchanged_and_never_duplicates(tmp_path):
    (tmp_path / "AGENTS.md").write_text("rules\n", encoding="utf-8")
    agentdocs.install(tmp_path)
    first = (tmp_path / "AGENTS.md").read_bytes()
    assert agentdocs.install(tmp_path) == [("AGENTS.md", "unchanged")]
    assert (tmp_path / "AGENTS.md").read_bytes() == first
    assert first.decode().count("claimcheck:begin") == 1


def test_stale_block_is_updated_in_place_and_surrounding_text_kept(tmp_path):
    old = f"top\n\n{agentdocs.BEGIN}\nOLD WORDING\n{agentdocs.END}\n\nbottom\n"
    (tmp_path / "CLAUDE.md").write_text(old, encoding="utf-8")
    assert agentdocs.install(tmp_path) == [("CLAUDE.md", "updated")]
    text = (tmp_path / "CLAUDE.md").read_text(encoding="utf-8")
    assert "OLD WORDING" not in text and text.startswith("top\n\n") and text.rstrip().endswith("bottom")
    assert text.count("claimcheck:begin") == 1


def test_preserves_crlf_and_bom(tmp_path):
    (tmp_path / "CLAUDE.md").write_bytes(b"\xef\xbb\xbf# T\r\n\r\nline\r\n")
    agentdocs.install(tmp_path)
    raw = (tmp_path / "CLAUDE.md").read_bytes()
    assert raw.startswith(b"\xef\xbb\xbf# T\r\n")
    assert b"\n" not in raw.replace(b"\r\n", b"")  # every newline is CRLF
    assert agentdocs.install(tmp_path) == [("CLAUDE.md", "unchanged")]


def test_file_without_trailing_newline(tmp_path):
    (tmp_path / "AGENTS.md").write_text("no newline", encoding="utf-8")
    agentdocs.install(tmp_path)
    assert (tmp_path / "AGENTS.md").read_text(encoding="utf-8").startswith("no newline\n\n<!-- claimcheck:begin")


def test_create_only_when_nothing_exists_and_asked(tmp_path):
    assert agentdocs.install(tmp_path) == []
    assert not (tmp_path / "CLAUDE.md").exists()
    assert agentdocs.install(tmp_path, create="agents") == [("AGENTS.md", "created")]
    assert "claimcheck:begin" in (tmp_path / "AGENTS.md").read_text(encoding="utf-8")


def test_create_is_ignored_when_a_file_already_exists(tmp_path):
    (tmp_path / "CLAUDE.md").write_text("x\n", encoding="utf-8")
    assert agentdocs.install(tmp_path, create="agents") == [("CLAUDE.md", "added")]
    assert not (tmp_path / "AGENTS.md").exists()


def test_unterminated_begin_marker_does_not_eat_the_file(tmp_path):
    (tmp_path / "CLAUDE.md").write_text(f"keep me\n{agentdocs.BEGIN}\nhalf a block\n", encoding="utf-8")
    agentdocs.install(tmp_path)
    assert "keep me" in (tmp_path / "CLAUDE.md").read_text(encoding="utf-8")
