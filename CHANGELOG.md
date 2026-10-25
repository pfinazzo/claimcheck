# Changelog

All notable changes to claimcheck. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [semantic versioning](https://semver.org/).

## [Unreleased]

Nothing yet.

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
