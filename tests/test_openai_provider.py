"""The openai provider, tested against a real HTTP server on this machine.

The fake server records every request and answers with whatever the test sets up. That runs the
whole path: the request body, the headers, the HTTP status, and the reply parsing.

@author Patrick Finazzo
"""

import json
import socket
import threading
import time
import types
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from claimcheck import ProviderError, checker, cli, config, detect, providers
from claimcheck.providers import openai_compatible

CASES = json.loads((Path(__file__).parent / "fixtures" / "secret_cases.json").read_text(encoding="utf-8"))
RAND = "aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1"
SCHEMA = {"type": "object", "properties": {"verdicts": {"type": "array"}}, "required": ["verdicts"]}
REPLY_JSON = '{"verdicts": []}'


def make_chat_reply(content: str, *, finish_reason: str = "stop") -> dict:
    """A chat completions response body with one choice."""
    return {"choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": finish_reason}]}


def make_handler(server_state: types.SimpleNamespace) -> type[BaseHTTPRequestHandler]:
    """A request handler that records each request and answers from `server_state`."""

    class FakeChatHandler(BaseHTTPRequestHandler):
        """Records the request, waits if asked, then sends the configured status and body."""

        def do_POST(self) -> None:
            length = int(self.headers.get("Content-Length") or 0)
            server_state.requests.append(
                {"path": self.path, "headers": dict(self.headers), "body": json.loads(self.rfile.read(length) or b"{}")}
            )
            time.sleep(server_state.delay_s)
            payload = server_state.body if isinstance(server_state.body, str) else json.dumps(server_state.body)
            self.send_response(server_state.status)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(payload.encode("utf-8"))

        def log_message(self, format: str, *args: object) -> None:  # noqa: A002 - the base class names it `format`
            """Keep the test output quiet."""

    return FakeChatHandler


@pytest.fixture
def fake_server() -> Iterator[types.SimpleNamespace]:
    server_state = types.SimpleNamespace(requests=[], status=200, body=make_chat_reply(REPLY_JSON), delay_s=0.0)
    server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(server_state))
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    server_state.base_url = f"http://127.0.0.1:{server.server_address[1]}/v1"
    yield server_state
    server.shutdown()
    server.server_close()


@pytest.fixture(autouse=True)
def clear_openai_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in (config.OPENAI_BASE_URL_ENV, config.OPENAI_API_KEY_ENV, config.OPENAI_MODEL_ENV):
        monkeypatch.delenv(name, raising=False)


def ask(provider: providers.Provider, *, user: str = "Check these claims.") -> str:
    """One request through the provider with the test schema."""
    return providers.ask_model(provider, system="You are the checker.", user=user, schema=SCHEMA)


def find_free_port() -> int:
    """A local port with nothing listening on it."""
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


# ---- choosing the provider ------------------------------------------------------

def test_openai_is_a_provider_name_load_accepts(fake_server, *, monkeypatch):
    monkeypatch.setenv(config.OPENAI_BASE_URL_ENV, fake_server.base_url)
    provider = providers.load("openai", model="llama3.2")
    assert "openai" in providers.NAMES
    assert provider["name"] == "openai" and provider["model"] == "llama3.2"


def test_config_toml_can_name_the_openai_provider(tmp_path):
    (tmp_path / ".claimcheck").mkdir()
    (tmp_path / ".claimcheck" / "config.toml").write_text('version = 1\n[checker]\nprovider = "openai"\nmodel = "llama3.2"\n', encoding="utf-8")
    settings = config.load(tmp_path)
    assert settings["checker_provider"] == "openai" and settings["checker_model"] == "llama3.2"


def test_check_runs_through_the_openai_provider(calc_repo, *, fake_server, monkeypatch):
    monkeypatch.setenv(config.OPENAI_BASE_URL_ENV, fake_server.base_url)
    fake_server.body = make_chat_reply(
        json.dumps({"verdicts": [{"id": claim_id, "verdict": "SUPPORTED", "reason": "the diff does it", "evidence": []} for claim_id in ("c1", "c2")]})
    )
    outcome, code = checker.run_check(
        calc_repo.path, settings=config.load(calc_repo.path), provider_name="openai", model="llama3.2"
    )
    assert len(fake_server.requests) == 1 and fake_server.requests[0]["body"]["model"] == "llama3.2"
    assert outcome["provider"] == "openai" and code == 0
    assert [verdict["verdict"] for verdict in outcome["verdicts"]] == ["SUPPORTED", "SUPPORTED"]


def test_auto_still_picks_claude_when_openai_variables_are_set(monkeypatch):
    monkeypatch.setenv(config.OPENAI_BASE_URL_ENV, "http://127.0.0.1:1/v1")
    monkeypatch.setenv(config.OPENAI_API_KEY_ENV, "test-key")
    monkeypatch.setenv(config.OPENAI_MODEL_ENV, "llama3.2")
    monkeypatch.delenv(config.API_KEY_ENV, raising=False)
    monkeypatch.setattr(providers.claude_cli, "find_claude", lambda env=None: "/usr/bin/claude")
    assert providers.load("auto")["name"] == "claude-cli"


# ---- the request --------------------------------------------------------------

@pytest.mark.parametrize("suffix", ["", "/"])
def test_request_goes_to_chat_completions_with_or_without_a_trailing_slash(fake_server, *, suffix):
    ask(openai_compatible.make_openai_provider(model="m", base_url=fake_server.base_url + suffix))
    assert fake_server.requests[0]["path"] == "/v1/chat/completions"


def test_an_unset_base_url_means_openai_itself(monkeypatch):
    sent_urls = []

    def record_post(url, **_):
        sent_urls.append(url)
        return json.dumps(make_chat_reply(REPLY_JSON))

    monkeypatch.setattr(openai_compatible, "_post_json", record_post)
    ask(openai_compatible.make_openai_provider(model="m"))
    assert sent_urls == ["https://api.openai.com/v1/chat/completions"]


def test_the_key_is_sent_as_a_bearer_token(fake_server, *, monkeypatch):
    monkeypatch.setenv(config.OPENAI_API_KEY_ENV, "test-key")
    ask(openai_compatible.make_openai_provider(model="m", base_url=fake_server.base_url))
    assert fake_server.requests[0]["headers"]["Authorization"] == "Bearer test-key"


def test_no_key_means_no_authorization_header(fake_server):
    assert ask(openai_compatible.make_openai_provider(model="m", base_url=fake_server.base_url)) == REPLY_JSON
    assert "Authorization" not in fake_server.requests[0]["headers"]


def test_a_passed_model_is_sent_and_wins_over_openai_model(fake_server, *, monkeypatch):
    monkeypatch.setenv(config.OPENAI_MODEL_ENV, "from-environment")
    ask(openai_compatible.make_openai_provider(model="from-flag", base_url=fake_server.base_url))
    assert fake_server.requests[0]["body"]["model"] == "from-flag"


def test_openai_model_is_used_when_no_model_is_passed(fake_server, *, monkeypatch):
    monkeypatch.setenv(config.OPENAI_MODEL_ENV, "from-environment")
    monkeypatch.setenv(config.OPENAI_BASE_URL_ENV, fake_server.base_url)
    ask(providers.load("openai", model=None))
    assert fake_server.requests[0]["body"]["model"] == "from-environment"


def test_no_model_anywhere_fails_before_any_request(fake_server):
    with pytest.raises(ProviderError) as error:
        openai_compatible.make_openai_provider(base_url=fake_server.base_url)
    for name in ("--model", "[checker] model", "OPENAI_MODEL"):
        assert name in str(error.value)
    assert fake_server.requests == []


def test_a_base_url_without_http_is_refused_before_any_request():
    with pytest.raises(ProviderError, match="http:// or https://"):
        openai_compatible.make_openai_provider(model="m", base_url="localhost:11434/v1")


def test_the_body_asks_for_json_twice(fake_server):
    ask(openai_compatible.make_openai_provider(model="m", base_url=fake_server.base_url), user="Check these claims.")
    body = fake_server.requests[0]["body"]
    assert body["messages"][0] == {"role": "system", "content": "You are the checker."}
    assert body["messages"][1]["role"] == "user" and body["messages"][1]["content"].startswith("Check these claims.")
    assert json.dumps(SCHEMA) in body["messages"][1]["content"]
    assert body["response_format"] == {"type": "json_schema", "json_schema": {"name": "reply", "schema": SCHEMA, "strict": False}}
    assert "stream" not in body


@pytest.mark.parametrize("text", [case.replace("{rand}", RAND) for case in CASES["must_redact"]])
def test_no_secret_reaches_the_server(fake_server, *, text):
    ask(openai_compatible.make_openai_provider(model="m", base_url=fake_server.base_url), user=f"diff:\n{text}\n")
    sent = json.dumps(fake_server.requests[0]["body"])
    assert RAND not in sent and "[REDACTED:" in sent


# ---- the reply ------------------------------------------------------------------

def test_a_fenced_reply_comes_back_as_bare_json(fake_server):
    fake_server.body = make_chat_reply(f"```json\n{REPLY_JSON}\n```")
    assert ask(openai_compatible.make_openai_provider(model="m", base_url=fake_server.base_url)) == REPLY_JSON


def test_an_unfenced_reply_is_returned_as_it_came():
    assert openai_compatible.strip_code_fences("not fenced ```json") == "not fenced ```json"


@pytest.mark.parametrize(
    ("status", "hint"),
    [
        (401, "OPENAI_API_KEY"),
        (403, "OPENAI_API_KEY"),
        (404, "OPENAI_BASE_URL and the model name"),
        (429, "rate limiting"),
    ],
)
def test_an_error_status_names_the_server_and_says_what_to_check(fake_server, *, status, hint):
    fake_server.status = status
    fake_server.body = {"error": {"message": "the server said no"}}
    with pytest.raises(ProviderError) as error:
        ask(openai_compatible.make_openai_provider(model="m", base_url=fake_server.base_url))
    message = str(error.value)
    assert fake_server.base_url in message and str(status) in message
    assert "the server said no" in message and hint in message


def test_any_other_status_shows_the_server_message_cut_short(fake_server):
    fake_server.status = 500
    fake_server.body = "x" * 1000
    with pytest.raises(ProviderError) as error:
        ask(openai_compatible.make_openai_provider(model="m", base_url=fake_server.base_url))
    message = str(error.value)
    assert "answered 500" in message and "x" * 300 in message and "x" * 301 not in message


def test_an_error_message_never_holds_the_key(fake_server, *, monkeypatch):
    monkeypatch.setenv(config.OPENAI_API_KEY_ENV, f"sk-{RAND}")
    fake_server.status = 401
    fake_server.body = {"error": {"message": f"Incorrect API key provided: sk-{RAND}"}}
    with pytest.raises(ProviderError) as error:
        ask(openai_compatible.make_openai_provider(model="m", base_url=fake_server.base_url))
    assert RAND not in str(error.value)


def test_an_error_status_is_tried_once_and_never_retried(fake_server):
    fake_server.status = 500
    with pytest.raises(ProviderError):
        ask(openai_compatible.make_openai_provider(model="m", base_url=fake_server.base_url))
    assert len(fake_server.requests) == 1


def test_a_body_that_is_not_json_is_named(fake_server):
    fake_server.body = "<html>gateway</html>"
    with pytest.raises(ProviderError, match="did not reply with JSON"):
        ask(openai_compatible.make_openai_provider(model="m", base_url=fake_server.base_url))


@pytest.mark.parametrize("body", [{"choices": []}, {"choices": [{"message": {"content": ""}}]}, {"id": "x"}])
def test_a_reply_with_no_message_content_is_named(fake_server, *, body):
    fake_server.body = body
    with pytest.raises(ProviderError, match="no message content"):
        ask(openai_compatible.make_openai_provider(model="m", base_url=fake_server.base_url))


def test_an_unreachable_server_says_to_check_it_is_running():
    base_url = f"http://127.0.0.1:{find_free_port()}/v1"
    with pytest.raises(ProviderError) as error:
        ask(openai_compatible.make_openai_provider(model="m", base_url=base_url))
    assert "could not reach the model server at " + base_url in str(error.value)
    assert "Check it is running" in str(error.value)


def test_a_server_that_never_answers_times_out(fake_server):
    fake_server.delay_s = 2.0
    with pytest.raises(ProviderError, match="did not answer within"):
        ask(openai_compatible.make_openai_provider(model="m", base_url=fake_server.base_url, timeout_s=0.3))


def test_the_default_timeout_matches_the_other_providers():
    assert openai_compatible.DEFAULT_TIMEOUT_S == 300


# ---- where the name is listed ---------------------------------------------------

def test_the_config_init_writes_lists_openai():
    detection = detect.make_detection(stack=None, others=[])
    assert '"openai"' in detect.render_config(detection)


@pytest.mark.parametrize("command", [["spec", "draft"], ["check"], ["run"]])
def test_the_provider_help_lists_openai(command, *, capsys):
    with pytest.raises(SystemExit):
        cli.build_parser().parse_args([*command, "--help"])
    assert "openai" in capsys.readouterr().out
