# Acceptance criteria

Goal: Make the claude-cli checker blind to the repo it checks. Today `_run_claude` in src/claimcheck/providers/claude_cli.py starts `claude -p` in the folder named by the TEMP environment variable. On macOS and Linux TEMP is normally unset, so `claude -p` starts in the repo. It then reads the repo's CLAUDE.md and the gitignored CLAUDE.local.md, and runs the hooks in the repo's .claude settings. Text the AI author controls can steer the verdict without appearing in the diff. The same provider serves spec draft, so Desk's "Write a spec" can still run a repo's hooks this way. Change it so every `claude -p` call starts in a fresh, empty folder made for that call and removed after it, on every platform. Pass --safe-mode, so the person's own CLAUDE.md, hooks, skills and plugins do not load either, while sign-in still works. Replace the 10-name --disallowedTools list with --tools "", which turns off every tool. Everything else stays as it is: the prompt on stdin, redaction, --json-schema, timeouts, and the error messages. The API, openai and stub providers do not change.

- [ ] 1. Every `claude -p` call from the claude-cli provider starts with its working directory set to a newly created, empty folder that is not inside the repo.
  - Check: Fake `claude` records its cwd: the cwd exists, is empty at start, and is not the repo or a parent or child of it.
- [ ] 2. The working folder is unique per call, so two calls never share one.
  - Check: Make two calls with a fake `claude`; the recorded cwd paths differ.
- [ ] 3. The working folder is removed after the call returns normally.
  - Check: After a successful call, the recorded cwd path no longer exists.
- [ ] 4. The working folder is removed after a non-zero exit, a timeout, and an exception during the call.
  - Check: Fake `claude` exits non-zero, sleeps past the timeout, and (via a forced error) raises; in each case the recorded cwd path no longer exists.
- [ ] 5. The folder choice does not depend on the TEMP environment variable, on macOS, Linux and Windows.
  - Check: Run with TEMP unset and with TEMP set to the repo path; cwd is still a fresh empty folder, not the repo.
- [ ] 6. If the empty folder cannot be created, the call raises a ProviderError saying the empty folder could not be made, with the reason, and never runs `claude` in the repo or TEMP.
  - Check: Make folder creation fail (for example an unwritable temp dir); expect ProviderError with that message and the fake `claude` never started.
- [ ] 7. The `claude` command line includes `--safe-mode`.
  - Check: Fake `claude` records argv and it contains `--safe-mode`.
- [ ] 8. The `claude` command line includes `--tools` followed by an empty string, and no `--disallowedTools` flag.
  - Check: Recorded argv has `--tools` then `""`, and has no `--disallowedTools`.
- [ ] 9. A repo CLAUDE.md, CLAUDE.local.md and .claude settings hook have no effect on the call.
  - Check: Put a hook and a CLAUDE.local.md marker in a temp repo and run from it; the fake's cwd is outside the repo and the hook marker file is never created.
- [ ] 10. If claude's error output says an option is unknown, the ProviderError tells the person to update Claude Code.
  - Check: Fake `claude` exits non-zero printing 'unknown option --safe-mode'; the ProviderError message contains an instruction to update Claude Code.
- [ ] 11. If `claude` cannot be started, the existing 'claude CLI could not be started' error is still raised.
  - Check: Point the provider at a missing binary; the error text matches the current message.
- [ ] 12. The prompt still goes in on stdin, redaction is still applied, and --json-schema, timeouts and other error messages are unchanged.
  - Check: Existing claude_cli tests pass unchanged, except those asserting the old --disallowedTools flag or TEMP cwd.
- [ ] 13. The API, openai and stub providers and Desk's app/src/lib/claude-cli.ts behave exactly as before.
  - Check: Their existing tests pass and the diff touches none of those files.

## Out of scope

- Changes to the claude (API), openai-compatible or stub providers
- Changes to Desk's app/src/lib/claude-cli.ts
- Changes to the checker prompt, verdict parsing or schema
- Scrubbing or changing environment variables of the child process
- A claude version check before each call
- Changing the ledger, config or hook behavior

<!-- drafted with `claimcheck spec draft`; frozen with `claimcheck spec freeze` -->
