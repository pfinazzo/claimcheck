# Acceptance criteria

Task: `claimcheck run` must not pretend to verify an empty diff.

- [ ] 1. When the diff has no changes, `claimcheck run` exits with code 7 and prints a message on stderr that says the diff is empty and names two ways forward: commit the change, or pass `--worktree`.
- [ ] 2. In that case `run` makes no checker call, plants no bugs, and appends nothing to `.claimcheck/ledger.jsonl`.
- [ ] 3. `claimcheck check` and `claimcheck mutate` refuse an empty diff the same way, with exit code 7 and the same message.
- [ ] 4. When the diff has changes, `run`, `check` and `mutate` behave as before: with the stub provider a run on a non-empty diff still exits 0 and appends one ledger line per claim.
