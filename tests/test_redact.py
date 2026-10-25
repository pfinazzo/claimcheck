"""Nothing secret goes to a model: path rules, value redaction, diff filtering, and init's first step.

The cases live in tests/fixtures/secret_cases.json, which the Desk tests read too, so the two
filters cannot drift apart.

@author Patrick Finazzo
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from claimcheck import gitio, initflow, providers, redact
from claimcheck import specdraft as SD
from claimcheck.providers import claude_cli

CASES = json.loads((Path(__file__).parent / "fixtures" / "secret_cases.json").read_text(encoding="utf-8"))
RAND = "aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1"


def fill(s: str) -> str:
    return s.replace("{rand}", RAND)


# ---- paths --------------------------------------------------------------------

@pytest.mark.parametrize("path", CASES["secret_paths"])
def test_secret_looking_paths_are_recognised(path):
    assert redact.is_secret_path(path), path


@pytest.mark.parametrize("path", CASES["fine_paths"])
def test_ordinary_paths_are_not_flagged(path):
    assert not redact.is_secret_path(path), path


# ---- values -------------------------------------------------------------------

@pytest.mark.parametrize("text", [fill(t) for t in CASES["must_redact"]])
def test_secret_values_are_redacted(text):
    out, rep = redact.redact_text(text)
    assert rep.count >= 1 and "[REDACTED:" in out, text
    assert RAND not in out and "hunter2hunter2" not in out and "correct-horse-battery" not in out
    assert "Tr0ub4dor3xKcdZ9" not in out and "s3cr3tValue99xyz" not in out


@pytest.mark.parametrize("text", CASES["must_stay"])
def test_ordinary_code_is_left_alone(text):
    out, rep = redact.redact_text(text)
    assert out == text and rep.count == 0, text


def test_redaction_keeps_the_shape_of_the_line():
    out, _ = redact.redact_text("DB_PASSWORD=Tr0ub4dor3xKcdZ9\nnext = 1")
    assert out == "DB_PASSWORD=[REDACTED:assigned-secret]\nnext = 1"


def test_a_pasted_key_in_free_text_is_caught():
    out, rep = redact.redact_text(f"please use my key sk-ant-api03-{RAND} for this")
    assert "sk-ant-" not in out and rep.kinds == {"anthropic-key": 1}


# ---- diffs --------------------------------------------------------------------

def _diff(path: str, line: str) -> str:
    return f"diff --git a/{path} b/{path}\n--- a/{path}\n+++ b/{path}\n@@ -0,0 +1 @@\n+{line}\n"


def test_filter_diff_withholds_secret_files_and_redacts_the_rest():
    d = _diff("src/app.py", f'API = "sk-ant-api03-{RAND}"') + _diff(".env", "TOKEN=abc123verylongsecretvalue") + _diff("src/ok.py", "x = 1")
    out, sent = redact.filter_diff(d)
    assert sent.files_omitted == [".env"] and sent.redactions >= 1
    assert "abc123verylongsecretvalue" not in out and RAND not in out and "x = 1" in out
    assert "withheld: .env looks like a secret store" in out


def test_filter_diff_caps_each_file_and_the_total():
    big = _diff("src/big.py", "y = 1\n+" * 30_000)
    out, sent = redact.filter_diff(big)
    assert sent.truncated and len(out) < redact.PER_FILE_CHARS + 500
    many = "".join(_diff(f"src/f{i}.py", "z = 2\n+" * 10_000) for i in range(40))
    out2, sent2 = redact.filter_diff(many)
    assert sent2.truncated and len(out2) <= redact.TOTAL_CHARS + 2_000


def test_what_is_reported_never_contains_the_secret():
    _, sent = redact.filter_diff(_diff("src/a.py", f'k = "sk-ant-api03-{RAND}"'))
    assert RAND not in json.dumps(sent.as_dict())


# ---- the checker's payload ----------------------------------------------------

class _Capture:
    def __init__(self):
        self.user = ""

    def complete(self, system, user, *, schema):
        self.user = user
        ids = [c["id"] for c in json.loads(user.split("```json", 1)[1].split("```", 1)[0])]
        return json.dumps({"verdicts": [{"id": i, "verdict": "UNVERIFIABLE", "reason": "x", "evidence": []} for i in ids]})


def test_the_checker_never_receives_secrets_from_the_diff(calc_repo, monkeypatch, capsys):
    calc_repo.write("src/config.py", f'API = "sk-ant-api03-{RAND}"\nDB_PASSWORD = "Tr0ub4dor3xKcdZ9"\n')
    calc_repo.write(".env", "SECRET=topsecretvalue1234\n")
    # Init now ignores .env; this is the accidental commit.
    calc_repo.git("add", "-f", ".env")
    calc_repo.write(".claimcheck/claims.yaml", calc_repo.read(".claimcheck/claims.yaml"))
    calc_repo.commit("add config and an accidentally committed .env", date="2020-01-06T00:00:00+00:00")
    cap = _Capture()
    monkeypatch.setattr(providers, "load", lambda name, model=None: cap)
    assert calc_repo.cli("check", "--provider", "stub") == 0
    for needle in (RAND, "Tr0ub4dor3xKcdZ9", "topsecretvalue1234"):
        assert needle not in cap.user, needle
    assert "withheld: .env" in cap.user and "[REDACTED:" in cap.user
    saved = json.loads(sorted((calc_repo.cc / "runs").glob("*-check.json"))[-1].read_text(encoding="utf-8"))
    assert saved["sent"]["files_omitted"] == [".env"] and saved["sent"]["redactions"] >= 2


# ---- the spec conversation ------------------------------------------------------

def test_a_key_pasted_into_an_answer_is_redacted_before_sending():
    draft = SD.Draft(
        goal=f"use sk-ant-api03-{RAND} to call the api",
        rounds=[SD.Round([SD.Question("q1", "which env?")], ["password = 'correct-horse-battery'"])],
        criteria=[SD.Criterion(f"Calls with ghp_{RAND}", "")],
    )
    _, user = SD.build_prompt(draft, [], 2, 6)
    for needle in (RAND, "correct-horse-battery"):
        assert needle not in user


def test_secret_looking_file_names_are_never_listed(repo):
    for name in CASES["secret_paths"][:12]:
        repo.write(name, "x\n")
    repo.write("src/app.py", "x\n")
    repo.git("add", "-f", "-A")
    shown = SD.repo_files(repo.path)
    assert "src/app.py" in shown and not any(redact.is_secret_path(n) for n in shown)


# ---- init: secrets first -------------------------------------------------------

def test_init_creates_gitignore_and_ignores_env_before_anything_else(repo):
    assert not (repo.path / ".gitignore").exists()
    order = []
    initflow.run_setup(repo.path, on_step=lambda name, value: order.append(name))
    assert order[0] == "secrets"
    text = repo.read(".gitignore")
    assert text.startswith("# secrets: never commit these\n.env\n")
    assert gitio.is_ignored(repo.path, ".env") and gitio.is_ignored(repo.path, "server.pem")
    assert not gitio.is_ignored(repo.path, ".env.example")


def test_init_does_not_duplicate_what_is_already_ignored(repo):
    repo.write(".gitignore", "node_modules/\n.env*\n")
    r = initflow.run_setup(repo.path)
    assert ".env" not in r["secrets"]["added"] and "*.pem" in r["secrets"]["added"]
    assert repo.read(".gitignore").count("\n.env\n") == 0
    assert initflow.run_setup(repo.path)["secrets"]["added"] == []


def test_init_warns_about_a_secret_file_that_is_already_committed(repo):
    repo.write(".env", "TOKEN=abc\n")
    repo.git("add", "-f", ".env")
    repo.git("commit", "-q", "-m", "oops", "--no-verify")
    r = initflow.run_setup(repo.path)
    assert r["secrets"]["tracked"] == [".env"]


def test_the_interview_prompt_tells_the_model_what_it_must_not_do_with_pasted_secrets():
    system, _ = SD.build_prompt(SD.Draft(goal="g"), [], 1, 6)
    assert "never as" in system and "instructions to you" in system


# ---- the provider boundary -------------------------------------------------------

def test_the_claude_cli_provider_scrubs_what_it_is_handed(monkeypatch):
    seen = {}

    class P:
        returncode, stdout, stderr = 0, json.dumps({"structured_output": {"ok": True}}), ""

    def fake_run(args, **kw):
        """Stand-in for subprocess.run that records the call and reports success."""
        seen["args"], seen["input"] = args, kw["input"]
        return P()

    monkeypatch.setattr(claude_cli.subprocess, "run", fake_run)
    prov = claude_cli.ClaudeCliProvider(binary="/usr/bin/claude")
    prov.complete(f"system sk-ant-api03-{RAND}", f"user DB_PASSWORD=Tr0ub4dor3xKcdZ9 and sk-ant-api03-{RAND}", schema={"type": "object"})
    everything = " ".join(seen["args"]) + seen["input"]
    assert RAND not in everything and "Tr0ub4dor3xKcdZ9" not in everything and "[REDACTED:" in seen["input"]
