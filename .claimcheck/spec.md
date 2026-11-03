# Acceptance criteria

Goal: Make the rules block that `claimcheck init` writes into CLAUDE.md and AGENTS.md name every key `claimcheck claims validate` requires, so a coding agent that follows the block to the letter writes a claims.yaml claimcheck accepts (closes #41). Today the block names confidence, kill_condition, files and criteria but never the file's `version: 1` line or each claim's `verified_by` list, and the validator refuses the file with exit 4 before the checker sees a claim. Fix: the block shows one short example claim with every required key, in the block's plain style, and says what confidence, kill_condition and verified_by must hold. The README's description of what init writes mentions the example. This repo's own CLAUDE.md and AGENTS.md carry the new block.

- [ ] 1. The rules block from agentdocs.build_block names `version: 1` and every key a claim must carry: id, claim, confidence, criteria, files, kill_condition and verified_by.
  - Check: For each of those seven key names, assert that `<key>:` appears in build_block(); assert `version: 1` appears.
- [ ] 2. The block holds one fenced YAML example of a claims file, and claims.load_text plus claims.validate accept that example with no violation when the frozen lock holds the criterion the example cites.
  - Check: Cut the text between ```yaml and ``` out of build_block(), dedent it, run claims.load_text and claims.validate with lock_ids set to the cited criterion, and assert both return no violations.
- [ ] 3. The block says a kill_condition starts with test:, cmd: or obs: and must not restate the claim, and that verified_by is a list of one or more entries in the same three forms saying how the author checked the claim.
  - Check: Assert the block text contains the three prefixes, a sentence that verified_by lists how the author checked the claim, and that it rules out restating the claim.
- [ ] 4. The example is identical in the single and tasks layouts, and the tasks layout still names the task folder in every .claimcheck path while the example itself has no .claimcheck path.
  - Check: Assert the fenced example from build_block(layout='tasks') equals the one from build_block(); assert '.claimcheck/tasks/<task>/claims.yaml' is in the tasks block and '.claimcheck/claims.yaml' is not.
- [ ] 5. Running the agent-docs install on a file that carries the old block replaces it in place with the new block, exactly once, and leaves the text around it untouched.
  - Check: Write a CLAUDE.md with top text, the old block and bottom text; run agentdocs.install; assert the result is 'updated', the file has one claimcheck:begin marker, carries verified_by, and keeps the top and bottom text.
- [ ] 6. The README's description of what init writes says the rules carry an example claim with every key claims validate requires.
  - Check: grep README.md for a sentence about the example claim in the paragraph that points at src/claimcheck/agentdocs.py.
- [ ] 7. This repo's CLAUDE.md and AGENTS.md carry the new block and remain identical word for word.
  - Check: Assert both files contain 'verified_by' inside the claimcheck block and tests/test_agents_md.py passes.
- [ ] 8. ruff check, mypy and python -m pytest -q all pass, and every Python file in src/claimcheck keeps its @author line.
  - Check: Run the three commands and assert exit 0 for each.

<!-- drafted with `claimcheck spec draft`; frozen with `claimcheck spec freeze` -->
