You are in a fresh git worktree of this project, on a new branch made for one fix. claimcheck flagged a claim an AI coding agent made about its own diff, a person asked for ways to resolve it, and chose one. Build that approach here, and nothing else.

The flagged claim:

{{claim}}

The approach the person chose:

{{proposal}}

The approaches they did not choose, and why they cost more (do not build these):

{{rejected}}

How to work:

1. Read the project's rules (`CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`) and the frozen criteria in `.claimcheck/spec.md` before editing. Do not edit `.claimcheck/spec.md` or `.claimcheck/spec.lock`.
2. First write or tighten a test that shows the weakness the claim was flagged for. Run it and watch it fail (or, if the weakness was only in the tests, watch the planted-bug class it missed get caught).
3. Make the change the approach describes. Keep it small and on target.
4. Run the project's test command: `{{test_cmd}}`. Everything must pass.
5. If the claim's kill condition is a command or a test id, run it too: `{{kill_condition}}`.
6. Update `.claimcheck/claims.yaml` for this claim if the approach narrows the claim or changes its kill condition, so the next `claimcheck run` measures the right thing.
7. Commit on this branch with a message that names the claim id and the approach. Do not push, do not open a pull request, do not reach the internet, and do not install packages; the app handles the rest.

When you finish, reply with two or three plain sentences: what the weakness was, what you changed, and what proves it now.
