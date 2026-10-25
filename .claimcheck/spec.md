# Acceptance criteria

Task: make the ledger tamper-evident. Every new line carries the hash of the line before it, and a command checks the chain.

- [ ] 1. Every ledger line that claimcheck writes carries a `prev` field holding the SHA-256 of the previous line's text (without its line break); the first chained line carries the SHA-256 of all lines before it joined by newlines, or 64 zeros when the ledger was empty.
- [ ] 2. `claimcheck verify-ledger` exits 0 on an untouched ledger, including one that starts with older lines that have no `prev` field.
- [ ] 3. `claimcheck verify-ledger` exits 8 and names the first bad line number when a line is deleted from the middle, when a line that is not the last is edited (an older line without `prev` counts), or when two lines are swapped.
- [ ] 4. With `--base REF`, `claimcheck verify-ledger` also exits 8 when the last line was deleted or edited, because the ledger at REF must still be an unchanged beginning of the current one. A ledger that only gained lines passes.
- [ ] 5. A line without `prev` that comes after a chained line is refused, so the unchained form cannot be used to slip lines in.
- [ ] 6. Desk's outcome lines continue the same chain: a line it appends has the same `prev` the Python code would give, and `claimcheck verify-ledger` accepts the result.
- [ ] 7. The CI workflow runs `claimcheck verify-ledger`, and with `--base` on pull requests.
