# claimcheck

@author Patrick Finazzo

**A verification ledger for AI-written code.** Every change an AI agent makes arrives with a list of claims about itself ("this handles negatives", "the boundary is inclusive"). claimcheck checks those claims three independent ways, records the result in an append-only ledger, and shows you which claims are backed and which ones are only confident.

![Desk board: one claim stated at 0.92 confidence, only half of the planted bugs caught](docs/screenshots/board-weak.png)

*The claim sounds sure (0.92) and the independent check agrees, but the tests only caught 2 of 4 deliberately planted bugs. claimcheck puts it in the decision queue.*

## Contents

- [Why this exists](#why-this-exists)
- [How it works](#how-it-works)
- [Quickstart](#quickstart)
- [Walkthrough: the weak-test catch](#walkthrough-the-weak-test-catch)
- [Using it on a team](#using-it-on-a-team)
- [The Desk app](#the-desk-app)
- [Writing good claims](#writing-good-claims)
- [Reference](#reference)
- [Troubleshooting](#troubleshooting)
- [Limits, stated plainly](#limits-stated-plainly)
- [Development](#development)

## Why this exists

A coding agent will happily tell you its change is correct. It will say so with the same tone when it is right and when it is wrong, and the passing test suite it points to may not test the thing it changed. Reviewing the diff by hand does not scale to the volume agents produce.

claimcheck adds three things to every diff that it does not carry today:

1. **Criteria that were fixed before the code existed.** Acceptance criteria are hashed into a lock file. Anything added or edited after the work starts is refused, so nobody can quietly move the goalposts to fit the code.
2. **A second opinion that cannot see the author's confidence.** A separate model reads only the frozen criteria, the diff and the bare claims. It never sees how sure the author was or what evidence the author cited.
3. **A planted-bug catch rate.** claimcheck breaks the new code on purpose, one small change at a time (a flipped sign, an off-by-one, swapped arguments, a shifted boundary), and reruns your tests. The share of broken versions the tests notice is printed next to the confidence the author stated.

Every run appends one line per claim to a ledger. The ledger is the product: over time it is the record of how much to trust each author, human or AI.

## How it works

```
 spec.md ──freeze──▶ spec.lock          (criteria, hashed, before any code)
                         │
 agent writes code ──▶ claims.yaml      (claim + confidence + what would prove it wrong)
                         │
       claimcheck run ───┼──▶ checker      blind verdict per claim: SUPPORTED / REFUTED / UNVERIFIABLE
                         └──▶ mutate       plant bugs in the added lines, rerun the tests, count catches
                                │
                                ▼
                         ledger.jsonl      one line per claim, append-only
                                │
                                ▼
                         Desk board        decision queue of claims that need a human
```

| Check | What it answers | Needs |
| --- | --- | --- |
| Spec lock | Did the goalposts move after the work started? | Nothing |
| Pre-commit hook | Does every changed file have a claim covering it? | Nothing |
| Blind checker | Does the diff actually support what the author said? | A Claude credential, or the offline stub |
| Planted bugs | Would your tests notice if this code were wrong? | Your own test command |

## Quickstart

You need Python 3.11 or newer and a git repository. The commands below are for the repo you want to protect, not for this one.

### 1. Install

claimcheck is not on PyPI yet. Clone it and install it into the environment your project uses:

```bash
git clone https://github.com/pfinazzo/claimcheck.git
pip install -e "./claimcheck[claude]"
```

Drop `[claude]` if you only want the offline stub. The Claude checker reads `ANTHROPIC_API_KEY` from your environment, or an `ant auth login` profile. claimcheck never reads a `.env` file.

### 2. Set it up in your repo

From the root of the repo you want to protect:

```bash
claimcheck init
```

This creates `.claimcheck/` with a config, a spec template, an empty claims file and an empty ledger, and installs a git pre-commit hook. It prints what it created:

```
claimcheck: init: created ['config.toml', 'spec.md', 'claims.yaml', 'ledger.jsonl']; hook installed
```

`init` is safe to run twice. It never overwrites a file that exists, and it adds the hook line only once. It does not look at your project, so two settings are yours to fix by hand:

- **`test_cmd`** in `.claimcheck/config.toml` defaults to `python -m pytest -q`. Change it to your own command (`npm test`, `go test ./...`, `cargo test`).
- **`ignore`** in the same file lists paths that are not product code. Add `.gitignore` and your test folder here (see [Keep tests out of the mutation pool](#keep-tests-out-of-the-mutation-pool)). Without `.gitignore` on the list, the hook will ask for a claim covering your next `.gitignore` edit.

Then add these lines to your `.gitignore`. They are scratch output, not history. Commit the `.gitignore` change together with the freeze commit in step 3:

```
.claimcheck/runs/
.claimcheck/mutate-backup/
.claimcheck/mutate.lock
.claimcheck/worktrees/
.claimcheck/app-state.json
```

### 3. Write the criteria and freeze them

Edit `.claimcheck/spec.md`. Each criterion is one line in this exact shape, numbered from 1 with no gaps:

```markdown
# Acceptance criteria

- [ ] 1. An order of exactly $50 ships free.
- [ ] 2. An order under $50 pays a $5 shipping fee.
- [ ] 3. An order over $50 ships free.
```

Write criteria a test could check. Then freeze them and commit the spec and the lock as their own commit, **before any code**:

```bash
claimcheck spec freeze
git add .claimcheck .gitignore && git commit -m "Freeze criteria for free shipping"
```

That first commit touches only `.claimcheck/` and `.gitignore`, both on the ignore list, so the hook lets it through.

### 4. Write the code, then the claims

Have your agent (or you) make the change. Alongside it, fill in `.claimcheck/claims.yaml`:

```yaml
version: 1
author: "claude-code"
base: "main"
claims:
  - id: c1
    claim: "shipping_fee returns 0 for orders of $50 or more and 5 for anything under"
    confidence: 0.92
    criteria: [1, 2, 3]
    files: ["src/shipping.py"]
    kill_condition: "test: tests/test_shipping.py::test_big_order_ships_free"
    verified_by:
      - "cmd: python -m pytest -q"
```

Check it against the frozen criteria:

```bash
claimcheck claims validate
# claimcheck: claims validate: 1 claims ok
```

Commit the code and `claims.yaml` together. The hook checks that the claims file is staged and that every changed code file is covered.

### 5. Run it

```bash
claimcheck run --base main
```

`run` does everything in order: verify the spec lock, validate the claims, ask the checker for a verdict on each claim, plant bugs and rerun your tests, then append to the ledger. It prints one JSON document and also saves it under `.claimcheck/runs/`. The exit code tells a script what happened (see [Exit codes](#exit-codes)).

No Claude credential yet? Try the offline stub first. It returns `UNVERIFIABLE` for every claim, so you only see the planted-bug half:

```bash
claimcheck run --provider stub --base main
```

### 6. Look at it

```bash
cd claimcheck/app
npm install
npm start
```

Press **Open repo** and pick your project. See [The Desk app](#the-desk-app).

## Walkthrough: the weak-test catch

This is a real run on a small demo project. The change adds free shipping for orders of $50 or more:

```python
def shipping_fee(total):
    """Orders of $50 or more ship free; everything else costs $5."""
    if total >= 50:
        return 0
    return 5
```

The author's tests cover a big order and a small order and nothing near the boundary:

```python
def test_big_order_ships_free():
    assert shipping_fee(120) == 0

def test_small_order_pays():
    assert shipping_fee(10) == 5
```

The tests pass. The author claims 0.92 confidence. Here is what `claimcheck run` found when it planted four bugs in `src/shipping.py`:

| Outcome | Planted bug | Real bug? |
| --- | --- | --- |
| survived | `if total >= 50:` became `if total >= 51:` | Yes, $50 would now pay shipping |
| survived | `if total >= 50:` became `if total > 50:` | Yes, $50 would now pay shipping |
| killed | `return 0` became `return 1` | Caught |
| killed | `return 5` became `return 6` | Caught |

The catch rate is 50%. Two real boundary bugs would have shipped with a green test run. This is the board you saw at the top: the claim is confident and "supported" by the checker, but flagged **weak-tests** and sent to the decision queue.

The fix is to pin the boundary:

```python
def test_exactly_fifty_ships_free():
    assert shipping_fee(50) == 0

def test_just_under_fifty_pays():
    assert shipping_fee(49.99) == 5

def test_just_over_fifty_ships_free():
    assert shipping_fee(50.01) == 0
```

Same bugs, rerun: all four are killed, catch rate 100%, and the queue empties.

![Desk board after the fix: nothing needs a decision, 100% caught](docs/screenshots/board-strong.png)

*Both screenshots come from the offline stand-in for the checker, so the "supported" verdict was scripted for the demo. The planted-bug numbers are real runs.*

### What a ledger line looks like

Each run writes one JSON line per claim. This is the second run, trimmed:

```json
{
  "claim_id": "c1",
  "confidence": 0.95,
  "checker": {
    "provider": "stub",
    "verdict": "SUPPORTED",
    "reason": "The comparison is >= 50 returning 0, else 5, which matches criteria 1 to 3 by inspection.",
    "evidence": ["+    if total >= 50:", "+        return 0", "+    return 5"]
  },
  "mutation": { "catch_rate": 1.0, "killed": 4, "survived": 0, "timeout": 0, "total": 4 },
  "outcome": null
}
```

`outcome` stays `null` until something happens in the real world, such as a later bug fix that touches the same lines. The Desk app writes that line when you resolve a claim. A later version will use outcomes to draw a calibration curve: when this author says 0.9, how often are they right?

### What the guardrails look like

If someone adds a criterion after the lock:

```
claimcheck: spec drifted from lock:
  late addition: [4]
```

(exit code 3.) If someone commits code without updating the claims:

```
claimcheck: staged code paths ['src/shipping.py'] but .claimcheck/claims.yaml is not staged (added or modified)
```

(the commit is rejected.)

## Using it on a team

### Who does what

| Role | Does | Owns |
| --- | --- | --- |
| **Requester** (human) | Writes the criteria and freezes them before work starts | `spec.md`, `spec.lock` |
| **Author** (agent or human) | Writes the code and the claims, with honest confidence | `claims.yaml`, the diff |
| **CI** | Runs `claimcheck run` on every pull request | The ledger line |
| **Reviewer** (human) | Reads the board, not the whole diff. Starts with the decision queue | The merge decision |

The point of the split is that the author never grades their own work. The criteria are fixed by someone else, the verdict comes from a model that cannot see the author's confidence, and the catch rate comes from your own tests.

### The per-change workflow

1. **Branch.** Cut a branch from `main`.
2. **Freeze.** The requester writes `.claimcheck/spec.md` and runs `claimcheck spec freeze`. Commit the spec and lock first, alone.
3. **Build.** The author makes the change. Commits that touch code must include an updated `claims.yaml`.
4. **Check locally.** `claimcheck run --base main` before pushing. Fix anything in the decision queue.
5. **Open the pull request.** The CI run appends the ledger line. The reviewer opens Desk on the branch, or reads the summary below.
6. **Merge.** Commit `ledger.jsonl` with the merge so the history travels with the code.

If a criterion was wrong, that is a new change: start a new branch, write a new spec, freeze again. claimcheck refuses to re-freeze while a diff is open, on purpose.

### What to commit and what to ignore

| Commit | Ignore |
| --- | --- |
| `.claimcheck/spec.md` | `.claimcheck/runs/` |
| `.claimcheck/spec.lock` | `.claimcheck/mutate-backup/` |
| `.claimcheck/claims.yaml` | `.claimcheck/mutate.lock` |
| `.claimcheck/config.toml` | `.claimcheck/worktrees/` |
| `.claimcheck/ledger.jsonl` | `.claimcheck/app-state.json` |

The lock must be in git. The late-criteria check compares the lock's freeze time with the date of the branch's first commit.

### Telling your coding agent

Agents follow written rules. Put this in `CLAUDE.md`, `AGENTS.md` or whatever your agent reads:

```markdown
## claimcheck

Before writing code for a task:
1. Confirm `.claimcheck/spec.lock` exists and matches `.claimcheck/spec.md` (`claimcheck spec verify`).
   Do not edit `spec.md` or `spec.lock`. If a criterion is wrong, stop and ask.

With every commit that changes code:
2. Update `.claimcheck/claims.yaml`. One claim per thing you assert about the diff.
3. Give each claim a confidence between 0 and 1 that reflects how sure you actually are.
   Do not round up. Low confidence is useful information.
4. Give each claim a `kill_condition`: a test, command or observation that would prove the claim wrong.
   It must be something other than the claim restated.
5. List every changed code file in some claim's `files`.

Before finishing:
6. Run `claimcheck run --base main` and report any claim that is REFUTED or has a low catch rate.
   Fix the tests or narrow the claim. Do not edit the checker, the ledger or the config to make it pass.
```

### Running it in CI

`claimcheck run` is a plain command that prints JSON and sets an exit code, so any CI can run it. This GitHub Actions sketch shows the shape. It has not been run in a real pipeline yet, so treat it as a starting point:

```yaml
name: claimcheck
on: pull_request

jobs:
  claimcheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0              # the diff needs history back to the base branch
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
      - run: pip install "git+https://github.com/pfinazzo/claimcheck.git#egg=claimcheck[claude]"
      # install your project's own dependencies and test tools here
      - run: claimcheck run --base origin/${{ github.base_ref }}
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

Notes for CI:

- While this repository is private, `pip install` from GitHub needs a token, or install from a vendored copy.
- The run changes files in the checkout while it plants bugs, then restores them. Use a throwaway checkout, which CI already is.
- `ANTHROPIC_API_KEY` belongs in your CI secret store. It is never written to a file by claimcheck.
- The run installs your test dependencies too, because it reruns your tests once per planted bug.

### Turning it into a gate

By default `mutate` only reports. To make a weak catch rate fail the build, raise `min_catch_rate` in `.claimcheck/config.toml`:

```toml
[mutate]
min_catch_rate = 0.7     # exit code 2 if fewer than 70% of planted bugs are caught
```

A sensible rollout:

1. **Weeks 1 to 2: report only.** Leave it at 0.0. Look at the board and learn what your catch rates are.
2. **Then gate the new code.** Set a floor a bit under your median (for example 0.6).
3. **Raise it as tests improve.** A REFUTED verdict already fails the run with exit code 2, no config needed.

### Reviewing a pull request

The reviewer does not read a pile of diffs. They open Desk on the branch:

1. **Decision queue first.** Each card says why it is there: `weak-tests`, `refuted`, `unverified`, `low-confidence`.
2. **Sure but unproven corner.** The scatter plot puts high stated confidence with a low catch rate in the lower right. Anything there deserves a look.
3. **Accept, fix or narrow.** Press **Fix this** for a set of options, or **Accept risk** with a one-line reason. The reason lands in the ledger.

If you prefer the terminal, `jq` over `.claimcheck/ledger.jsonl` answers the same questions:

```bash
# claims with confidence over 0.8 that planted bugs got past
jq -c 'select(.type=="claim" and .confidence>0.8 and .mutation.catch_rate!=null and .mutation.catch_rate<0.7)
       | {claim_id, confidence, catch: .mutation.catch_rate}' .claimcheck/ledger.jsonl
```

### Keep tests out of the mutation pool

By default claimcheck plants bugs in every added line that is not on the `ignore` list, including your test files. A planted bug inside a test assertion mostly produces a "survivor" that says nothing about your product code, and it drags the catch rate down.

Add your test folder to `ignore`:

```toml
ignore = ["*.md", "docs/**", ".claimcheck/**", "*.lock", "*.txt", ".gitignore", "tests/**"]
```

Two side effects, both intended. The hook stops requiring a claim for test files, and claims should list only product code in `files`. The checker still sees your tests in the diff, which helps it judge whether a claim is backed.

## The Desk app

Desk is an Electron app that reads a repo's `.claimcheck/ledger.jsonl` and shows it as a board. It lives in [`app/`](app/). Full details are in [`app/README.md`](app/README.md).

```bash
cd app
npm install
npm start
```

Node 20 or newer. The first install downloads Electron. Use **Open repo** to pick a project that has a `.claimcheck/` folder. The board refreshes as the ledger changes.

![Desk board showing a refuted claim with its reasons and the Fix this panel](docs/screenshots/board-refuted.png)

*A claim the independent check refuted (the tests never call the function at the boundary), with the reasons and the Fix this panel on the right. Verdicts in this screenshot are from the offline stub.*

What you are looking at:

| Area | Meaning |
| --- | --- |
| **Decision queue** (left) | Claims that need a human, highest risk first. Each card shows the verdict, catch rate and why it was flagged |
| **Backed or settled** (left) | Claims that are supported with a good catch rate, resolved, or accepted |
| **Tiles** (top) | Claim count, how many need a decision, how many refuted, mean stated confidence, overall catch rate |
| **Confidence vs bugs caught** (middle) | One dot per claim. Drag to pan, wheel to zoom, double-click to reset. The shaded lower-right corner is "sure but unproven" |
| **Detail panel** (right) | The claim, its criteria, the independent verdict with evidence lines, and every planted bug with whether it survived |

### The fix flow

From any flagged claim, press **Fix this**:

1. **Propose.** Claude reads the code and proposes three to four genuinely different approaches: fix the code, tighten the tests, narrow the claim, or replace a kill condition that was not a real observable. Each has pros, cons, effort and the files it touches.
2. **Use this approach.** Desk creates a branch named `claimcheck/fix-<claim>-<id>` in a separate git worktree. Claude writes a failing test first, then the fix, then commits. It cannot push.
3. **Verify.** Desk runs your test command in the worktree, then the claim's kill condition when it is a command or a test id.
4. **Resolve.** On green the card moves to the settled column and an outcome line goes in the ledger. If the GitHub CLI is signed in, **Open pull request** lights up. On red the output stays on screen and the worktree is kept.

**Copy prompt** gives you the same request as text for any fresh Claude Code session. **Accept risk** takes a one-line reason and moves the claim out of the queue.

Desk connects to Claude one of two ways, chosen under **Connect Claude**: through your own Claude Code sign-in, or with an API key that is stored encrypted by your operating system and never shown again. API-key mode can propose fixes but cannot edit your repo.

Desk never pushes, merges, or reads `.env` files. It writes only `.claimcheck/app-state.json`, `.claimcheck/worktrees/` and outcome lines on the ledger.

## Writing good claims

The checker and the catch rate are only as good as the claims. A claim is one sentence about the diff that could turn out false.

**Do:**

- Make each claim one checkable statement. "`shipping_fee` returns 0 at exactly $50" is a claim. "The shipping feature works" is not.
- Cite the criteria it supports by number in `criteria`.
- List every file the claim is about in `files`.
- Put your real confidence. If you did not run the code, say 0.6, not 0.95.
- Write a `kill_condition` that names something outside the claim: a specific test, a command whose failure disproves it, or an observable value.

**Kill condition forms.** The text must start with one of three prefixes:

| Prefix | Example |
| --- | --- |
| `test:` | `test: tests/test_shipping.py::test_exactly_fifty_ships_free` |
| `cmd:` | `cmd: python -m pytest -q --cov=src --cov-fail-under=100` |
| `obs:` | `obs: shipping_fee(50) returns 0 and shipping_fee(49.99) returns 5; any other value breaks this claim` |

A kill condition that merely repeats the claim text is rejected.

**What the validator rejects** (all of these exit with code 4):

- an `id` that is not lowercase letters, digits, `-` or `_`, or that repeats
- empty claim text, or a confidence outside 0 to 1
- a missing or unknown `kill_condition` prefix
- an empty `verified_by` list
- empty `files`
- `criteria` that cite an id not in the frozen lock

**What the pre-commit hook enforces:**

- A commit that changes code must also stage `.claimcheck/claims.yaml`.
- Every file named in a claim must be in that same commit.
- Every changed code file must be named by some claim (unless `require_full_coverage = false`, which only warns).
- Deleted files count as changed.

## Reference

### Commands

```
claimcheck init                    create .claimcheck/ and install the pre-commit hook
claimcheck spec freeze             hash the criteria into spec.lock
claimcheck spec verify             refuse if the spec drifted from the lock
claimcheck claims validate [path]  schema-check a claims file against the frozen criteria
claimcheck check                   independent verdict per claim
claimcheck mutate                  planted-bug catch rate on the changed lines
claimcheck run                     verify, validate, check, mutate, then append to the ledger
claimcheck hook pre-commit         what the installed git hook runs
```

Options shared by `check`, `mutate` and `run`:

| Option | Meaning |
| --- | --- |
| `--base REF` | The git ref the diff is measured against. Defaults to `base` in config |
| `--worktree` | Measure uncommitted changes in the working tree instead of `base...HEAD` |
| `--provider claude\|stub` | Which checker (`check` and `run`). The stub is offline and deterministic |
| `--model NAME` | Checker model (`check` and `run`) |
| `--test-cmd CMD` | Override the test command (`mutate` and `run`) |
| `--max-mutants N` | Cap the number of planted bugs (`mutate` and `run`) |
| `--seed N` | Make the sample of planted bugs repeatable |
| `--restore` | After a crashed `mutate`, put the backed-up files back |

`check`, `mutate` and `run` print one JSON document to stdout and save it under `.claimcheck/runs/`. Messages for people go to stderr, so `claimcheck run > result.json` stays clean.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | ok |
| 2 | a claim was REFUTED, or the catch rate is under `min_catch_rate` |
| 3 | spec refusal: drifted from the lock, re-frozen inside an open diff, or dirty while a diff is open |
| 4 | claims file invalid, or the pre-commit hook rejected the commit |
| 5 | provider error, unknown provider, or the baseline tests fail |
| 6 | a previous `mutate` left its lock behind; run `claimcheck mutate --restore` |

### Files

| File | Purpose |
| --- | --- |
| `.claimcheck/spec.md` | Acceptance criteria as `- [ ] 1. text` lines |
| `.claimcheck/spec.lock` | JSON with a hash per criterion and the freeze time. Edit it and the checks fail |
| `.claimcheck/claims.yaml` | One entry per claim. See [`examples/claims.yaml`](examples/claims.yaml) |
| `.claimcheck/ledger.jsonl` | Append-only. A `claim` line per claim per run, and an `outcome` line when something resolves it. See [`examples/ledger.jsonl`](examples/ledger.jsonl) |
| `.claimcheck/config.toml` | Settings. See [`examples/config.toml`](examples/config.toml) |

### Config

```toml
version = 1
base = "main"                       # the ref diffs are measured against
test_cmd = "python -m pytest -q"    # reran once per planted bug
ignore = ["*.md", "docs/**", ".claimcheck/**", "*.lock", "*.txt"]   # not product code
require_full_coverage = true        # hook rejects uncovered code files (false = warn)

[checker]
provider = "claude"                 # "claude" or "stub"
model = "claude-opus-5-5"

[mutate]
max_mutants = 50
timeout_s = 600                     # per test run
min_catch_rate = 0.0                # 0.0 reports only; raise it to gate
```

### The four kinds of planted bug

Mutations are text-level and language-agnostic. They apply only to lines the diff adds, and never inside string literals.

| Kind | Example |
| --- | --- |
| Sign flip | `a + b` becomes `a - b`, and a unary minus is dropped |
| Off by one | `50` becomes `51` |
| Swapped arguments | `f(a, b)` becomes `f(b, a)` |
| Boundary shift | `>=` becomes `>`, and `<` becomes `<=` |

Because the mutations are text edits, now and then a mutant will not compile. That counts as **killed**, since the test command fails. A change the tests notice is a change the tests notice.

## Troubleshooting

**`claimcheck: .claimcheck/mutate.lock exists: a previous mutate run did not finish`**
A run was interrupted while it had your files modified. First check `git status` to see the state of your files, then run `claimcheck mutate --restore`. It copies the backed-up originals back and removes the lock.

**The commit is rejected with "staged paths with no claim covering them"**
A changed file is not listed in any claim's `files`. Add it to a claim, add it to `ignore` if it is not product code, or set `require_full_coverage = false` to turn the error into a warning.

**The commit is rejected with "files not in the staged diff"**
A claim lists a file that is not in this commit. Claims describe one commit's diff. Remove the file from the claim or stage it.

**`spec drifted from lock` (exit 3)**
`spec.md` no longer matches `spec.lock`. If you did not mean to change it, `git checkout .claimcheck/spec.md`. If the criterion really was wrong, finish or abandon the open diff, then start a new branch and freeze again.

**`refusing to re-freeze with an open diff`**
Once a lock exists, freezing again is only allowed on a clean tree with no commits ahead of the base ref. This is the rule that stops late criteria.

**The baseline tests fail (exit 5)**
claimcheck runs your tests once before planting any bugs. If they do not pass on the unmodified code there is nothing to measure. Fix the tests first.

**A planted bug survived but is not really a bug**
Some text changes do not change behavior. In a `clamp` function, `if x < lo` and `if x <= lo` return the same value at the boundary, so no test can tell them apart. This is the known blind spot of mutation testing. Read the survivor list in Desk, judge each one, and use **Accept risk** with a reason for the harmless ones.

**The hook uses the wrong Python**
`init` writes the path of the Python that ran it into `.git/hooks/pre-commit`. If you later recreate the virtual environment, run `claimcheck init` again from the new one, or edit that line.

**Windows**
Git Bash and PowerShell both work. The hook is a `sh` script, which Git for Windows runs itself. Line-ending warnings from git are harmless.

## Limits, stated plainly

- **The checker only sees the diff.** The `.claimcheck/` folder is removed from it, so the checker never sees your confidence, your evidence or earlier ledger lines. It cannot run your code. A claim that depends on runtime behavior, other files or data comes back `UNVERIFIABLE`, which is honest but not a pass.
- **The catch rate measures your tests, not your code.** A high rate means your tests would notice small breakages in the lines you added. It does not mean the code is right.
- **Four kinds of planted bug.** Real bugs are more varied. The rate is a floor for how responsive your tests are, not a full audit.
- **Equivalent mutants exist.** Some planted bugs do not change behavior and will always survive. Judge survivors, do not just count them.
- **Only added lines are mutated.** Bugs in untouched code that the change relies on are out of scope.
- **Confidence is not calibrated yet.** Version 1 makes sure the data exists. The calibration curve (how often a given stated confidence turns out right) comes once the ledger has real outcomes in it.
- **The criteria are only as good as the person who wrote them.** claimcheck proves the code matches the frozen spec and that the spec was not bent afterward. It cannot tell you the spec was the right one.
- **`init` does not detect your stack.** You set `test_cmd` and `ignore` yourself.

## Development

Python:

```bash
python -m venv .venv
.venv/Scripts/activate          # on macOS and Linux: source .venv/bin/activate
pip install -e ".[dev,claude]"
pytest                          # 102 tests
```

Desk:

```bash
cd app
npm install
npm test                        # 54 tests
npm run screenshot -- <repo> board.png    # render the board headless to a PNG
```

The screenshots in this README were made with that last command.

```
src/claimcheck/   the CLI: spec, claims, checker, mutate, ledger, hook, providers
tests/            Python tests
app/              the Desk Electron app
examples/         a sample spec, claims file, config and ledger
docs/screenshots/ images used in this README
```

## License

MIT. See [LICENSE](LICENSE).
