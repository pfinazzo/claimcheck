# Acceptance criteria

Task: the GitHub workflow that `claimcheck init --ci github` writes must not assume claimcheck is private, and the README must not drift from it.

- [ ] 1. The workflow text written by `claimcheck init --ci github` contains no wording about the claimcheck repository being private or about needing a token to install it.
- [ ] 2. The workflow still installs claimcheck from `https://github.com/pfinazzo/claimcheck.git` and still runs `claimcheck run --provider claude --base origin/${{ github.base_ref }}` with `ANTHROPIC_API_KEY` taken from the repository secrets.
- [ ] 3. The install command shown in the README uses the same GitHub address as the workflow template, so the two cannot drift apart without a test failing.
