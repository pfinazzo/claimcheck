# Acceptance criteria

Goal: Make `claimcheck run` and `claimcheck check` refuse what today only the pre-commit hook refuses, and stop UNVERIFIABLE from passing. This is the first of three PRs that make CI the referee. (1) Before any checker call, `run` and `check` apply the hook's claim rules to the diff under test: if the diff changes code files (paths not in `ignore`) and claims.yaml has no claims, refuse; a claim that lists a file the diff does not change is refused; with `require_full_coverage`, a changed code file that no claim lists is refused, otherwise it is a warning. Refusals exit 4, like the hook. The hook and the run share one function, so the rules cannot drift. (2) A claim that lists a file the checker never saw, because the secret filter withheld it or the size cap cut it, cannot come back SUPPORTED: its verdict becomes UNVERIFIABLE with a reason naming that file. (3) A new setting `[checker] fail_on_unverifiable`, true by default. When it is true, a run or check where any claim is UNVERIFIABLE and not accepted exits 9 ("a claim needs a person"). REFUTED still exits 2 and wins over 9. When it is false, UNVERIFIABLE prints a warning and exits as today. (4) A new command `claimcheck accept <claim-id> --note "..."` for a person. It refuses an empty note and a claim id that is not in claims.yaml. It appends one acceptance line to the ledger, hash-chained like every other line, recording the claim id, a hash of the claim's text, kill_condition and files, a hash of those files' contents at HEAD, the note, the time and git's user.name. A later run treats that claim's UNVERIFIABLE as accepted only while both hashes still match, so editing the claim or its files voids the acceptance. The run output and the ledger say which claims passed by acceptance. The agent instructions written by init say only a person runs `claimcheck accept`. README, the exit code table, examples/config.toml and the config init writes are updated. Out of this PR: reading config from the base branch, recording the test command in the ledger, spec timing by git order, the ledger check on push, and Desk's own Accept the risk.

- [ ] 1. With code files changed (paths not in ignore) and no claims in claims.yaml, `run` and `check` exit 4 without calling the checker.
  - Check: Stage a change to src/a.py with empty claims.yaml; run both commands; assert exit 4 and the stub checker was called zero times.
- [ ] 2. A claim listing a file the diff does not change makes `run` and `check` exit 4 before any checker call, for every claim in claims.yaml.
  - Check: Claim lists b.py, diff changes only a.py; assert exit 4 and zero checker calls. Also with a second valid claim present, assert exit 4.
- [ ] 3. With require_full_coverage true, a changed code file listed by no claim makes `run` and `check` exit 4; with it false, they print a warning and continue.
  - Check: Change a.py and c.py, claim lists only a.py; assert exit 4 when true; when false assert warning naming c.py and no exit 4.
- [ ] 4. The hook and `run`/`check` apply claim rules through one shared function, and give the same refusal for the same diff and claims.
  - Check: Test feeding identical inputs to the hook and to run/check, asserting the same refusal messages; assert the hook module calls the shared function.
- [ ] 5. Claim refusals (exit 4) happen before any checker call and win over any verdict-based exit code.
  - Check: Diff with a refusal condition and stub returning REFUTED; assert exit 4 and zero checker calls.
- [ ] 6. A claim listing a file withheld by the secret filter or cut by the size cap never returns SUPPORTED; it returns UNVERIFIABLE with a reason naming every such file.
  - Check: Stub returns SUPPORTED; claim lists a secret-containing file and an over-cap file; assert UNVERIFIABLE and reason contains both paths.
- [ ] 7. A REFUTED verdict stays REFUTED when files were unseen; an UNVERIFIABLE verdict stays UNVERIFIABLE with the unseen files added to its reason.
  - Check: Stub returns REFUTED, then UNVERIFIABLE, for a claim listing a withheld file; assert REFUTED unchanged and UNVERIFIABLE reason includes the path.
- [ ] 8. `[checker] fail_on_unverifiable` defaults to true when absent from config.
  - Check: Load a config without the key; assert the value is true.
- [ ] 9. With fail_on_unverifiable true, a run or check with any unaccepted UNVERIFIABLE claim and no REFUTED exits 9.
  - Check: Stub returns one UNVERIFIABLE, others SUPPORTED; assert exit 9.
- [ ] 10. REFUTED (or catch rate under the floor) exits 2 and beats 9; 9 beats 0; pre-verdict error exits 1,3,4,5,6,7 keep their codes.
  - Check: Stub returns REFUTED and UNVERIFIABLE; assert exit 2. UNVERIFIABLE only; assert 9. Trigger exit 4 case; assert 4.
- [ ] 11. With fail_on_unverifiable false, UNVERIFIABLE prints a warning and the exit code is what it would be without it.
  - Check: Set false; stub returns UNVERIFIABLE; assert warning printed and exit 0.
- [ ] 12. `claimcheck accept <id> --note` with an empty or whitespace-only note, or an id not in claims.yaml, exits 4 and appends nothing to the ledger.
  - Check: Run with --note "" and with an unknown id; assert exit 4 and ledger bytes unchanged.
- [ ] 13. `accept` works regardless of the claim's verdict (even before any run), outside a git repo gives the existing 'not a git repository' error, and with no git user.name records 'unknown'.
  - Check: Accept a claim before any run and assert success; unset user.name and assert recorded name 'unknown'; run outside a repo and assert the existing error.
- [ ] 14. A successful `accept` appends exactly one hash-chained ledger line with claim id, hash of claim text/kill_condition/files, hash of those files' on-disk contents at accept time, note, time, git user.name.
  - Check: Run accept; assert one new line, valid chain verification, and every field present with expected hash values.
- [ ] 15. An UNVERIFIABLE claim counts as accepted if any acceptance line for it has both hashes matching the claim and its files now; editing the claim or its files (committed or not) voids it, giving exit 9.
  - Check: Accept, run, assert exit 0; edit claim text, then separately a listed file, assert exit 9 each time. Accept twice (old content, then current); assert still accepted.
- [ ] 16. Acceptance does not depend on the base branch or the rest of the diff.
  - Check: Accept, then change an unrelated file or base; run and assert the claim is still accepted.
- [ ] 17. Run output lists claims that passed by acceptance, whether fail_on_unverifiable is true or false; each claim's ledger line for the run has an 'accepted' field: the acceptance line's hash, else null.
  - Check: After accept, run with true and with false; assert output names the claim id and its ledger line's accepted equals the acceptance line hash; other claims have null.
- [ ] 18. The agent instructions written by init state that only a person runs `claimcheck accept`.
  - Check: Run init in a temp repo; assert the generated agent file contains that statement.
- [ ] 19. README, the exit code table (including 9), examples/config.toml, and the config written by init document fail_on_unverifiable and accept.
  - Check: Grep each file for fail_on_unverifiable, exit 9, and accept; assert init's config contains the key.

## Out of scope

- Reading config from the base branch
- Recording the test command in the ledger
- Spec timing by git order
- Ledger check on push
- Desk's own Accept the risk

<!-- drafted with `claimcheck spec draft`; frozen with `claimcheck spec freeze` -->
