# Acceptance criteria

Goal: Let claimcheck use a model provider other than Claude. Add an `openai` provider that talks to any OpenAI-compatible chat completions endpoint (OpenAI itself, or a local server such as Ollama), chosen the same way as the others: `--provider openai` or `[checker] provider = "openai"` in config.toml. The base URL, key and model come from OPENAI_BASE_URL, OPENAI_API_KEY (optional for local servers) and the configured or --model model, with OPENAI_MODEL as the fallback when no model is given. It uses the standard library only, no new dependency. It applies the same redaction as the other providers before anything leaves the process, and failures become a ProviderError that says what to fix. `auto` stays Claude-only, so Claude stays the default. The checker, the ledger and the mutation test are unchanged. README, the config comments and the CLI help list the new provider and how to set it up.

- [ ] 1. `--provider openai` selects the OpenAI-compatible provider for spec draft, check and run, and `[checker] provider = "openai"` selects it for check and run.
  - Check: Tests load the provider by name and run check through it against a local fake server.
- [ ] 2. The provider POSTs to <OPENAI_BASE_URL>/chat/completions; a trailing slash gives the same path, and an unset OPENAI_BASE_URL means https://api.openai.com/v1.
  - Check: Fake server records the path with and without a trailing slash; a unit test checks the default URL.
- [ ] 3. When OPENAI_API_KEY is set the request carries 'Authorization: Bearer <key>'; when it is unset no Authorization header is sent.
  - Check: Fake server records the headers in both cases.
- [ ] 4. The model is the one passed in (--model, else the config's [checker] model); when none is passed, OPENAI_MODEL is used.
  - Check: Fake server tests check body.model for a passed model and for OPENAI_MODEL alone.
- [ ] 5. With no model anywhere, a ProviderError naming --model, [checker] model and OPENAI_MODEL is raised before any network call.
  - Check: Test with all three unset: the error names all three and the fake server saw no request.
- [ ] 6. The body sends the system and user messages, response_format json_schema with the request's schema and strict false, and the schema appended to the user message as text.
  - Check: Fake server captures the body and checks each part.
- [ ] 7. The provider returns the reply's message content as text, with ```json fences stripped.
  - Check: Fake server replies with fenced JSON; the returned text is the bare JSON.
- [ ] 8. No secret from tests/fixtures/secret_cases.json reaches the server.
  - Check: Send the shared secret cases through the provider; none appear in the body the fake server received.
- [ ] 9. Each failure raises a ProviderError with a hint: unreachable server, timeout, 401 or 403, 404, 429, any other status, a body that is not JSON, and a reply with no message content.
  - Check: One fake-server test per case checks the ProviderError and its hint.
- [ ] 10. The provider makes exactly one HTTP request per call and never retries.
  - Check: Fake server answering 500 sees exactly one request.
- [ ] 11. The provider uses only the standard library, and pyproject.toml gains no dependency.
  - Check: Read the new module's imports and the pyproject diff.
- [ ] 12. `auto` still picks Claude even when OPENAI_BASE_URL, OPENAI_API_KEY and OPENAI_MODEL are set.
  - Check: Test: with the three variables set, load('auto') returns a Claude provider.
- [ ] 13. README, examples/config.toml, the config written by init, and the --provider help text each list `openai`.
  - Check: Test or grep each one for openai.
- [ ] 14. README explains OPENAI_BASE_URL, OPENAI_API_KEY and OPENAI_MODEL with an Ollama example.
  - Check: Read the README providers section.
- [ ] 15. checker.py, ledger.py and mutate.py are unchanged, and pytest, ruff and mypy pass.
  - Check: git diff of those files is empty; run the three commands.

## Out of scope

- Making auto pick OpenAI
- Streaming or tool calls
- Retries or backoff inside the provider
- Desk (app/) support for the new provider
- Other endpoint styles such as Gemini native or Anthropic-compatible
- Any change to the checker prompt, parsing, retry, ledger format or mutation test
- Telling local servers from remote ones
- A --model flag on spec draft

<!-- drafted with `claimcheck spec draft`; frozen with `claimcheck spec freeze` -->
