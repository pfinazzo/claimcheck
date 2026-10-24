"""Stack detection and the config / .gitignore text `init` writes.

@author Patrick Finazzo
"""

from __future__ import annotations

import tomllib

from claimcheck import config as C
from claimcheck import detect


def _touch(root, rel, text=""):
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")


def test_python_project_uses_pytest(tmp_path):
    _touch(tmp_path, "pyproject.toml", "[project]\nname='x'\n")
    det = detect.detect(tmp_path)
    assert det.stack.name == "python"
    assert det.test_cmd == "python -m pytest -q"


def test_python_unittest_only(tmp_path):
    _touch(tmp_path, "setup.py", "")
    _touch(tmp_path, "tests/test_a.py", "import unittest\nclass T(unittest.TestCase): pass\n")
    assert detect.detect(tmp_path).test_cmd == "python -m unittest"


def test_python_unittest_and_pytest_prefers_pytest(tmp_path):
    _touch(tmp_path, "setup.py", "")
    _touch(tmp_path, "tests/test_a.py", "import unittest\n")
    _touch(tmp_path, "tests/test_b.py", "import pytest\n")
    assert detect.detect(tmp_path).test_cmd == "python -m pytest -q"


def test_node_with_real_test_script(tmp_path):
    _touch(tmp_path, "package.json", '{"scripts": {"test": "vitest run"}}')
    det = detect.detect(tmp_path)
    assert det.stack.name == "node"
    assert det.test_cmd == "npm test"


def test_node_picks_package_manager_from_lockfile(tmp_path):
    _touch(tmp_path, "package.json", '{"scripts": {"test": "jest"}}')
    _touch(tmp_path, "pnpm-lock.yaml", "")
    assert detect.detect(tmp_path).test_cmd == "pnpm test"


def test_node_default_placeholder_script_is_not_a_test_command(tmp_path):
    _touch(tmp_path, "package.json", '{"scripts": {"test": "echo \\"Error: no test specified\\" && exit 1"}}')
    assert detect.detect(tmp_path).stack is None


def test_node_package_json_with_bom_and_garbage(tmp_path):
    (tmp_path / "package.json").write_bytes(b"\xef\xbb\xbf" + b'{"scripts": {"test": "jest"}}')
    assert detect.detect(tmp_path).test_cmd == "npm test"
    (tmp_path / "package.json").write_text("{not json", encoding="utf-8")
    assert detect.detect(tmp_path).stack is None


def test_go_rust_gradle_maven(tmp_path):
    for marker, cmd in (
        ("go.mod", "go test ./..."),
        ("Cargo.toml", "cargo test"),
        ("pom.xml", "mvn -q test"),
        ("build.gradle", "./gradlew test"),
    ):
        root = tmp_path / marker.replace(".", "_")
        _touch(root, marker, "")
        assert detect.detect(root).test_cmd == cmd


def test_first_match_wins_and_others_are_named(tmp_path):
    _touch(tmp_path, "package.json", '{"scripts": {"test": "jest"}}')
    _touch(tmp_path, "pyproject.toml", "")
    det = detect.detect(tmp_path)
    assert det.stack.name == "node"
    assert det.others == ["python"]


def test_nothing_detected_falls_back_but_still_ignores_test_dirs(tmp_path):
    det = detect.detect(tmp_path)
    assert det.stack is None and det.test_cmd is None
    assert "tests/**" in det.ignore and ".gitignore" in det.ignore


def test_rendered_config_is_valid_toml_and_loads_back(tmp_path):
    _touch(tmp_path, "package.json", '{"scripts": {"test": "jest --ci"}}')
    text = detect.render_config(detect.detect(tmp_path))
    data = tomllib.loads(text)
    assert data["test_cmd"] == "npm test"
    assert ".claimcheck/**" in data["ignore"] and "*.test.*" in data["ignore"]
    assert data["require_full_coverage"] is True
    assert data["mutate"]["min_catch_rate"] == 0.0


def test_ignore_globs_cover_nested_tests_and_not_product_code():
    stack = detect.Stack("python", "python -m pytest -q", detect._TEST_DIRS + ["test_*.py", "*/test_*.py", "*_test.py"])
    globs = detect.BASE_IGNORE + stack.test_globs
    for test_path in ("tests/test_a.py", "pkg/tests/test_b.py", "test_top.py", "pkg/sub/test_c.py", "pkg/x_test.py"):
        assert C.is_ignored(test_path, globs), test_path
    for code_path in ("src/shipping.py", "pkg/latest.py", "src/contest.py", "app/main.py"):
        assert not C.is_ignored(code_path, globs), code_path


def test_ensure_gitignore_creates_appends_and_is_idempotent(tmp_path):
    added = detect.ensure_gitignore(tmp_path)
    assert added == detect.GITIGNORE_LINES
    text = (tmp_path / ".gitignore").read_text(encoding="utf-8")
    assert detect.ensure_gitignore(tmp_path) == []
    assert (tmp_path / ".gitignore").read_text(encoding="utf-8") == text

    (tmp_path / ".gitignore").write_text("node_modules/", encoding="utf-8")  # no trailing newline
    detect.ensure_gitignore(tmp_path)
    lines = (tmp_path / ".gitignore").read_text(encoding="utf-8").splitlines()
    assert lines[0] == "node_modules/"
    assert ".claimcheck/mutate.lock" in lines


def test_ensure_gitignore_keeps_lines_the_user_already_has(tmp_path):
    (tmp_path / ".gitignore").write_text(".claimcheck/runs/\n.claimcheck/mutate.lock\n", encoding="utf-8")
    added = detect.ensure_gitignore(tmp_path)
    assert ".claimcheck/runs/" not in added and ".claimcheck/mutate.lock" not in added
    assert ".claimcheck/worktrees/" in added
