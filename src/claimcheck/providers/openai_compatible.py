"""Provider for any server that speaks OpenAI's chat completions API.

That covers OpenAI itself and local servers such as Ollama, LM Studio and vLLM. It uses the
standard library only, so choosing it adds no dependency. Where it connects and with which key
come from OPENAI_BASE_URL and OPENAI_API_KEY, read in `config`.

It asks for JSON in two ways. The request carries the schema as `response_format`, and the user
message repeats the schema as text, because some servers ignore `response_format`. It never
retries: the checker already asks once more when a reply is unusable.

@author Patrick Finazzo
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.request

from .. import ProviderError, config, redact
from .shapes import Provider, Request, make_provider

DEFAULT_BASE_URL = "https://api.openai.com/v1"
# The same budget the Claude providers get, so a stalled server cannot freeze a run.
DEFAULT_TIMEOUT_S = 300
# How much of a server's error message is shown. Enough to read, short enough not to flood the terminal.
SERVER_MESSAGE_LIMIT = 300
FENCED_REPLY = re.compile(r"^\s*```(?:json)?\s*(.*?)\s*```\s*$", re.DOTALL | re.IGNORECASE)

# What to change, per HTTP status. Any other status gets the status and the server's message only.
HINTS_BY_STATUS = {
    401: "The server refused the key. Check OPENAI_API_KEY.",
    403: "The server refused the key. Check OPENAI_API_KEY.",
    404: "Check OPENAI_BASE_URL and the model name.",
    429: "The server is rate limiting this key, or its quota is used up. Wait, or check the account.",
}


def make_openai_provider(
    *,
    model: str | None = None,
    base_url: str | None = None,
    api_key: str | None = None,
    timeout_s: float = DEFAULT_TIMEOUT_S,
) -> Provider:
    """A provider that asks an OpenAI-compatible server.

    The model is the one passed in, else OPENAI_MODEL. Raises ProviderError before any request
    when no model is set or the base URL is not http(s).
    """
    chosen_model = model or config.read_openai_model()
    if not chosen_model:
        raise ProviderError(
            "the openai provider needs a model: pass --model, set [checker] model in "
            ".claimcheck/config.toml, or set OPENAI_MODEL."
        )
    chosen_base_url = (base_url or config.read_openai_base_url() or DEFAULT_BASE_URL).rstrip("/")
    if not chosen_base_url.startswith(("http://", "https://")):
        raise ProviderError(f"OPENAI_BASE_URL must start with http:// or https://, not {chosen_base_url!r}.")
    chosen_key = api_key if api_key is not None else config.read_openai_api_key()

    def answer_request(request: Request) -> str:
        """One chat completions request; returns the reply's text."""
        # Last line of defence: whatever built these strings, nothing secret-looking leaves the process.
        system, user = redact.redact_text(request["system"])[0], redact.redact_text(request["user"])[0]
        body = build_request_body(model=chosen_model, system=system, user=user, schema=request["schema"])
        raw = _post_json(f"{chosen_base_url}/chat/completions", body=body, api_key=chosen_key, base_url=chosen_base_url, timeout_s=timeout_s)
        return read_reply_text(raw, base_url=chosen_base_url)

    return make_provider("openai", complete=answer_request, model=chosen_model)


def build_request_body(*, model: str, system: str, user: str, schema: dict) -> dict:
    """The chat completions body: both messages, and the schema as response_format and as text."""
    schema_text = json.dumps(schema)
    return {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": f"{user}\n\nReply with JSON only, matching this schema:\n{schema_text}"},
        ],
        "response_format": {"type": "json_schema", "json_schema": {"name": "reply", "schema": schema, "strict": False}},
    }


def _post_json(url: str, *, body: dict, api_key: str | None, base_url: str, timeout_s: float) -> str:
    """POST the body once and return the response text. Raises ProviderError that says what to fix."""
    auth = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    outgoing = urllib.request.Request(
        url, data=json.dumps(body).encode("utf-8"), headers={"Content-Type": "application/json", **auth}, method="POST"
    )
    try:
        with urllib.request.urlopen(outgoing, timeout=timeout_s) as response:
            return response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as error:
        raise ProviderError(describe_http_error(error.code, body=error.read().decode("utf-8", errors="replace"), base_url=base_url)) from None
    except TimeoutError:
        raise ProviderError(f"the model server at {base_url} did not answer within {timeout_s}s.") from None
    except urllib.error.URLError as error:
        if isinstance(error.reason, TimeoutError):
            raise ProviderError(f"the model server at {base_url} did not answer within {timeout_s}s.") from None
        raise ProviderError(
            f"could not reach the model server at {base_url} ({error.reason}). Check it is running and OPENAI_BASE_URL is right."
        ) from None


def describe_http_error(status: int, *, body: str, base_url: str) -> str:
    """The message for a non-2xx answer: the status, the server's own words cut short, and a hint."""
    server_message = redact.redact_text(_read_server_message(body))[0][:SERVER_MESSAGE_LIMIT]
    hint = HINTS_BY_STATUS.get(status, "")
    return " ".join(part for part in (f"the model server at {base_url} answered {status}: {server_message}", hint) if part)


def _read_server_message(body: str) -> str:
    """The `error.message` an OpenAI-style server sends, or the raw body when there is none."""
    try:
        parsed = json.loads(body)
    except json.JSONDecodeError:
        return body.strip()
    error = parsed.get("error") if isinstance(parsed, dict) else None
    message = error.get("message") if isinstance(error, dict) else error
    return message if isinstance(message, str) and message.strip() else body.strip()


def read_reply_text(raw: str, *, base_url: str) -> str:
    """The first choice's message content, with ```json fences stripped. Raises ProviderError when absent."""
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        raise ProviderError(f"the model server at {base_url} did not reply with JSON: {raw[:200]!r}") from None
    content = _read_first_message_content(parsed)
    if not content:
        raise ProviderError(f"the model server at {base_url} sent a reply with no message content.")
    return strip_code_fences(content)


def _read_first_message_content(parsed: object) -> str:
    """choices[0].message.content, or an empty string when any step of that path is missing."""
    choices = parsed.get("choices") if isinstance(parsed, dict) else None
    first = choices[0] if isinstance(choices, list) and choices else None
    message = first.get("message") if isinstance(first, dict) else None
    content = message.get("content") if isinstance(message, dict) else None
    return content.strip() if isinstance(content, str) else ""


def strip_code_fences(text: str) -> str:
    """The JSON inside a ```json fenced block, or the text unchanged when it is not fenced."""
    fenced = FENCED_REPLY.match(text)
    return fenced.group(1) if fenced else text
