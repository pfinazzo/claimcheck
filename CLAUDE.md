# claimcheck

A Python command line in `src/claimcheck` and an Electron app, Desk, in `app/`. Both are strict about types and tested.

- Command line tests: `python -m pytest -q` from the activated `.venv` (about 100 seconds).
- Desk: `cd app && npm test` (type checks, builds, then runs the tests).
- claimcheck's own setup here covers the Python side. Desk has its own suite and is not mutated by `claimcheck run`.
- Never run `claimcheck init` or a mutation run on a dirty tree you care about: a mutation run edits files while it works and restores them after.

<!-- claimcheck:begin (managed by `claimcheck init`; edits inside this block are overwritten) -->
## claimcheck

This repo uses claimcheck. Every change carries frozen acceptance criteria and a list of claims
about the diff, and an independent checker and a planted-bug test run grade them.

Before writing code for a task:
1. Run `claimcheck spec verify`. If `.claimcheck/spec.lock` is missing or does not match
   `.claimcheck/spec.md`, stop and ask the human. Do not edit `spec.md` or `spec.lock` yourself.
   If the human has no spec yet, run `claimcheck spec draft` and let them answer its questions.

With every commit that changes code:
2. Update `.claimcheck/claims.yaml`. One claim per thing you assert about the diff.
3. Give each claim a confidence between 0 and 1 that reflects how sure you actually are.
   Do not round up. Low confidence is useful information.
4. Give each claim a `kill_condition` that would prove it wrong: `test:`, `cmd:` or `obs:`.
   It must be something other than the claim restated.
5. List every changed code file in some claim's `files`, and cite criteria by number.

Before finishing:
6. Run `claimcheck run`. Report any claim that is REFUTED or has a low catch rate. Fix the tests
   or narrow the claim. Never edit the checker, the ledger or the config to make a run pass.
<!-- claimcheck:end -->
