# claimcheck

A Python CLI in `src/claimcheck` and Desk, an Electron app in TypeScript, in `app/`.

## Layout
- `src/claimcheck/`: the CLI (init, onboarding, spec conversation, checker, mutation, ledger, hook, redaction, providers).
- `tests/`: Python tests. `tests/fixtures/secret_cases.json` is shared with the Desk tests, so the two redaction filters can't drift.
- `app/`: Desk, with its own tests in `app/test/`.
- `examples/`: sample spec, claims, config and ledger, used as test fixtures.

## Commands
Python 3.11+. Desk needs Node 22 (`.nvmrc`, CI).

```bash
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev,claude]"
python -m pytest -q              # about 100 seconds
claimcheck verify-ledger         # CI runs this after the tests

cd app && npm ci
npm run typecheck                # both tsconfigs, zero errors
npm run build                    # main, preload and renderer into dist/
npm test                         # typecheck, build, then node --test
```

CI runs the Desk tests under `xvfb-run -a` with `ELECTRON_DISABLE_SANDBOX=1`, because one test opens a real Electron window.

## Repo rules
- Every Python file in `src/claimcheck`, plus `README.md` and `pyproject.toml`, keeps its `@author Patrick Finazzo` line. `test_ac30_attribution_everywhere` fails without it.
- Desk is TypeScript only, strict, no `any`. A test fails if hand-written JavaScript appears.
- TypeScript uses `type` aliases, not `interface`. The one exception is global declaration merging (`Window` in `globals.d.ts`).
- `claimcheck run` mutates only the Python side: `app/**` is in the config's `ignore`, and pytest doesn't run the Desk suite.
- Never run `claimcheck init` or a mutation run on a dirty tree you care about. A mutation run edits files while it works and restores them after.
- `.claimcheck/ledger.jsonl` is append-only and hash-chained. Never edit or remove a line; CI checks that it only grew.

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

# Conventions

Patrick's coding conventions, from [my-personal-coding-conventions](https://github.com/pfinazzo/my-personal-coding-conventions).

### Naming
- Code reads like English. If a line needs a comment to say what it does, rename until it doesn't.
- Name the full domain concept, after the thing's shape, not the flow it was built in.
- Verb prefixes promise side effects: `toX`, `buildX`, `calculateX` are pure; `isX`/`hasX`/`canX`/`shouldX` return booleans; `fetchX` reads over IO; `createX`/`updateX`/`saveX`/`deleteX` write; `handleX` responds to an event; `useX` is a hook.
- Booleans are positive questions. No abbreviations or filler nouns (`data`, `info`, `item`, `result`, `util`); `acc` in a reducer is the one exception.
- Collections are plural, lookups name their key (`ordersById`), units go in the name (`timeoutMs`, `totalCents`, `createdAtIso`).
- camelCase values and functions, PascalCase types and components, SCREAMING_CASE fixed constants and tables.

### Style
- Functional, not OOP: no classes, `this`, or instance state.
- Every function takes one object of named params.
- Lookup tables over if/else or switch ladders; defaults from `||` (or `??` when `0`/`""` are valid) on the same expression.
- Guard clauses and early returns; two indentation levels at most; one ternary level.
- Imports at the top, in order: built-ins, packages, own modules, relative paths; `import type` directly above that module's value import.
- File order: imports, fixed values, shared types, private helpers above their first caller, then exports.
- In TypeScript, docs don't restate types; they say what the types can't (side effects, units, what throws).

### Comments and writing
- Comments sit above the code and say why. Every file opens with a "Why this file exists" block. Never changelog wording ("was X before").
- No end-of-line comments. `//` only for disabled code, with a doc above saying what, why, and how to restore.
- No counts in comments that can go stale.
- Understood in one read: what it is first, one case per paragraph, short sentences, who did what, plain words, what breaks without it.
- Same for tests, READMEs, commits, PR descriptions and replies: lead with the answer, say what was and wasn't done.

### Functional code
- Pure by default, side effects at the edges. Never mutate inputs; copy before `sort`/`reverse`.
- `map`/`filter`/`reduce` with named steps, not loops that push. `reduce` into lookup tables instead of `find` in a loop.
- `const` and arrow functions. No shared mutable module state. Optional chaining with `??`.
- Transforms take plain data, never `req`/`res` or framework objects.

### TypeScript
- `type` aliases, not `interface`, except global declaration merging.
- No `any`, `as any`, `@ts-ignore`, or `!`; use `unknown` and narrow. Primitives, never boxed types.
- Callbacks return `void` and take required params. No overloads.
- String literal unions from `as const` arrays, not `enum`; tables checked with `satisfies`.
- Discriminated unions for state, not boolean flags. `readonly` on whatever crosses a function boundary.
- Types live in one place. Rules that can be lint or compiler config are config.

### Modules and services
- Named exports. One concern per file, named after it; no `utils`/`helpers`/`common`.
- Every vendor SDK goes through one wrapper; singletons are imported, not passed as params.
- Don't generalize for two of anything.

### Data, errors, async
- Writes are scoped to the one record they change.
- Throw for broken, return `null`/`[]` for absent. Never swallow: recover or add context and rethrow.
- Catch and report once at the boundary. Users see their terms; logs get ids, operation, vendor, never secrets.
- Expected, unexpected, and stale failures get different responses. Every state (loading, empty, error, success) has a face. Say what actually happened.
- `await`, not `.then`. Independent work runs concurrently; no `await` in a loop; no floating promises; `async` only if it awaits.
- Timeouts on every network call. Retry only what's idempotent. Guard against double-submit.
- Validate and coerce once at the edge, then trust the shape. Re-validate on the server against fresh data. Never interpolate unvalidated input into a path or query.
- Webhooks: verify the signature, dedupe by event id. Writes are safe to run twice; pass idempotency keys built from the operation.
- Money is integer cents with its currency; round once; format at display with an explicit locale.
- UTC and ISO 8601 everywhere but the screen; one formatter; pick calendar time zones explicitly.
- One secrets manager; env read only in `config/`; fail at boot on a missing secret; constants aren't env vars; never log secrets.

### UI
- React: derive during render; effects only for side effects; named props; stable keys, never the index.
- Semantic elements, one heading hierarchy, design tokens only, `is-` state classes, flex/grid with `gap`, mobile first.
- Real labels; errors linked with `aria-describedby`; full keyboard support; visible focus; never color alone; WCAG AA contrast; run the checkers.

### Testing
- Pure functions get plain tests. Stub the vendor wrapper, never your own modules. Test behavior. Test names read as a spec.
- One command runs typecheck, lint and every test, green before every commit.

### Scope, commits, docs
- Change only what the task requires; report bugs next door instead of fixing them. Simplest thing that works.
- "Remove this button" means comment it out and keep its plumbing.
- Add a dependency only when it replaces more code than it adds.
- Small commits, imperative subject under 72 characters, a body saying why.
- Docs change in the same PR as the code. Restructuring moves text; removal is its own change.
