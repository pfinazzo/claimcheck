claimcheck flagged one claim that the author of a recent diff (an AI coding agent) made about its own code. The claim was checked by an independent model that saw only the diff, and the changed lines had planted bugs run against the project's tests. One or more of those checks came back weak. A person pressed "Fix this" on it. Your job right now is only to propose ways to resolve it. Do not change any file.

The flagged claim:

{{claim}}

Before proposing anything, read:

1. The project's own rules, if it has them: `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, or a style guide the README points to. A fix that breaks them is not a fix.
2. The frozen acceptance criteria in `.claimcheck/spec.md`. They were written before the code and are the contract; a fix that needs a new criterion is a different kind of change and should say so.
3. The code the claim points at, and whatever it calls, until you understand exactly why the checker or the planted bugs disagreed with the author.
4. The tests that cover that code. The project's test command is `{{test_cmd}}`. A planted bug that survived means those tests do not pin the behaviour the claim describes.

"Resolve" can mean different things here, and the approaches should cover the genuinely different ones: the code is wrong and needs fixing; the code is right but the tests do not prove it; the claim itself overstates what the code does and should be narrowed; or the kill condition was not a real observable. Propose three to four approaches that are genuinely different, not variations of one idea. For each, give:

- `title`: a few words.
- `summary`: two or three plain sentences on what changes and how it settles the claim.
- `pros`: concrete benefits. Say what it protects and what it keeps simple.
- `cons`: concrete costs and risks. Say what it adds, what could break, which of the project's rules it strains, and any case it still misses.
- `effort`: `small`, `medium` or `large`.
- `touches`: the files it would change or add, including tests.

Write in plain English for an engineer new to this codebase. Be honest about the costs. If one approach is clearly the best fit, its pros should make that plain, but do not leave out its cons.

Answer only with the JSON the schema asks for.
