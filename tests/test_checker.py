"""AC 14-20: prompt isolation, providers, verdict schema, check run.

@author Patrick Finazzo
"""

import importlib
import json
import sys
import types
from pathlib import Path

import pytest

from claimcheck import ProviderError, checker, providers
from claimcheck import claims as CL
from claimcheck.spec import Criterion

FIXTURES = Path(__file__).parent / "fixtures"


# ---- AC 14 ---------------------------------------------------------------

def test_ac14_prompt_is_pure_and_redacted(tmp_path):
    (tmp_path / "chat.log").write_text("ZZ_SENTINEL_CHAT", encoding="utf-8")
    criteria = [Criterion(1, "sub returns a - b"), Criterion(2, "is_adult inclusive")]
    cf, _ = CL.load_text(
        "version: 1\nclaims:\n"
        "  - id: c1\n    claim: 'sub returns a minus b'\n    confidence: 0.123456\n"
        "    criteria: [1]\n    files: ['src/calc.py']\n"
        "    kill_condition: 'obs: sub(5,3) is 2'\n    verified_by: ['ZZ_SENTINEL_VERIFIED']\n"
    )
    diff = "diff --git a/src/calc.py b/src/calc.py\n+def sub(a, b):\n+    return a - b\n"
    # The un-redacted claims object goes straight in: build_prompt must redact itself.
    assert cf.claims[0].confidence == 0.123456 and "ZZ_SENTINEL_VERIFIED" in cf.claims[0].verified_by
    system, user = checker.build_prompt(criteria, diff, cf)
    blob = system + user
    for bad in ("0.123456", "ZZ_SENTINEL_VERIFIED", "ZZ_SENTINEL_CHAT"):
        assert bad not in blob
    for good in ("sub returns a - b", "is_adult inclusive", "sub returns a minus b", "obs: sub(5,3) is 2", diff):
        assert good in blob
    assert checker.build_prompt(criteria, diff, cf) == (system, user)
    assert checker.build_prompt(criteria, diff, cf.claims) == (system, user)
    assert checker.build_prompt(criteria, diff, CL.redact(cf)) == (system, user)


# ---- AC 15 ---------------------------------------------------------------

def test_ac15_load_names():
    assert type(providers.load("stub")).__name__ == "StubProvider"
    with pytest.raises(ValueError) as e:
        providers.load("gpt")
    assert "gpt" in str(e.value)


def test_ac15_providers_package_does_not_import_anthropic():
    sys.modules.pop("anthropic", None)
    importlib.reload(providers)
    assert "anthropic" not in sys.modules


# ---- AC 16 ---------------------------------------------------------------

def test_ac16_import_without_sdk_is_clear(monkeypatch):
    if importlib.util.find_spec("anthropic") is not None:
        pytest.skip("anthropic is installed here")
    sys.modules.pop("claimcheck.providers.claude", None)
    with pytest.raises(ImportError) as e:
        importlib.import_module("claimcheck.providers.claude")
    assert 'pip install "claimcheck[claude]"' in str(e.value)


def _fake_anthropic(monkeypatch, reply_text: str):
    calls = []

    class _Messages:
        def create(self, **kwargs):
            calls.append(kwargs)
            return types.SimpleNamespace(content=[types.SimpleNamespace(type="text", text=reply_text)])

    class Anthropic:
        def __init__(self, *a, **k):
            self.messages = _Messages()

    fake = types.ModuleType("anthropic")
    fake.Anthropic = Anthropic
    monkeypatch.setitem(sys.modules, "anthropic", fake)
    sys.modules.pop("claimcheck.providers.claude", None)
    return calls


def test_ac16_claude_provider_request_shape(monkeypatch):
    calls = _fake_anthropic(monkeypatch, '{"verdicts": []}')
    prov = providers.load("claude")
    out = prov.complete("SYS", "USER", schema=checker.VERDICT_SCHEMA)
    assert out == '{"verdicts": []}'
    kw = calls[0]
    assert kw["model"] == "claude-opus-5-5"
    assert kw["max_tokens"] == 16000
    assert kw["system"] == "SYS"
    assert kw["messages"] == [{"role": "user", "content": "USER"}]
    assert kw["output_config"] == {"format": {"type": "json_schema", "schema": checker.VERDICT_SCHEMA}}
    assert "thinking" not in kw
    assert providers.load("claude", model="claude-sonnet-5-5").model == "claude-sonnet-5-5"
    sys.modules.pop("claimcheck.providers.claude", None)


# ---- AC 17 ---------------------------------------------------------------

def test_ac17_stub_default_marks_all_unverifiable():
    system, user = checker.build_prompt(
        [Criterion(1, "x")], "+x\n", [{"id": "a", "claim": "c", "criteria": [], "files": ["f"], "kill_condition": "obs: y"}, {"id": "b", "claim": "d", "criteria": [], "files": ["f"], "kill_condition": "obs: z"}]
    )
    out = json.loads(providers.load("stub").complete(system, user, schema=checker.VERDICT_SCHEMA))
    assert [(v["id"], v["verdict"], v["reason"]) for v in out["verdicts"]] == [
        ("a", "UNVERIFIABLE", "stub provider"),
        ("b", "UNVERIFIABLE", "stub provider"),
    ]


def test_ac17_stub_file(monkeypatch, tmp_path):
    f = tmp_path / "v.json"
    f.write_text("{\"verdicts\": [{\"id\": \"q\", \"verdict\": \"REFUTED\", \"reason\": \"r\", \"evidence\": []}]}", encoding="utf-8")
    monkeypatch.setenv("CLAIMCHECK_STUB_FILE", str(f))
    assert providers.load("stub").complete("s", "u", schema={}) == f.read_text(encoding="utf-8")


# ---- AC 18 ---------------------------------------------------------------

def test_ac18_schema_shape():
    s = checker.VERDICT_SCHEMA
    assert s["additionalProperties"] is False
    item = s["properties"]["verdicts"]["items"]
    assert item["additionalProperties"] is False
    assert item["properties"]["verdict"]["enum"] == ["SUPPORTED", "REFUTED", "UNVERIFIABLE"]
    assert set(item["required"]) == {"id", "verdict", "reason", "evidence"}


def test_ac18_validate_verdicts():
    good = {"verdicts": [{"id": "a", "verdict": "SUPPORTED", "reason": "", "evidence": []}]}
    assert checker.validate_verdicts(good, {"a"}) == []
    assert any("missing verdicts for ['b']" in e for e in checker.validate_verdicts(good, {"a", "b"}))
    unknown = {"verdicts": [{"id": "zz", "verdict": "SUPPORTED", "reason": "", "evidence": []}]}
    assert any("unknown id" in e for e in checker.validate_verdicts(unknown, {"a"}))
    extra = {"verdicts": [{"id": "a", "verdict": "SUPPORTED", "reason": "", "evidence": [], "x": 1}]}
    assert any("wrong keys" in e for e in checker.validate_verdicts(extra, {"a"}))


class _Seq:
    def __init__(self, replies):
        self.replies = list(replies)
        self.calls = 0

    def complete(self, system, user, *, schema):
        self.calls += 1
        return self.replies.pop(0)


def test_ac18_retry_once_then_succeed():
    ok = json.dumps({"verdicts": [{"id": "a", "verdict": "REFUTED", "reason": "r", "evidence": ["+x"]}]})
    p = _Seq(["not json", ok])
    out = checker.ask(p, "s", "u", ["a"])
    assert p.calls == 2
    assert out[0]["verdict"] == "REFUTED"


def test_ac18_two_failures_fill_unverifiable():
    partial = json.dumps({"verdicts": [{"id": "a", "verdict": "SUPPORTED", "reason": "r", "evidence": []}]})
    p = _Seq(["garbage", partial])
    out = checker.ask(p, "s", "u", ["a", "b"])
    assert p.calls == 2
    assert out[0]["verdict"] == "SUPPORTED"  # salvaged from the second reply
    assert out[1] == {"id": "b", "verdict": "UNVERIFIABLE", "reason": "provider output unparseable", "evidence": []}


# ---- AC 19 / 20 ----------------------------------------------------------

def _run_file(repo, kind):
    files = sorted((repo.cc / "runs").glob(f"*-{kind}.json"))
    assert files, f"no {kind} run file"
    return json.loads(files[-1].read_text(encoding="utf-8"))


def test_ac19_check_exit_0_and_run_file(calc_repo, capsys):
    assert calc_repo.cli("check", "--provider", "stub") == 0
    printed = json.loads(capsys.readouterr().out)
    saved = _run_file(calc_repo, "check")
    assert printed == saved
    assert saved["provider"] == "stub"
    assert saved["head"] == calc_repo.sha()
    assert saved["base"] == calc_repo.sha("main")
    assert len(saved["spec_lock"]) == 64
    assert [v["id"] for v in saved["verdicts"]] == ["c1", "c2"]


def test_ac19_worktree_flag(calc_repo, capsys):
    assert calc_repo.cli("check", "--provider", "stub", "--worktree") == 0
    assert json.loads(capsys.readouterr().out)["head"] == "worktree"


def test_ac19_exit_3_on_spec_refusal(calc_repo):
    calc_repo.write(".claimcheck/spec.md", "- [ ] 1. different\n- [ ] 2. x\n")
    calc_repo.commit("drift")
    assert calc_repo.cli("check", "--provider", "stub") == 3


def test_ac19_exit_4_on_bad_claims(calc_repo):
    calc_repo.write(".claimcheck/claims.yaml", "version: 1\nclaims: {}\n")
    calc_repo.commit("bad claims")
    assert calc_repo.cli("check", "--provider", "stub") == 4


def test_ac19_exit_5_on_provider_error(calc_repo, capsys):
    assert calc_repo.cli("check", "--provider", "nope") == 5
    assert "unknown provider" in capsys.readouterr().err


def test_ac19_exit_5_when_sdk_raises(calc_repo, monkeypatch, capsys):
    class Boom(Exception):
        pass

    class _P:
        def complete(self, *a, **k):
            raise Boom("kaboom")

    monkeypatch.setattr(providers, "load", lambda name, model=None: _P())
    assert calc_repo.cli("check", "--provider", "claude") == 5
    assert "Boom: kaboom" in capsys.readouterr().err


def test_ac20_full_offline_refuted(calc_repo, monkeypatch, capsys):
    monkeypatch.setenv("CLAIMCHECK_STUB_FILE", str(FIXTURES / "stub_verdicts.json"))
    assert calc_repo.cli("check", "--provider", "stub") == 2
    saved = _run_file(calc_repo, "check")
    fixture = json.loads((FIXTURES / "stub_verdicts.json").read_text(encoding="utf-8"))
    assert saved["verdicts"] == fixture["verdicts"]
