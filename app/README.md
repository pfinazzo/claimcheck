# claimcheck Desk

@author Patrick Finazzo

The desktop board over a claimcheck ledger. Open a repo, see each claim an AI made beside what the independent check said and how many planted bugs the tests caught, and fix the weak ones. A repo that is not set up yet starts a guided setup, the same one `claimcheck init` runs in a terminal. Either surface works on its own.

![The board with one claim that needs a decision](../docs/screenshots/desk-board-weak.png)

## Run it

```bash
cd app
npm install
npm start          # builds, then opens the app
```

Node 24 or newer (the tests run TypeScript directly). The first install downloads Electron. claimcheck itself must be installed too: Desk runs it for setup, spec writing and checks.

| Script | Does |
| --- | --- |
| `npm start` | Build, then open Desk |
| `npm run build` | Bundle the main process, the preload bridge and the page into `dist/` |
| `npm run typecheck` | Strict type check of everything, with zero errors required |
| `npm test` | Typecheck, build, then run every test |
| `npm run screenshot -- <repo> out.png` | Render the board headless. Add `--theme light\|dark`, `--size 1440x900`, `--view wizard:STEP[:BEAT]` |

## The board

A slim top bar (repo, branch, whether the spec is frozen) with the actions Write a spec, Connect Claude, Run claimcheck and Open repo. One sentence under it summarises the repo. Then the claims in two groups, **Needs a decision** and **Backed**, each with one muted line of facts. Select a claim for its detail: why it is flagged, what the checker said, which planted bugs got past the tests, and what to do about it.

From a flagged claim, **Fix this** asks Claude (read-only) for three or four different ways to resolve it. You pick one. Claude builds it with tests on a new branch in a separate worktree, Desk runs your tests there, and a fix only counts as resolved when the tests pass **and** Claude actually committed a change. **Copy prompt** gives you the request as text, and **Accept the risk** takes a one-line reason and writes it to the ledger.

Arrow keys move through the list. The page follows the system light or dark setting and respects reduced motion.

## Setup in the app

Opening a folder that is a git repo but has no `.claimcheck/` starts the wizard. The board's **Write a spec** button starts it at the spec step for later tasks. Progress is saved, so a restart resumes.

1. **Welcome.** Three short screens: why a confident claim is not a checked claim, the three checks, and a small animation of a planted bug being missed and then caught. Each has a "More detail" disclosure, and the intro can be skipped.
2. **Set up this repository.** Runs `claimcheck init`: ignores `.env` and key files first, writes the config, installs the commit hook, adds the scratch lines to `.gitignore`, and adds the claimcheck rules to `CLAUDE.md` or `AGENTS.md`. Shows what was done, warns about secrets that are already committed, and lets you correct the detected test command.
3. **Connect Claude.** Your Claude Code sign-in or an API key, or skip.
4. **Write the spec.** You say what you want built, Claude asks questions with the reason for each, and the criteria take shape beside them. Every criterion is editable, with warnings for vague wording.
5. **Freeze the spec.** Shows the spec as it will be written, then freezes it and commits it on a task branch. Nothing is pushed.
6. **Done.** What to do next.

![Step 4: Claude's questions beside the editable criteria](../docs/screenshots/desk-setup-4.png)

## How it talks to claimcheck

Desk runs the claimcheck command line, with the repo as the working directory, using four machine commands. Each prints one JSON document and, on failure, `{"error": "...", "code": N}`:

| Command | Used for |
| --- | --- |
| `claimcheck status --json` | Where the repo is: set up, spec state, hook |
| `claimcheck init --json --yes [--ci github]` | The setup step |
| `claimcheck spec draft --step --provider ...` | One round of the spec conversation. Desk keeps the conversation and sends it each time |
| `claimcheck spec draft --finish --provider ...` | Write, freeze and commit the spec |

Everything the CLI prints is treated as untrusted text: it is parsed, coerced to known fields, capped in size, and drawn as text.

## What it never does

- **Send secrets.** The same filter as the command line runs on every prompt, diff and file sent to Claude. Credential files are never read, secret-looking values are replaced with `[REDACTED:kind]`, and size is capped. In Claude Code mode its file tools are denied access to credential files.
- **Build markup from text.** The page is built with DOM calls and text nodes. There is no `innerHTML` anywhere, and a test fails if one appears. The page's content security policy allows no inline script, no inline style and no network requests.
- **Open arbitrary paths.** The only things it opens are a web link or a fix worktree folder inside the repo.
- **Run commands from a repo you have not looked at.** The first run in a repo shows the exact commands its config and claims name, and asks first. If they change, it asks again.
- **Push, merge, open a pull request without you pressing the button, or read `.env` files.**
- **Store a key in plain text.** An API key is encrypted with your operating system's keychain, decrypted only at the moment of a call, and handed to the child process only.

It writes only `.claimcheck/app-state.json`, `.claimcheck/worktrees/`, outcome lines on the ledger, and (through the wizard) the test command in `config.toml`.

## Layout

```
src/main.ts        the main process: window, IPC wiring, screenshot mode
src/preload.ts     the bridge exposed to the page as window.desk (built to dist/preload.cjs)
src/lib/           everything the main process does: store, ledger, fixer, Claude clients, CLI protocol, redaction
src/shared/        types and the wizard's state machine, used by both sides (ipc.ts is the one contract)
src/renderer/      the page: board, detail, wizard, dialogs (builds to dist/renderer.js)
renderer/          index.html and styles.css
test/              node:test, in TypeScript, run directly with Node's type stripping
```

All of it is TypeScript with `strict`, `noUncheckedIndexedAccess` and no `any`. The one place untyped data arrives, JSON from disk or from a child process, is parsed by small validators before the rest of the code sees it.
