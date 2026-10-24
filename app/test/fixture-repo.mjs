/**
 * Builds a throwaway git repo whose `.claimcheck/` looks like a real CLI run:
 * two frozen criteria, two claims, one check run (one SUPPORTED, one REFUTED),
 * one mutate run with a survivor, and a ledger with one line per claim.
 *
 * @author Patrick Finazzo
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

export const SPEC_MD = `# Acceptance criteria

- [ ] 1. sub(a, b) returns a - b for ints.
- [ ] 2. is_adult(age) is True at and above 18 and False below.
`;

export const CLAIMS_YAML = `version: 1
author: "claude-code/claude-fable-5-1"
base: "main"
claims:
  - id: c1
    claim: "sub returns a minus b"
    confidence: 0.9
    criteria: [1]
    files: ["src/calc.py"]
    kill_condition: "test: tests/test_calc.py::test_sub"
    verified_by: ["cmd: pytest -q"]
  - id: c2
    claim: "is_adult is inclusive at 18"
    confidence: 0.6
    criteria: [2]
    files: ["src/calc.py"]
    kill_condition: "obs: is_adult(18) returns True"
    verified_by: ["obs: ran it"]
`;

const CONFIG_TOML = `version = 1
base = "main"
test_cmd = "node -e \\"process.exit(0)\\""
ignore = ["*.md", "docs/**", ".claimcheck/**", "*.lock", "*.txt"]
require_full_coverage = true

[checker]
provider = "stub"
model = "claude-opus-5-5"

[mutate]
max_mutants = 50
timeout_s = 600
min_catch_rate = 0.0
`;

const git = (cwd, args, env = {}) =>
  execFileSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      GIT_CONFIG_NOSYSTEM: '1',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
    .toString()
    .trim();

const write = (root, rel, text) => {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
};

const lockFor = (specText) => {
  const criteria = [...specText.matchAll(/^- \[[ xX]\] (\d+)\. (.+)$/gm)].map((m) => ({ id: Number(m[1]), sha256: sha256(m[2].trim()) }));
  return { version: 1, frozen_at: '2026-10-15T18:00:00Z', git_head: '0'.repeat(40), spec_sha256: sha256(Buffer.from(specText, 'utf8')), criteria };
};

/** Returns the repo path. `opts.withRuns=false` leaves runs/ and the ledger empty. */
export const buildFixtureRepo = ({ withRuns = true, dir } = {}) => {
  const root = dir ?? mkdtempSync(path.join(os.tmpdir(), 'claimcheck-desk-'));
  const empty = path.join(root, 'gitconfig');
  writeFileSync(empty, '', 'utf8');
  const env = { GIT_CONFIG_GLOBAL: empty };
  git(root, ['init', '-q'], env);
  git(root, ['symbolic-ref', 'HEAD', 'refs/heads/main'], env);
  write(root, 'README.md', '# fixture\n');
  write(root, 'src/calc.py', 'def sub(a, b):\n    return a - b\n\n\ndef is_adult(age):\n    return age >= 18\n');
  write(root, 'tests/test_calc.py', 'from calc import sub, is_adult\n\n\ndef test_sub():\n    assert sub(5, 3) == 2\n');
  write(root, '.claimcheck/config.toml', CONFIG_TOML);
  write(root, '.claimcheck/spec.md', SPEC_MD);
  const lock = lockFor(SPEC_MD);
  write(root, '.claimcheck/spec.lock', JSON.stringify(lock, null, 2) + '\n');
  write(root, '.claimcheck/claims.yaml', CLAIMS_YAML);
  mkdirSync(path.join(root, '.claimcheck', 'runs'), { recursive: true });
  write(root, '.claimcheck/ledger.jsonl', '');
  git(root, ['add', '-A'], env);
  git(root, ['commit', '-q', '-m', 'fixture', '--no-verify'], env);
  const head = git(root, ['rev-parse', 'HEAD'], env);

  if (withRuns) {
    const check = {
      run_id: '20261015T180512Z-7f3a',
      ts: '2026-10-15T18:05:12Z',
      base: head,
      head,
      spec_lock: sha256(JSON.stringify(lock, null, 2) + '\n'),
      provider: 'stub',
      model: null,
      verdicts: [
        { id: 'c1', verdict: 'SUPPORTED', reason: 'return a - b is literal subtraction', evidence: ['+    return a - b'] },
        { id: 'c2', verdict: 'REFUTED', reason: 'the tests never call is_adult(18); the boundary is unproven', evidence: ['+    return age >= 18'] },
      ],
    };
    const mutants = [
      { file: 'src/calc.py', line_no: 2, cls: 'sign_flip', original: '    return a - b', mutated: '    return a + b', outcome: 'killed', duration_s: 0.4 },
      { file: 'src/calc.py', line_no: 6, cls: 'boundary', original: '    return age >= 18', mutated: '    return age > 18', outcome: 'survived', duration_s: 0.4 },
      { file: 'src/calc.py', line_no: 6, cls: 'off_by_one', original: '    return age >= 18', mutated: '    return age >= 19', outcome: 'survived', duration_s: 0.4 },
    ];
    const summary = { total: 3, killed: 1, survived: 2, timeout: 0, catch_rate: 0.3333 };
    const mutate = {
      run_id: '20261015T180530Z-aa11',
      ts: '2026-10-15T18:05:30Z',
      base: head,
      head,
      test_cmd: 'node -e "process.exit(0)"',
      baseline_s: 0.3,
      seed: 0,
      candidates: 3,
      mutants,
      summary,
      per_claim: { c1: summary, c2: summary },
    };
    write(root, '.claimcheck/runs/20261015T180512Z-check.json', JSON.stringify(check, null, 2) + '\n');
    write(root, '.claimcheck/runs/20261015T180530Z-mutate.json', JSON.stringify(mutate, null, 2) + '\n');
    const line = (id, claim, confidence, verdict, reason) =>
      JSON.stringify({
        v: 1, type: 'claim', ts: '2026-10-15T18:05:40Z', run_id: check.run_id, repo: sha256(root), base: head, head,
        spec_lock: check.spec_lock, author: 'claude-code/claude-fable-5-1', claim_id: id, claim, confidence, criteria: [id === 'c1' ? 1 : 2],
        files: ['src/calc.py'], kill_condition: id === 'c1' ? 'test: tests/test_calc.py::test_sub' : 'obs: is_adult(18) returns True',
        checker: { provider: 'stub', model: null, verdict, reason, evidence: [] },
        mutation: { total: 3, killed: 1, survived: 2, timeout: 0, catch_rate: 0.3333 },
        outcome: null, outcome_source: null, outcome_ts: null,
      });
    write(root, '.claimcheck/ledger.jsonl', `${line('c1', 'sub returns a minus b', 0.9, 'SUPPORTED', 'literal subtraction')}\n${line('c2', 'is_adult is inclusive at 18', 0.6, 'REFUTED', 'boundary unproven')}\n`);
  }
  return root;
};
