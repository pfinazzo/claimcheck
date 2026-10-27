"""AC 14-20: prompt isolation, providers, verdict schema, check run.

@author Patrick Finazzo
"""

import importlib
import json
import sys
import types
from pathlib import Path

import pytest

from claimcheck import checker, claims, providers
from claimcheck.spec import make_criterion
from fakes import make_capturing_provider, make_failing_provider, make_sequence_provider

FIXTURES = Path(__file__).parent / "fixtures"


# ---- AC 14 ---------------------------------------------------------------

def test_ac14_prompt_is_pure_and_redacted(tmp_path):
    (tmp_path / "chat.log").write_text("ZZ_SENTINEL_CHAT", encoding="utf-8")
    criteria = [make_criterion(id=1, text="sub returns a - b"), make_criterion(id=2, text="is_adult inclusive")]
    cf, _ = claims.load_text(
        "version: 1\nclaims:\n"
        "  - id: c1\n    claim: 'sub returns a minus b'\n    confidence: 0.123456\n"
        "    criteria: [1]\n    files: ['src/calc.py']\n"
        "    kill_condition: 'obs: sub(5,3) is 2'\n    verified_by: ['ZZ_SENTINEL_VERIFIED']\n"
    )
    diff = "diff --git a/src/calc.py b/src/calc.py\n+def sub(a, b):\n+    return a - b\n"
    # The un-redacted claims object goes straight in: build_prompt must redact itself.
    assert cf is not None
    assert cf["claims"][0]["confidence"] == 0.123456 and "ZZ_SENTINEL_VERIFIED" in cf["claims"][0]["verified_by"]
    system, user = checker.build_prompt(criteria, diff_text=diff, claims=cf)
    blob = system + user
    for bad in ("0.123456", "ZZ_SENTINEL_VERIFIED", "ZZ_SENTINEL_CHAT"):
        assert bad not in blob
    for good in ("sub returns a - b", "is_adult inclusive", "sub returns a minus b", "obs: sub(5,3) is 2", diff):
        assert good in blob
    assert checker.build_prompt(criteria, diff_text=diff, claims=cf) == (system, user)
    assert checker.build_prompt(criteria, diff_text=diff, claims=cf["claims"]) == (system, user)
    assert checker.build_prompt(criteria, diff_text=diff, claims=claims.redact(cf)) == (system, user)


# ---- AC 15 ---------------------------------------------------------------

def test_ac15_load_names():
    assert providers.load("stub")["name"] == "stub"
    with pytest.raises(ValueError) as error:
        providers.load("gpt")
    assert "gpt" in str(error.value)


def test_ac15_providers_package_does_not_import_anthropic():
    sys.modules.pop("anthropic", None)
    importlib.reload(providers)
    assert "anthropic" not in sys.modules


# ---- AC 16 ---------------------------------------------------------------

def test_ac16_import_without_sdk_is_clear(monkeypatch):
    if importlib.util.find_spec("anthropic") is not None:
        pytest.skip("anthropic is installed here")
    sys.modules.pop("claimcheck.providers.claude", None)
    with pytest.raises(ImportError) as error:
        importlib.import_module("claimcheck.providers.claude")
    assert 'pip install "claimcheck[claude]"' in str(error.value)


def _install_fake_anthropic(monkeypatch, *, reply_text: str):
    calls = []

    def create(**kwargs):
        """Stand-in for messages.create: record the request and reply with `reply_text`."""
        calls.append(kwargs)
        return types.SimpleNamespace(content=[types.SimpleNamespace(type="text", text=reply_text)])

    def make_anthropic_client(*a, **k):
        """Stand-in for the anthropic.Anthropic constructor: record its options."""
        calls.append({"client": k})
        return types.SimpleNamespace(messages=types.SimpleNamespace(create=create))

    fake = types.ModuleType("anthropic")
    fake.__dict__["Anthropic"] = make_anthropic_client
    monkeypatch.setitem(sys.modules, "anthropic", fake)
    sys.modules.pop("claimcheck.providers.claude", None)
    return calls


def test_ac16_claude_provider_request_shape(monkeypatch):
    calls = _install_fake_anthropic(monkeypatch, reply_text='{"verdicts": []}')
    prov = providers.load("claude")
    output = providers.ask_model(prov, system="SYS", user="USER", schema=checker.VERDICT_SCHEMA)
    assert output == '{"verdicts": []}'
    assert calls[0] == {"client": {"timeout": 300}}
    kw = calls[1]
    assert kw["model"] == "claude-opus-5-5"
    assert kw["max_tokens"] == 16000
    assert kw["system"] == "SYS"
    assert kw["messages"] == [{"role": "user", "content": "USER"}]
    assert kw["output_config"] == {"format": {"type": "json_schema", "schema": checker.VERDICT_SCHEMA}}
    assert "thinking" not in kw
    assert providers.load("claude", model="claude-sonnet-5-5")["model"] == "claude-sonnet-5-5"
    sys.modules.pop("claimcheck.providers.claude", None)


# ---- AC 17 ---------------------------------------------------------------

def test_ac17_stub_default_marks_all_unverifiable():
    system, user = checker.build_prompt(
        [make_criterion(id=1, text="x")], diff_text="+x\n", claims=[{"id": "a", "claim": "c", "criteria": [], "files": ["f"], "kill_condition": "obs: y"}, {"id": "b", "claim": "d", "criteria": [], "files": ["f"], "kill_condition": "obs: z"}]
    )
    output = json.loads(providers.ask_model(providers.load("stub"), system=system, user=user, schema=checker.VERDICT_SCHEMA))
    assert [(each_verdict["id"], each_verdict["verdict"], each_verdict["reason"]) for each_verdict in output["verdicts"]] == [
        ("a", "UNVERIFIABLE", "stub provider"),
        ("b", "UNVERIFIABLE", "stub provider"),
    ]


def test_ac17_stub_file(monkeypatch, *, tmp_path):
    file = tmp_path / "v.json"
    file.write_text("{\"verdicts\": [{\"id\": \"q\", \"verdict\": \"REFUTED\", \"reason\": \"r\", \"evidence\": []}]}", encoding="utf-8")
    monkeypatch.setenv("CLAIMCHECK_STUB_FILE", str(file))
    assert providers.ask_model(providers.load("stub"), system="s", user="u", schema={}) == file.read_text(encoding="utf-8")


# ---- AC 18 ---------------------------------------------------------------

def test_ac18_schema_shape():
    text = checker.VERDICT_SCHEMA
    assert text["additionalProperties"] is False
    entry = text["properties"]["verdicts"]["items"]
    assert entry["additionalProperties"] is False
    assert entry["properties"]["verdict"]["enum"] == ["SUPPORTED", "REFUTED", "UNVERIFIABLE"]
    assert set(entry["required"]) == {"id", "verdict", "reason", "evidence"}


def test_ac18_validate_verdicts():
    good = {"verdicts": [{"id": "a", "verdict": "SUPPORTED", "reason": "", "evidence": []}]}
    assert checker.validate_verdicts(good, claim_ids={"a"}) == []
    assert any("missing verdicts for ['b']" in error for error in checker.validate_verdicts(good, claim_ids={"a", "b"}))
    unknown = {"verdicts": [{"id": "zz", "verdict": "SUPPORTED", "reason": "", "evidence": []}]}
    assert any("unknown id" in problem for problem in checker.validate_verdicts(unknown, claim_ids={"a"}))
    extra = {"verdicts": [{"id": "a", "verdict": "SUPPORTED", "reason": "", "evidence": [], "x": 1}]}
    assert any("wrong keys" in message for message in checker.validate_verdicts(extra, claim_ids={"a"}))


def test_ac18_retry_once_then_succeed():
    ok = json.dumps({"verdicts": [{"id": "a", "verdict": "REFUTED", "reason": "r", "evidence": ["+x"]}]})
    p, calls = make_sequence_provider("not json", ok)
    output = checker.ask(p, system="s", user="u", claim_ids=["a"])
    assert len(calls) == 2
    assert output[0]["verdict"] == "REFUTED"


def test_ac18_two_failures_fill_unverifiable():
    partial = json.dumps({"verdicts": [{"id": "a", "verdict": "SUPPORTED", "reason": "r", "evidence": []}]})
    p, calls = make_sequence_provider("garbage", partial)
    stdout = checker.ask(p, system="s", user="u", claim_ids=["a", "b"])
    assert len(calls) == 2
    # Salvaged from the second reply.
    assert stdout[0]["verdict"] == "SUPPORTED"
    assert stdout[1] == {"id": "b", "verdict": "UNVERIFIABLE", "reason": "provider output unparseable", "evidence": []}


# ---- AC 19 / 20 ----------------------------------------------------------

def _run_file(repo, *, kind):
    files = sorted((repo.cc / "runs").glob(f"*-{kind}.json"))
    assert files, f"no {kind} run file"
    return json.loads(files[-1].read_text(encoding="utf-8"))


def test_ac19_check_exit_0_and_run_file(calc_repo, *, capsys):
    assert calc_repo.cli("check", "--provider", "stub") == 0
    printed = json.loads(capsys.readouterr().out)
    saved = _run_file(calc_repo, kind="check")
    assert printed == saved
    assert saved["provider"] == "stub"
    assert saved["head"] == calc_repo.sha()
    assert saved["base"] == calc_repo.sha("main")
    assert len(saved["spec_lock"]) == 64
    assert [verdict["id"] for verdict in saved["verdicts"]] == ["c1", "c2"]


def test_ac19_worktree_flag(calc_repo, *, capsys):
    assert calc_repo.cli("check", "--provider", "stub", "--worktree") == 0
    assert json.loads(capsys.readouterr().out)["head"] == "worktree"


def test_ac19_exit_3_on_spec_refusal(calc_repo):
    calc_repo.write(".claimcheck/spec.md", text="- [ ] 1. different\n- [ ] 2. x\n")
    calc_repo.commit("drift")
    assert calc_repo.cli("check", "--provider", "stub") == 3


def test_ac19_exit_4_on_bad_claims(calc_repo):
    calc_repo.write(".claimcheck/claims.yaml", text="version: 1\nclaims: {}\n")
    calc_repo.commit("bad claims")
    assert calc_repo.cli("check", "--provider", "stub") == 4


def test_ac19_exit_5_on_provider_error(calc_repo, *, capsys):
    assert calc_repo.cli("check", "--provider", "nope") == 5
    assert "unknown provider" in capsys.readouterr().err


def test_ac19_exit_5_when_sdk_raises(calc_repo, *, monkeypatch, capsys):
    class BoomError(Exception):
        pass

    monkeypatch.setattr(providers, "load", lambda name, model=None: make_failing_provider(BoomError("kaboom")))
    assert calc_repo.cli("check", "--provider", "claude") == 5
    assert "BoomError: kaboom" in capsys.readouterr().err


def test_ac20_full_offline_refuted(calc_repo, *, monkeypatch, capsys):
    monkeypatch.setenv("CLAIMCHECK_STUB_FILE", str(FIXTURES / "stub_verdicts.json"))
    assert calc_repo.cli("check", "--provider", "stub") == 2
    saved = _run_file(calc_repo, kind="check")
    fixture = json.loads((FIXTURES / "stub_verdicts.json").read_text(encoding="utf-8"))
    assert saved["verdicts"] == fixture["verdicts"]


# ---- blindness holds end to end ------------------------------------------

@pytest.mark.parametrize("extra", [[], ["--worktree"]])
def test_checker_prompt_never_contains_author_confidence(calc_repo, *, monkeypatch, extra):
    # claims.yaml is committed on the branch, so it is part of base...HEAD. The checker must
    # still never see the confidence or verified_by text inside it, nor earlier ledger lines.

    calc_repo.write(".claimcheck/ledger.jsonl", text='{"leak": "LEDGER_SENTINEL"}\n')
    calc_repo.commit("ledger", date="2020-01-06T00:00:00+00:00")
    cap, prompts = make_capturing_provider()
    monkeypatch.setattr(providers, "load", lambda name, model=None: cap)
    assert calc_repo.cli("check", "--provider", "stub", *extra) == 0
    # The real diff is still there.
    assert "src/calc.py" in prompts[-1]
    assert "return a - b" in prompts[-1]
    for needle in ("confidence", "verified_by", "ran it", "pytest -q", "LEDGER_SENTINEL", "0.6"):
        assert needle not in prompts[-1], f"checker prompt leaked {needle!r}"
