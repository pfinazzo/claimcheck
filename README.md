# claimcheck

@author Patrick Finazzo

A verification ledger for AI-written diffs. It sits between any coding agent and git
and makes every change carry three things it cannot carry today:

1. **Acceptance criteria frozen before the code existed.** A hashed lock file that the
   checker refuses to accept late additions to.
2. **Claims a fresh model checks blind.** Each diff ships a `claims.yaml` with a claim,
   a confidence, an observable that would prove it wrong, and what verified it. A
   separate model sees only the frozen criteria, the diff, and the claims with the
   author's confidence and evidence stripped out.
3. **A planted-bug catch rate on the changed lines only.** Sign flips, off-by-ones,
   swapped arguments and boundary shifts are injected one at a time into the added
   lines; the project's own tests are rerun; the fraction caught is reported beside
   the confidence.

Every run appends one line per claim to an append-only JSONL ledger. v2 will harvest
outcomes into that ledger and draw the calibration curve. v1 makes sure the data exists.

## Install

Python 3.11 or newer.

```bash
pip install -e ".[dev]"
```

Add the Claude checker (the official `anthropic` SDK; credentials come from
`ANTHROPIC_API_KEY` or an `ant auth login` profile, never from a file claimcheck reads):

```bash
pip install -e ".[claude]"
```

## Commands

```
claimcheck init                   # .claimcheck/ with config, spec template, empty claims + ledger; installs the pre-commit hook
claimcheck spec freeze            # hash the acceptance criteria into spec.lock
claimcheck spec verify            # refuse if the spec drifted from the lock
claimcheck claims validate [path] # schema-check a claims file against the frozen criteria
claimcheck check                  # independent model verdict per claim   (--provider claude|stub, --model, --base, --worktree)
claimcheck mutate                 # catch rate on the changed lines        (--test-cmd, --max-mutants, --seed, --restore)
claimcheck run                    # all of the above, then append to the ledger
claimcheck hook pre-commit        # what the installed git hook runs
```

`check`, `mutate` and `run` print one JSON document to stdout and also save it under
`.claimcheck/runs/`. Messages for people go to stderr.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | ok |
| 2 | a claim was REFUTED, or the catch rate is under `min_catch_rate` |
| 3 | spec refusal: drifted from the lock, re-frozen inside an open diff, or dirty while a diff is open |
| 4 | claims file invalid, or the pre-commit hook rejected the commit |
| 5 | provider error, unknown provider, or the baseline tests fail |
| 6 | a previous `mutate` left its sentinel; run `claimcheck mutate --restore` |

## The files

- `.claimcheck/spec.md` holds criteria as `- [ ] 1. text` lines; `spec.lock` is their hashes.
- `.claimcheck/claims.yaml` is one entry per claim. See `examples/claims.yaml` for the shape.
- `.claimcheck/ledger.jsonl` is append-only. See `examples/ledger.jsonl` for both line types.
- `.claimcheck/config.toml` sets the base ref, the test command, ignore globs, the checker
  provider and model, and the mutation limits. See `examples/config.toml`.

## Things to know

- Mutations are text-level and language-agnostic. Now and then a mutant will not compile.
  That counts as **killed**, because the test command fails, which is the honest reading:
  a change the tests notice is a change the tests notice.
- The checker never sees the author's `confidence` or `verified_by`. That is the point.
- The hook refuses a commit that touches code without a staged, valid `claims.yaml` that
  covers every staged path, deletions included.
- claimcheck never runs `git stash`, `reset` or `checkout`, and never reads `.env`.

## Desktop app

`app/` holds claimcheck Desk, an Electron board over the ledger with a Fix flow. See
`app/README.md`.
