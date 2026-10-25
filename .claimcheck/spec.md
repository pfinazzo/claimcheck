# Acceptance criteria

Task: the Desk board summary must count each planted bug once, not once per claim.

- [ ] 1. When two claims share the same planted bugs from one run (same run, file, line and change), the summary line counts each bug once: two claims that both carry the same 2 killed bugs show "2 of 2 planted bugs caught", not "4 of 4".
- [ ] 2. Claims whose planted bugs differ still add up: one claim with 2 bugs (1 caught) and another with 3 bugs (3 caught) show "4 of 5 planted bugs caught".
- [ ] 3. The same change in two different runs counts as two bugs, because it is two measurements.
- [ ] 4. A claim's own facts line (for example "tests caught 2 of 2 planted bugs") is unchanged, and a board whose claims ran no planted bugs shows no planted-bug sentence.
