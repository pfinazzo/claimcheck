"""Everything `claimcheck init` does to a repo, in one place, with no printing.

The terminal onboarding, the plain `init` and the app all call `run_setup`, so there is one
definition of "set up". It is safe to run twice: nothing that exists is overwritten.

@author Patrick Finazzo
"""

from __future__ import annotations

from pathlib import Path
from typing import TypeVar

from . import agentdocs, ci, config, detect, gitio, hook, specdraft

# Whatever one setup step produced; `step` hands it back unchanged.
StepResult = TypeVar("StepResult")

_INITIAL = (
    (config.SPEC_FILE, config.DEFAULT_SPEC_MD),
    (config.CLAIMS_FILE, config.DEFAULT_CLAIMS_YAML),
    (config.LEDGER_FILE, ""),
)


def _write_if_missing(path: Path, *, content: str) -> bool:
    if path.exists():
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8", newline="\n")
    return True


def make_plan(repo: Path) -> detect.Detection:
    """What would be detected, without writing anything."""
    return detect.detect(repo)


def run_setup(
    repo: Path,
    *,
    create_agent_doc: str | None = None,
    ci_provider: str | None = None,
    test_cmd: str | None = None,
    on_step=None,
) -> dict:
    """Do the whole setup. `on_step(name, result)` is called as each step finishes (for animation).

    `test_cmd` overrides the detected test command when the config is first written.
    """
    def run_step(name: str, *, value: StepResult) -> StepResult:
        """Report one finished setup step to `on_step` and pass its result through."""
        if on_step:
            on_step(name, value=value)
        return value

    # Secrets first, before anything else is written: a repo that can commit .env by accident
    # should not get any further setup until that is closed.
    secrets = run_step("secrets", value=detect.ensure_secrets_ignored(repo))

    entry = config.resolve_cc_dir(repo)
    entry.mkdir(parents=True, exist_ok=True)
    created: list[str] = []

    det = run_step("detect", value=detect.detect(repo))
    config_path = entry / config.CONFIG_FILE
    config_status = "exists"
    if not config_path.exists():
        text = detect.render_config(det)
        if test_cmd:
            text = text.replace(f'test_cmd = "{det["test_cmd"] or "python -m pytest -q"}"', f'test_cmd = "{test_cmd}"', 1)
        config_path.write_text(text, encoding="utf-8", newline="\n")
        created.append(config.CONFIG_FILE)
        config_status = "created"
    run_step("config", value=config_status)
    # The tasks layout starts with no task. Each task's files appear in its own folder with its spec.
    initial_files = _INITIAL if config.load(repo)["layout"] == "single" else ()
    for name, content in initial_files:
        if _write_if_missing(entry / name, content=content):
            created.append(name)
    (entry / config.RUNS_DIR).mkdir(exist_ok=True)

    hook_path = hook.resolve_hook_file(repo)
    hook_changed = hook.install(repo)
    hook_info = {"status": "installed" if hook_changed else "present", "path": str(hook_path)}
    run_step("hook", value=hook_info)

    added = detect.ensure_gitignore(repo)
    run_step("gitignore", value=added)

    docs = [{"path": doc_path, "action": action} for doc_path, action in agentdocs.install(repo, create=create_agent_doc)]
    run_step("agent_docs", value=docs)

    ci_info = None
    if ci_provider == "github":
        path, action = ci.install_github(repo, stack_name=det["stack"]["name"] if det["stack"] else None)
        ci_info = {"path": path, "action": action}
    run_step("ci", value=ci_info)

    touched = [".gitignore"] if (added or secrets["added"] or secrets["created"]) else []
    touched += [doc["path"] for doc in docs if doc["action"] != "unchanged"]
    if ci_info and ci_info["action"] == "created":
        touched.append(ci_info["path"])
    if touched:
        specdraft.record_setup_files(repo, paths=touched)

    cfg = config.load(repo)
    return {
        "repo": str(repo),
        "created": created,
        "config": config_status,
        "stack": {
            "name": det["stack"]["name"] if det["stack"] else None,
            "test_cmd": config.load(repo)["test_cmd"],
            "others": det["others"],
        },
        "hook": hook_info,
        "secrets": secrets,
        "gitignore_added": added,
        "agent_docs": docs,
        "ci": ci_info,
        "base": cfg["base"],
        "branch": gitio.read_current_branch(repo) or None,
        "next": "write_spec",
    }
