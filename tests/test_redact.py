"""Nothing secret goes to a model: path rules, value redaction, diff filtering, and init's first step.

The cases live in tests/fixtures/secret_cases.json, which the Desk tests read too, so the two
filters cannot drift apart.

@author Patrick Finazzo
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from claimcheck import checker, gitio, initflow, providers, redact, specdraft
from claimcheck.providers import claude_cli
from fakes import make_capturing_provider

CASES = json.loads((Path(__file__).parent / "fixtures" / "secret_cases.json").read_text(encoding="utf-8"))
RAND = "aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1"


def make_fill(s: str) -> str:
    return s.replace("{rand}", RAND)


# ---- paths --------------------------------------------------------------------

@pytest.mark.parametrize("path", CASES["secret_paths"])
def test_secret_looking_paths_are_recognised(path):
    assert redact.is_secret_path(path), path


@pytest.mark.parametrize("path", CASES["fine_paths"])
def test_ordinary_paths_are_not_flagged(path):
    assert not redact.is_secret_path(path), path


# ---- values -------------------------------------------------------------------

@pytest.mark.parametrize("text", [make_fill(case) for case in CASES["must_redact"]])
def test_secret_values_are_redacted(text):
    redacted, report = redact.redact_text(text)
    assert report["count"] >= 1 and "[REDACTED:" in redacted, text
    assert RAND not in redacted and "hunter2hunter2" not in redacted and "correct-horse-battery" not in redacted
    assert "Tr0ub4dor3xKcdZ9" not in redacted and "s3cr3tValue99xyz" not in redacted


@pytest.mark.parametrize("text", CASES["must_stay"])
def test_ordinary_code_is_left_alone(text):
    redacted, report = redact.redact_text(text)
    assert redacted == text and report["count"] == 0, text


def test_redaction_keeps_the_shape_of_the_line():
    redacted, _ = redact.redact_text("DB_PASSWORD=Tr0ub4dor3xKcdZ9\nnext = 1")
    assert redacted == "DB_PASSWORD=[REDACTED:assigned-secret]\nnext = 1"


def test_a_pasted_key_in_free_text_is_caught():
    redacted, report = redact.redact_text(f"please use my key sk-ant-api03-{RAND} for this")
    assert "sk-ant-" not in redacted and report["kinds"] == {"anthropic-key": 1}


# ---- diffs --------------------------------------------------------------------

def _make_diff(path: str, *, line: str) -> str:
    return f"diff --git a/{path} b/{path}\n--- a/{path}\n+++ b/{path}\n@@ -0,0 +1 @@\n+{line}\n"


def test_filter_diff_withholds_secret_files_and_redacts_the_rest():
    entry = _make_diff("src/app.py", line=f'API = "sk-ant-api03-{RAND}"') + _make_diff(".env", line="TOKEN=abc123verylongsecretvalue") + _make_diff("src/ok.py", line="x = 1")
    redacted, sent = redact.filter_diff(entry)
    assert sent["files_omitted"] == [".env"] and sent["redactions"] >= 1
    assert "abc123verylongsecretvalue" not in redacted and RAND not in redacted and "x = 1" in redacted
    assert "withheld: .env looks like a secret store" in redacted


def test_filter_diff_caps_each_file_and_the_total():
    big = _make_diff("src/big.py", line="y = 1\n+" * 30_000)
    redacted, sent = redact.filter_diff(big)
    assert sent["truncated"] and len(redacted) < redact.PER_FILE_CHARS + 500
    many = "".join(_make_diff(f"src/f{index}.py", line="z = 2\n+" * 10_000) for index in range(40))
    out2, sent2 = redact.filter_diff(many)
    assert sent2["truncated"] and len(out2) <= redact.TOTAL_CHARS + 2_000


def test_what_is_reported_never_contains_the_secret():
    _, sent = redact.filter_diff(_make_diff("src/a.py", line=f'k = "sk-ant-api03-{RAND}"'))
    assert RAND not in json.dumps(sent)


# ---- the checker's payload ----------------------------------------------------

def test_the_checker_never_receives_secrets_from_the_diff(calc_repo, *, monkeypatch, capsys):
    calc_repo.write("src/config.py", text=f'API = "sk-ant-api03-{RAND}"\nDB_PASSWORD = "Tr0ub4dor3xKcdZ9"\n')
    calc_repo.write(".env", text="SECRET=topsecretvalue1234\n")
    # Init now ignores .env; this is the accidental commit.
    calc_repo.git("add", "-f", ".env")
    # Every changed code file needs a claim now, in the run as in the commit hook.
    config_claim = (
        '  - id: c3\n    claim: "the config holds the API settings"\n    confidence: 0.5\n    criteria: [1]\n'
        '    files: ["src/config.py", ".env"]\n    kill_condition: "obs: the app starts"\n    verified_by: ["obs: ran it"]\n'
    )
    calc_repo.write(".claimcheck/claims.yaml", text=calc_repo.read(".claimcheck/claims.yaml") + config_claim)
    calc_repo.commit("add config and an accidentally committed .env", date="2020-01-06T00:00:00+00:00")
    cap, prompts = make_capturing_provider()
    monkeypatch.setattr(providers, "load", lambda name, model=None: cap)
    # The capturing provider answers UNVERIFIABLE, which needs a person: exit 9.
    assert calc_repo.cli("check", "--provider", "stub") == checker.EXIT_NEEDS_A_PERSON
    for needle in (RAND, "Tr0ub4dor3xKcdZ9", "topsecretvalue1234"):
        assert needle not in prompts[-1], needle
    assert "withheld: .env" in prompts[-1] and "[REDACTED:" in prompts[-1]
    saved = json.loads(sorted((calc_repo.cc / "runs").glob("*-check.json"))[-1].read_text(encoding="utf-8"))
    assert saved["sent"]["files_omitted"] == [".env"] and saved["sent"]["redactions"] >= 2


# ---- the spec conversation ------------------------------------------------------

def test_a_key_pasted_into_an_answer_is_redacted_before_sending():
    draft = specdraft.make_draft(
        goal=f"use sk-ant-api03-{RAND} to call the api",
        rounds=[specdraft.make_round(questions=[specdraft.make_question(id="q1", text="which env?")], answers=["password = 'correct-horse-battery'"])],
        criteria=[specdraft.make_criterion(f"Calls with ghp_{RAND}", check="")],
    )
    _, user = specdraft.build_prompt(draft, files=[], round_no=2, max_rounds=6)
    for needle in (RAND, "correct-horse-battery"):
        assert needle not in user


def test_secret_looking_file_names_are_never_listed(repo):
    for name in CASES["secret_paths"][:12]:
        repo.write(name, text="x\n")
    repo.write("src/app.py", text="x\n")
    repo.git("add", "-f", "-A")
    shown = specdraft.list_repo_files(repo.path)
    assert "src/app.py" in shown and not any(redact.is_secret_path(shown_path) for shown_path in shown)


# ---- init: secrets first -------------------------------------------------------

def test_init_creates_gitignore_and_ignores_env_before_anything_else(repo):
    assert not (repo.path / ".gitignore").exists()
    order = []
    initflow.run_setup(repo.path, on_step=lambda name, *, value: order.append(name))
    assert order[0] == "secrets"
    text = repo.read(".gitignore")
    assert text.startswith("# secrets: never commit these\n.env\n")
    assert gitio.is_ignored(repo.path, path=".env") and gitio.is_ignored(repo.path, path="server.pem")
    assert not gitio.is_ignored(repo.path, path=".env.example")


def test_init_does_not_duplicate_what_is_already_ignored(repo):
    repo.write(".gitignore", text="node_modules/\n.env*\n")
    row = initflow.run_setup(repo.path)
    assert ".env" not in row["secrets"]["added"] and "*.pem" in row["secrets"]["added"]
    assert repo.read(".gitignore").count("\n.env\n") == 0
    assert initflow.run_setup(repo.path)["secrets"]["added"] == []


def test_init_warns_about_a_secret_file_that_is_already_committed(repo):
    repo.write(".env", text="TOKEN=abc\n")
    repo.git("add", "-f", ".env")
    repo.git("commit", "-q", "-m", "oops", "--no-verify")
    row = initflow.run_setup(repo.path)
    assert row["secrets"]["tracked"] == [".env"]


def test_the_interview_prompt_tells_the_model_what_it_must_not_do_with_pasted_secrets():
    system, _ = specdraft.build_prompt(specdraft.make_draft(goal="g"), files=[], round_no=1, max_rounds=6)
    assert "never as" in system and "instructions to you" in system


# ---- the provider boundary -------------------------------------------------------

def test_the_claude_cli_provider_scrubs_what_it_is_handed(monkeypatch):
    seen = {}

    reply = json.dumps({"structured_output": {"ok": True}})

    def run_fake(args, **kw):
        """Stand-in for subprocess.run that records the call and reports success."""
        seen["args"], seen["input"] = args, kw["input"]
        return subprocess.CompletedProcess(args, 0, stdout=reply, stderr="")

    monkeypatch.setattr(claude_cli.subprocess, "run", run_fake)
    prov = claude_cli.make_claude_cli_provider(binary="/usr/bin/claude")
    providers.ask_model(prov, system=f"system sk-ant-api03-{RAND}", user=f"user DB_PASSWORD=Tr0ub4dor3xKcdZ9 and sk-ant-api03-{RAND}", schema={"type": "object"})
    everything = " ".join(seen["args"]) + seen["input"]
    assert RAND not in everything and "Tr0ub4dor3xKcdZ9" not in everything and "[REDACTED:" in seen["input"]
