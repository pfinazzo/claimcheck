# Acceptance criteria

Task: branch names made from a spec goal must keep accented letters instead of splitting the word.

- [ ] 1. `slug("Café menu")` returns `cafe-menu`, and `slug("Überprüfung der Preise")` returns `uberprufung-der-preise`: an accented Latin letter becomes its plain letter, never a word break.
- [ ] 2. `slug("Ñandú São Paulo")` returns `nandu-sao-paulo`, so ligature-free decomposable letters of any Latin accent family are handled.
- [ ] 3. A goal with no Latin letters or digits at all (for example `日本語のタイトル` or `!!!`) still returns `task`.
- [ ] 4. Plain ASCII goals are unchanged: `slug("Add free shipping over 50")` returns `add-free-shipping-over-50`, at most five words and 40 characters, with no leading or trailing hyphen.
