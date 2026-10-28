# Acceptance criteria

Goal: Close two ways Desk runs a repo's own code before the person has agreed to trust that repo. First: "Fix this" (propose) and the implement step start Claude Code inside the repo, and Claude Code then runs the hooks in the repo's .claude/settings.json and .claude/settings.local.json. Every Claude Code run Desk starts should pass --setting-sources user, so only the person's own settings load. Second: the spec wizard runs claimcheck through the Python named by [app] python in the repo's own .claimcheck/config.toml before the repo is trusted, and in API mode hands that program the API key. Desk should ignore [app] python until the person has trusted the repo's commands; the trust dialog already lists it. Every Python that Desk starts to run claimcheck also gets -P, so a file such as yaml.py in the repo cannot stand in for a library. The Python CLI does not change.

- [ ] 1. Every `claude -p` run Desk starts (propose, implement, connection test) gets --setting-sources user from the shared base arguments in claude-cli.ts.
  - Check: Test in app/test/claude-cli.test.ts: build args for propose, implement and connection test; assert each has "--setting-sources" immediately followed by "user".
- [ ] 2. Sign-in (`claude auth login`) is unchanged and does not get --setting-sources.
  - Check: Test: build the sign-in command line and assert it has no --setting-sources argument.
- [ ] 3. With --setting-sources user, hooks in the repo's .claude/settings.json or settings.local.json do not run during propose or implement.
  - Check: Manual probe: real claude in a repo whose hooks write marker files, API at a dead local port; markers absent with the flag, present without it.
- [ ] 4. If the repo is not trusted, the spec wizard ignores [app] python in the repo's .claimcheck/config.toml and never starts that program.
  - Check: Fixture repo whose [app] python writes a marker; run wizard untrusted; assert marker absent and the resolved program is not that script.
- [ ] 5. If the repo is not trusted, the wizard also ignores the repo's .venv when choosing a Python.
  - Check: Fixture repo with a .venv python that writes a marker; run wizard untrusted; assert marker absent and the resolved program is not under .venv.
- [ ] 6. If the repo is not trusted, the wizard picks claimcheck in this order: path saved in Connect or CLAIMCHECK_BIN, claimcheck on PATH, then a Python on PATH that has claimcheck.
  - Check: Unit test of the resolver with each source present in turn; assert the first available one in that order is chosen.
- [ ] 7. If the repo is not trusted and no claimcheck is found, the wizard shows the existing 'claimcheck not found' message and is not blocked otherwise.
  - Check: Resolver test with no claimcheck available; assert the existing message text is returned.
- [ ] 8. If the repo is not trusted and API mode is on, the API key reaches only a claimcheck found by the untrusted order, never a program named by the repo.
  - Check: Fixture repo with a recording [app] python script; run wizard untrusted in API mode; assert the script never ran and the key is absent from its args and env.
- [ ] 9. If the person has trusted the repo's commands, the wizard uses [app] python and the repo's virtualenv, as claimcheck run does, and may pass the API key to it.
  - Check: Mark fixture repo trusted in the per-repo trust record; run wizard; assert the configured Python was started.
- [ ] 10. The wizard reads the same per-repo trust record that claimcheck run uses, and that trust persists across Desk restarts.
  - Check: Trust a repo, reload the store from disk, resolve the wizard Python; assert it still uses [app] python.
- [ ] 11. Trust is read on every wizard call: trusting the repo while the wizard is open makes the very next call use [app] python.
  - Check: Test: resolve untrusted, then mark trusted without restarting, resolve again; assert the second result is [app] python.
- [ ] 12. If a trusted repo's [app] python is missing or broken, the person sees the start error naming that path, with no fallback to the untrusted order.
  - Check: Trusted fixture with a nonexistent [app] python; run wizard; assert an error naming that path and that no other Python was started.
- [ ] 13. Every `python -m claimcheck` Desk starts (runs, wizard calls, the `--version` probe) has -P before -m.
  - Check: Unit test each spawn site's resolved args; assert the list begins with -P then -m claimcheck.
- [ ] 14. A yaml.py in the working folder does not stand in for the yaml library when Desk runs claimcheck.
  - Check: Manual probe: in a folder with a marker-writing yaml.py, run `<python> -P -m claimcheck --version`; assert the marker is absent.
- [ ] 15. No file under src/claimcheck changes.
  - Check: git diff --stat shows no paths under src/claimcheck.

## Out of scope

- Any change to the Python CLI in src/claimcheck
- Changing the trust dialog's layout or wording
- Blocking or sandboxing other commands the repo defines
- Changing config.toml parsing beyond ignoring [app] python while untrusted
- Changing the sign-in flow (claude auth login)
- Blocking the wizard when the repo is untrusted
- Starting or changing any Python other than for claimcheck
- Falling back to the untrusted order when a trusted [app] python is broken

<!-- drafted with `claimcheck spec draft`; frozen with `claimcheck spec freeze` -->
