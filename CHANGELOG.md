# Changelog

All notable changes to claimcheck. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [semantic versioning](https://semver.org/).

## [Unreleased]

### Added
- **Write a spec from this issue** on an opened issue. It starts the spec wizard with the issue's title and description as the goal, with template comments removed. You read and edit it before anything is sent to Claude.
- **Check this pull request** in Desk. For a pull request whose branch carries claims, Desk fetches it into a folder of its own, so your checkout is not touched, and opens it as the board. The usual dialog lists the commands first, and nothing runs until you agree. The check uses the base branch's `.claimcheck/config.toml` when it has one, so a pull request cannot loosen its own checks, and a pull request that brings its own settings can never choose the stand-in checker. **Post results** shows the exact comment, formatted as GitHub will show it, and posts it only when you press Post comment. Nothing is ever pushed.
- **Pull requests** and **Issues** tabs in Desk, read through the GitHub CLI for whichever repo is open. Each pull request shows who wrote it, its branches, size, whether the checks pass, its review state, whether it can merge, the issues it closes, and which are yours or waiting on your review. Opening one shows its files and its description, drawn as formatted Markdown with tables, task lists and code. The description is built from known parts only: HTML in it is dropped, pictures are named and never loaded, and only web links are kept. Works for any repo with a GitHub remote, whether or not it uses claimcheck yet.
- An **all-clear banner** in Desk. When no claim needs a decision, the board shows a short celebration and an **Open pull request** button that opens a pull request from the branch you are on into the base branch. The description lists every claim with its three figures. A claim settled by hand while still flagged is called that, not "backed". The button explains itself when it cannot work: no remote, not signed in, on the base branch, or the branch not on GitHub yet. Desk never pushes for you.
- A **Light / Dark / Auto** switch at the right end of Desk's top bar. It changes the whole window at once, including the backdrop and the 3D map, and Desk opens with the look you last picked. Auto follows the computer, as before.
- A **Confidence map** tab in Desk: a 3D chart, drawn with Three.js, of every claim placed by its stated confidence, the share of planted bugs the tests caught, and the independent checker's verdict. Three red sheets mark the flag lines, a green box marks the backed region, and you can orbit, zoom and pan it. A table of all claims, flagged and backed, sits beside it. The README has a plain-English guide to reading it.
- Claude now recommends one of the approaches it proposes for a fix. The recommended approach is labelled, listed first, and explained above the cards, weighed against the goal you gave when writing the spec. If Claude marks none, Desk shows no recommendation instead of guessing.
- **Connect GitHub** in Desk: checks `gh` is installed and signed in and that the repo has a remote, and starts `gh auth login --web` in a terminal when it is not signed in, updating itself when the sign-in finishes.
- **Inspect the code** on a fix: a read-only viewer for the files and lines Claude committed, with line numbers.
- `npm run screenshot` views that open each dialog or tab with sample data: `board:trust`, `board:github`, `board:code`, `board:open`, `board:propose` and `board:graph`.

### Changed
- The whole Desk page scrolls now, so the list and the opened item beside it get real height instead of what was left under the summary and banner. The summary strip and the all-clear banner show on the Claims and Confidence map tabs only.
- Desk has a new look: glass panels over a Three.js backdrop (a wireframe grid rolling toward a lit horizon under a field of light), a stat strip, confidence bars on the claim list, evidence tiles on the detail, and a numbered step rail in the setup wizard. Light and dark follow the system, reduced motion draws one still frame, and a machine without WebGL gets the panels alone. The other screenshots in the README still show the previous look.
- Open repo takes a pasted folder path as well as the folder picker, and shows each recent repo as its name over its path.

### Fixed
- Run claimcheck in Desk said "claimcheck was not found" when `claimcheck` was not on PATH, which is the normal case for a copy installed with pip into a virtualenv, or when Desk is started from the Start menu. Desk now also tries the Python named by `[app].python`, a virtualenv inside the repo (only after you agree to run the repo's commands), and any Python on PATH that has claimcheck installed. The message now says how to install it.
- Open pull request was offered whenever `gh` was signed in, even for a repo with no remote, and then failed with Node's raw error: the whole command line and pull request body. The button is now disabled with the reason beside it until it can work, the server checks again when it is pressed, `gh`'s refusals become plain sentences, and every failure shown in Desk is cut down to what the program said.
- Desk showed "This repo can run commands on your computer" as an error toast instead of the dialog that lists the commands with a Run them button. The context bridge dropped the error's code and details on the way to the page; the bridge now carries them as plain data.
- Desk no longer flashes the whole panel on every run update. The panel's entrance animation plays only when the view or the selected claim changes.
- Pressed and selected buttons in Desk wrote `aria-pressed` and `aria-selected` as empty attributes instead of `true` or `false`, so screen readers could not tell which claim or tab was selected.
- Open repo listed scratch folders from the system temp directory, and Desk could launch into one. Screenshot runs had saved their throwaway test repos into the real recent-repos list. They now use a data folder of their own, the list drops temp and missing folders when it is read, and the folder picker starts beside your last project.
- `test_ac1_version_via_module_and_script` failed under a correctly installed Windows Python that is not a virtual environment, because it looked for the `claimcheck` script beside `python.exe` instead of in the `Scripts` folder. It now asks Python where scripts go.

## [0.1.0] - 2026-10-25

First public version. Developed privately from October 15, 2026 and published October 24, 2026.

### Added
- `claimcheck verify-ledger` and a hash chain on the ledger. Each new line carries `prev`, the SHA-256 of the line before it, and the first chained line seals every older line. `--base REF` also catches the last line being cut off. Exit code 8 on failure. Desk's outcome lines continue the same chain.
- GitHub Actions workflow: Python 3.11, 3.12 and 3.13, Desk on Node 22, and the ledger checks.
- A real REFUTED example from claimcheck's own history in the README, and a development-history line.
- `CITATION.cff`, repository URLs in the package metadata, and `engines.node` in the Desk package.

### Changed
- `claimcheck run`, `check` and `mutate` refuse an empty diff with exit code 7 and say how to proceed. Before, `run` wrote UNVERIFIABLE lines to the ledger for a run that checked nothing.
- Desk counts each planted bug once in the board summary. It used to add up every claim's count, so claims sharing a file showed the same bugs several times.
- Branch names made from a spec goal keep accented letters as plain letters (`Café menu` is `cafe-menu`, not `caf-menu`).

### Fixed
- `pip install -e ".[dev]"` failed because `[project.urls]` sat above `requires-python` and `dependencies` in `pyproject.toml`.
- The README had lost the `@author` line the attribution test checks.

### What the first version includes

- Frozen acceptance criteria (`spec.md` and `spec.lock`), claims with a stated confidence and a kill condition, and an independent checker that never sees the confidence.
- Planted-bug testing on the changed lines: sign flips, off-by-one, swapped arguments and boundary shifts.
- An append-only ledger, a git pre-commit hook that you opt in to, and exit codes 0 and 2 to 6.
- Guided setup in the terminal and in the Desk app, with a secrets filter so secret files and values are never sent to a model.
- The Desk app: a board of claims, the checker's reasons, which planted bugs survived, and a flow for fixing a weak claim.
