"""The claimcheck block that `init` keeps inside CLAUDE.md / AGENTS.md.

@author Patrick Finazzo
"""

from __future__ import annotations

import textwrap

from claimcheck import agentdocs, claims


def test_adds_block_to_existing_files_only(tmp_path):
    (tmp_path / "CLAUDE.md").write_text("# Project\n\nUse tabs.\n", encoding="utf-8")
    output = agentdocs.install(tmp_path)
    assert output == [("CLAUDE.md", "added")]
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
    # Every newline is CRLF.
    assert b"\n" not in raw.replace(b"\r\n", b"")
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


# ---- the block names every key `claims validate` requires (issue 41) ------------------------

def _read_example_claims_file(block: str) -> str:
    """The fenced YAML example inside the block, dedented so it parses as a claims file."""
    fenced = block.split("```yaml\n", 1)[1].split("```", 1)[0]
    return textwrap.dedent(fenced)


def test_block_names_version_and_every_claim_key():
    block = agentdocs.build_block()
    assert "version: 1" in block
    for key in claims.Claim.__annotations__:
        assert f"{key}:" in block, key


def test_the_example_claim_in_the_block_passes_the_validator():
    claims_file, violations = claims.load_text(_read_example_claims_file(agentdocs.build_block()))
    assert violations == [] and claims_file is not None
    cited = {criterion for claim in claims_file["claims"] for criterion in claim["criteria"]}
    assert cited and claims.validate(claims_file, lock_ids=cited) == []


def test_block_explains_kill_condition_and_verified_by():
    block = agentdocs.build_block()
    assert "`test:` names a test, `cmd:`\n   a command, `obs:` something a person can look at" in block
    assert "It must not be the claim restated." in block
    assert "`verified_by` says how you checked the claim yourself: one or more entries in the same three\n   forms. It is never empty." in block


def test_example_is_the_same_in_both_layouts_and_has_no_claimcheck_path():
    single = _read_example_claims_file(agentdocs.build_block())
    assert _read_example_claims_file(agentdocs.build_block(layout="tasks")) == single
    assert ".claimcheck/" not in single


def test_old_block_is_replaced_by_one_that_names_verified_by(tmp_path):
    old_rules = "4. Give each claim a `kill_condition` that would prove it wrong: `test:`, `cmd:` or `obs:`.\n"
    (tmp_path / "CLAUDE.md").write_text(f"top\n\n{agentdocs.BEGIN}\n{old_rules}{agentdocs.END}\n\nbottom\n", encoding="utf-8")
    assert agentdocs.install(tmp_path) == [("CLAUDE.md", "updated")]
    text = (tmp_path / "CLAUDE.md").read_text(encoding="utf-8")
    assert text.count("claimcheck:begin") == 1 and "verified_by" in text
    assert text.startswith("top\n\n") and text.rstrip().endswith("bottom")
