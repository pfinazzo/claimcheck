"""Everything `claimcheck init` does to a repo, in one place, with no printing.

The terminal onboarding, the plain `init` and the app all call `run_setup`, so there is one
definition of "set up". It is safe to run twice: nothing that exists is overwritten.

@author Patrick Finazzo
"""

from __future__ import annotations

from pathlib import Path

from . import agentdocs, ci, detect, gitio, hook, specdraft
from . import config as C

_INITIAL = (
    (C.SPEC_FILE, C.DEFAULT_SPEC_MD),
    (C.CLAIMS_FILE, C.DEFAULT_CLAIMS_YAML),
    (C.LEDGER_FILE, ""),
)


def _write_if_missing(path: Path, content: str) -> bool:
    if path.exists():
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8", newline="\n")
    return True


def plan(repo: Path) -> detect.Detection:
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
    def step(name: str, value):
        """Report one finished setup step to `on_step` and pass its result through."""
        if on_step:
            on_step(name, value)
        return value

    # Secrets first, before anything else is written: a repo that can commit .env by accident
    # should not get any further setup until that is closed.
    secrets = step("secrets", detect.ensure_secrets_ignored(repo))

    d = C.cc_dir(repo)
    d.mkdir(parents=True, exist_ok=True)
    created: list[str] = []

    det = step("detect", detect.detect(repo))
    config_path = d / C.CONFIG_FILE
    config_status = "exists"
    if not config_path.exists():
        text = detect.render_config(det)
        if test_cmd:
            text = text.replace(f'test_cmd = "{det.test_cmd or "python -m pytest -q"}"', f'test_cmd = "{test_cmd}"', 1)
        config_path.write_text(text, encoding="utf-8", newline="\n")
        created.append(C.CONFIG_FILE)
        config_status = "created"
    step("config", config_status)
    for name, content in _INITIAL:
        if _write_if_missing(d / name, content):
            created.append(name)
    (d / C.RUNS_DIR).mkdir(exist_ok=True)

    hook_path = hook.hook_file(repo)
    hook_changed = hook.install(repo)
    hook_info = {"status": "installed" if hook_changed else "present", "path": str(hook_path)}
    step("hook", hook_info)

    added = detect.ensure_gitignore(repo)
    step("gitignore", added)

    docs = [{"path": p, "action": a} for p, a in agentdocs.install(repo, create=create_agent_doc)]
    step("agent_docs", docs)

    ci_info = None
    if ci_provider == "github":
        path, action = ci.install_github(repo, det.stack.name if det.stack else None)
        ci_info = {"path": path, "action": action}
    step("ci", ci_info)

    touched = [".gitignore"] if (added or secrets["added"] or secrets["created"]) else []
    touched += [x["path"] for x in docs if x["action"] != "unchanged"]
    if ci_info and ci_info["action"] == "created":
        touched.append(ci_info["path"])
    if touched:
        specdraft.record_setup_files(repo, touched)

    cfg = C.load(repo)
    return {
        "repo": str(repo),
        "created": created,
        "config": config_status,
        "stack": {
            "name": det.stack.name if det.stack else None,
            "test_cmd": C.load(repo).test_cmd,
            "others": det.others,
        },
        "hook": hook_info,
        "secrets": secrets,
        "gitignore_added": added,
        "agent_docs": docs,
        "ci": ci_info,
        "base": cfg.base,
        "branch": gitio.current_branch(repo) or None,
        "next": "write_spec",
    }
