# Acceptance criteria

Goal: Two pull requests that each use claimcheck never conflict over claimcheck's files. Today every task writes the same .claimcheck/spec.md, spec.lock and claims.yaml, and appends to one hash-chained .claimcheck/ledger.jsonl. So every second PR conflicts on all four. Resolving it means dropping that PR's own ledger lines, keeping main's, and running claimcheck again, about 10 minutes per merge. Fix: an opt-in layout, set by layout = "tasks" in .claimcheck/config.toml. In it, each task keeps spec.md, spec.lock, claims.yaml, ledger.jsonl and spec-draft.json in .claimcheck/tasks/<task>/. The task is the current git branch name, made safe for a folder name. Every CLI path goes through one resolver, so spec, freeze, verify, claims validate, check, mutate, run, accept, the commit hook and the late-refreeze rules all use the task folder. Each task ledger is its own hash chain. verify-ledger checks every task ledger's chain, and with --base checks that each task ledger and the old top-level ledger only grew. spec draft --finish creates the task branch first when on the base branch, then writes into that branch's folder. Without the setting, everything works exactly as today. init writes layout = "tasks" for new repos. The agent instructions block names the task folder in this layout. The Desk app is out of scope for this change.

- [ ] 1. With layout = "tasks", spec, freeze and claims commands read and write spec.md, spec.lock, claims.yaml, ledger.jsonl and spec-draft.json only under .claimcheck/tasks/<task>/.
  - Check: On branch feat-a with layout=tasks, run spec draft --finish and freeze; assert the files are in .claimcheck/tasks/feat-a/ and top-level spec.md, spec.lock, claims.yaml, ledger.jsonl are not created or changed.
- [ ] 2. <task> is the git branch name with every character outside A-Z, a-z, 0-9, '.', '_' and '-' replaced by '-'.
  - Check: Branch feat/login gives folder feat-login; branch 'feat/x y' gives feat-x-y; the same branch always gives the same folder.
- [ ] 3. Two branches from the same base, each using claimcheck in the tasks layout, merge with no git conflict in any claimcheck file.
  - Check: In a temp repo create branches a and b, run spec and freeze on each, merge both into main, and assert git reports zero conflicts.
- [ ] 4. verify, claims validate, check, mutate, run, accept, the commit hook and the late-refreeze rules use the current task's folder in the tasks layout and do not read other tasks' files.
  - Check: For each command on branch feat-a, assert it reads and writes only .claimcheck/tasks/feat-a/ paths, even when tasks/feat-b/ exists.
- [ ] 5. Each task ledger is its own hash chain that starts at the genesis value, independent of other task ledgers and the old top-level ledger.
  - Check: Create ledgers on two branches; assert each first entry's previous hash is the genesis value and each chain validates alone.
- [ ] 6. verify-ledger checks the hash chain of every task ledger and the old top-level ledger, and exits non-zero naming the file if any chain is broken.
  - Check: Tamper with one line in tasks/a/ledger.jsonl with several tasks present; assert non-zero exit and that the output names that file.
- [ ] 7. verify-ledger --base fails if any task ledger or the old top-level ledger lost or changed lines present in base, and passes if each only grew.
  - Check: Remove or edit an earlier line in a ledger versus base and assert non-zero exit; append lines only and assert zero exit.
- [ ] 8. In the tasks layout, spec draft --finish on the base branch creates the task branch first, then writes into that branch's folder (or the CLAIMCHECK_TASK folder if set).
  - Check: On main with layout=tasks run spec draft --finish; assert the current branch is the new task branch, files are in its folder, and no folder exists for main.
- [ ] 9. spec draft refuses to start when the task's folder .claimcheck/tasks/<name> already exists at the base ref, with: 'A task folder .claimcheck/tasks/<name> already exists on <base>. Pick another branch name.'
  - Check: Commit tasks/feat-a/ on main, then start spec draft on branch feat/a; assert that refusal and a non-zero exit. Repeat with CLAIMCHECK_TASK=feat-a.
- [ ] 10. In the tasks layout on the config's base branch or detached HEAD with CLAIMCHECK_TASK unset or empty, task commands exit 3 with: 'claimcheck keeps each task's files in .claimcheck/tasks/<branch>/. You are on <base or detached HEAD>, which is not a task. Switch to a task branch, or run claimcheck spec draft to start one.'
  - Check: On main with layout=tasks and no CLAIMCHECK_TASK run freeze; assert exit 3, that message with 'main' filled in, and no files created. Repeat on detached HEAD and with CLAIMCHECK_TASK=''.
- [ ] 11. In the tasks layout, verify-ledger, status and init work on the base branch and on detached HEAD without needing a task.
  - Check: On main and on detached HEAD with layout=tasks, run each; assert none exits 3 for lack of a task.
- [ ] 12. In the tasks layout, the old top-level spec.md, spec.lock, claims.yaml and ledger.jsonl are never written by any command.
  - Check: With top-level files present, run the full flow on a task branch; assert their bytes are unchanged.
- [ ] 13. A layout value other than "single" or "tasks" is rejected with: 'invalid config.toml: layout must be "single" or "tasks" (got ...)'.
  - Check: Set layout = "flat"; run any command; assert non-zero exit and that message with the given value.
- [ ] 14. Without a layout key, or with layout = "single", all commands behave exactly as today using the top-level .claimcheck files.
  - Check: Run the existing test suite with no layout setting and assert it passes unchanged and no tasks/ folder is created.
- [ ] 15. init writes layout = "tasks" to a .claimcheck/config.toml that it creates for a new repo.
  - Check: Run init in an empty repo and assert config.toml contains layout = "tasks".
- [ ] 16. init leaves an existing .claimcheck/config.toml without a layout key unchanged, so that repo stays on the single layout.
  - Check: Create config.toml without layout, run init, assert the file bytes are identical and commands still use top-level files.
- [ ] 17. In the tasks layout, a non-empty CLAIMCHECK_TASK names the task instead of the git branch, sanitized by the same rule as branch names, wherever the command runs.
  - Check: On detached HEAD with CLAIMCHECK_TASK=feat/a, run check; assert it reads .claimcheck/tasks/feat-a/ only. On main with it set, assert no exit 3.
- [ ] 18. An empty CLAIMCHECK_TASK is treated as unset, so the branch name is used.
  - Check: On branch feat-a with CLAIMCHECK_TASK='', run check; assert it reads .claimcheck/tasks/feat-a/.
- [ ] 19. In the tasks layout, when CLAIMCHECK_TASK names a task whose folder has no spec.md, commands fail with: 'missing .claimcheck/tasks/<name>/spec.md; run `claimcheck spec draft`', not as zero claims.
  - Check: Set CLAIMCHECK_TASK=nope with no such folder; run check; assert non-zero exit and that message with 'nope', not a pass.
- [ ] 20. With CLAIMCHECK_TASK set, spec draft --finish on the base branch still creates a new branch, and writes into the folder named by CLAIMCHECK_TASK.
  - Check: On main with CLAIMCHECK_TASK=job-7, run spec draft --finish; assert a new branch is checked out and files are in tasks/job-7/, not the new branch's folder.
- [ ] 21. The CI template written by init --ci github sets CLAIMCHECK_TASK to the pull request's head branch (github.head_ref).
  - Check: Run init --ci github; assert the workflow file sets CLAIMCHECK_TASK: ${{ github.head_ref }} for the claimcheck steps.
- [ ] 22. In the tasks layout on the base branch or detached HEAD with CLAIMCHECK_TASK unset, the commit hook exits 0 and prints to stderr: 'claimcheck: not on a task branch, so no claims are checked for this commit.'
  - Check: On main with layout=tasks, run the hook; assert exit 0, that stderr line, and no claims checked.
- [ ] 23. The generated agent instructions block names .claimcheck/tasks/<task>/ as the task folder when layout is tasks.
  - Check: Generate the block in the tasks layout and assert it contains .claimcheck/tasks/<task>/ and does not name the top-level spec path as the target.
- [ ] 24. In the single layout, CLAIMCHECK_TASK is ignored.
  - Check: With no layout key and CLAIMCHECK_TASK=feat-a, run spec verify; it reads .claimcheck/spec.md.
- [ ] 25. ruff check, mypy and python -m pytest -q all exit 0.
  - Check: Run all three.

## Out of scope

- Desk app (app/) changes
- Automatic migration of existing top-level files into task folders
- Changing the ledger hash format
- Detecting the base branch (the config's base is used as today)
- Resolving collisions between branch names that map to the same folder, beyond the spec draft refusal
- Adding a --task flag (CLAIMCHECK_TASK is the only override)
- Changing existing repos' config.toml during init

<!-- drafted with `claimcheck spec draft`; frozen with `claimcheck spec freeze` -->
