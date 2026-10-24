/**
 * The prompts the Fix flow sends, the shape proposals must have, and the tool
 * allowlists Claude runs under. Templates live in ../prompts/ so an edit takes
 * effect on the next run.
 *
 * @author Patrick Finazzo
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { redactText } from './redact.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.join(HERE, '..', 'prompts');

export const CLOSING_SENTENCE =
  'Do not change any code yet. Propose three to four genuinely different ways to resolve this, each with pros, cons, effort (small, medium or large) and the files it touches, and wait for me to choose.';

export const PROPOSE_TOOLS = ['Read', 'Grep', 'Glob'];

/** Credential files, in the relative, home and any-depth forms Claude Code's deny rules understand. */
export const SECRET_PATHS = [
  './.env', './.env.*', '**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx', '**/id_rsa*', '**/id_ed25519*', '**/id_ecdsa*',
  '**/.npmrc', '**/.pypirc', '**/.netrc', '**/credentials*', '**/*.env', '**/*.jks', '**/*.keystore', '**/*.p8', '**/*.ppk', '**/*.kdbx', '**/*.gpg',
  '**/*.tfvars', '**/terraform.tfstate*', '**/service-account*.json', '**/*serviceaccount*.json', '**/client_secret*.json', '**/firebase-adminsdk*.json',
  '**/.git-credentials', '**/.htpasswd', '**/.pgpass', '**/secrets/**', '**/secrets.*', '**/secret.*', '**/.ssh/**', '**/.aws/**', '**/.kube/**', '**/.docker/**',
  '~/.ssh/**', '~/.aws/**', '~/.kube/**', '~/.docker/**', '~/.config/gh/**', '~/.gnupg/**', '~/.npmrc', '~/.netrc', '~/.git-credentials', '../**',
];

/** Files whose edit would change what the app or the repo's tooling runs, or the frozen contract. */
export const PROTECTED_WRITES = [
  './.claimcheck/config.toml', './.claimcheck/spec.md', './.claimcheck/spec.lock', './.claimcheck/ledger.jsonl', './.claimcheck/app-state.json',
  './.git/**', './.github/**', './.claude/**', './.husky/**',
];

export const IMPLEMENT_TOOLS = [
  'Read', 'Grep', 'Glob', 'Edit', 'Write', 'TodoWrite',
  'Bash(npm run *)', 'Bash(npm test *)', 'Bash(npm test)',
  'Bash(pnpm run *)', 'Bash(pnpm test *)', 'Bash(pnpm test)',
  'Bash(yarn run *)', 'Bash(yarn test *)', 'Bash(yarn test)',
  'Bash(npx vitest *)', 'Bash(npx jest *)', 'Bash(npx playwright *)',
  'Bash(npx prettier *)', 'Bash(npx eslint *)', 'Bash(npx tsc *)',
  'Bash(pytest *)', 'Bash(pytest)', 'Bash(python -m pytest *)', 'Bash(python3 -m pytest *)', 'Bash(py -3 -m pytest *)',
  'Bash(go test *)', 'Bash(go vet *)', 'Bash(go build *)', 'Bash(cargo test *)', 'Bash(cargo build *)', 'Bash(cargo check *)',
  'Bash(make test *)', 'Bash(make test)', 'Bash(make check)',
  'Bash(claimcheck run)', 'Bash(claimcheck run *)',
  'Bash(git status)', 'Bash(git status --short)', 'Bash(git diff)', 'Bash(git diff --stat)', 'Bash(git diff HEAD)', 'Bash(git diff HEAD --stat)',
  'Bash(git log --oneline)', 'Bash(git log --oneline -n *)', 'Bash(git show --stat HEAD)',
  'Bash(git add *)', 'Bash(git commit *)',
  'Bash(ls)', 'Bash(ls *)',
];

/**
 * Nothing in this list can be undone by a later allow. Claude never reads credential files, never
 * writes anywhere git or CI reads from, never edits the frozen spec or the app's own config, and
 * never uses the forms of git and sed that can write a file or reach the network. `cat`, `grep` and
 * `sed` are not allowed at all: the Read, Grep and Glob tools do the same job and obey these denies.
 */
export const BLOCKED_TOOLS = [
  'Bash(git push *)', 'Bash(git push)', 'Bash(git remote *)', 'Bash(git fetch *)', 'Bash(git pull *)', 'Bash(git clone *)',
  'Bash(git config *)', 'Bash(git -c *)', 'Bash(git * --output*)', 'Bash(git submodule *)', 'Bash(gh *)', 'Bash(curl *)', 'Bash(wget *)',
  'Bash(npm publish *)', 'Bash(npm install *)', 'Bash(npm i *)', 'Bash(pnpm add *)', 'Bash(yarn add *)',
  'Bash(pip install *)', 'Bash(pip3 install *)', 'Bash(uv add *)', 'Bash(cargo add *)',
  'Bash(cat *)', 'Bash(sed *)', 'Bash(grep *)', 'Bash(rg *)', 'Bash(find *)',
  'WebFetch', 'WebSearch',
  ...SECRET_PATHS.flatMap((g) => [`Read(${g})`, `Edit(${g})`, `Write(${g})`]),
  ...PROTECTED_WRITES.flatMap((g) => [`Edit(${g})`, `Write(${g})`]),
];

export const PROPOSALS_SCHEMA = {
  type: 'object',
  properties: {
    proposals: {
      type: 'array',
      minItems: 3,
      maxItems: 4,
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          summary: { type: 'string' },
          pros: { type: 'array', items: { type: 'string' } },
          cons: { type: 'array', items: { type: 'string' } },
          effort: { type: 'string', enum: ['small', 'medium', 'large'] },
          touches: { type: 'array', items: { type: 'string' } },
        },
        required: ['title', 'summary', 'pros', 'cons', 'effort', 'touches'],
        additionalProperties: false,
      },
    },
  },
  required: ['proposals'],
  additionalProperties: false,
};

const readTemplate = (name) => readFileSync(path.join(PROMPTS_DIR, name), 'utf8');

const fill = (template, values) => template.replace(/\{\{(\w+)\}\}/g, (_, key) => String(values[key] ?? ''));

const bullet = (items, empty = '(none)') => (items?.length ? items.map((i) => `- ${i}`).join('\n') : empty);

/** The claim written out, shared by the propose and implement prompts. */
export const describeClaim = (ctx) => {
  const { claim } = ctx;
  const verdict = claim.verdict
    ? `${claim.verdict.verdict} — ${claim.verdict.reason || '(no reason given)'}`
    : 'no independent check has run yet';
  const evidence = bullet(claim.verdict?.evidence ?? [], '(none quoted)');
  const survivors = (claim.mutation?.mutants ?? []).filter((m) => m.outcome === 'survived');
  const mutantLines = survivors.length
    ? survivors.map((m) => `- ${m.file}:${m.line_no}  ${m.original.trim()}  →  ${m.mutated.trim()}  (${m.cls})`).join('\n')
    : '(none survived)';
  const rate = claim.mutation?.catchRate;
  const catchLine = claim.mutation
    ? `${claim.mutation.killed + claim.mutation.timeout} of ${claim.mutation.total} planted bugs were caught (catch rate ${rate === null ? 'n/a' : rate})`
    : 'the mutation harness has not run';
  return [
    `Claim: ${claim.claim}`,
    `Stated confidence: ${claim.confidence}`,
    `Spec criteria it supports:\n${bullet(claim.criteria.map((c) => `${c.id}. ${c.text}`))}`,
    `Independent checker verdict: ${verdict}`,
    `Checker evidence (verbatim diff lines):\n${evidence}`,
    `Planted-bug results: ${catchLine}`,
    `Planted bugs the tests did NOT catch:\n${mutantLines}`,
    `Kill condition the author gave: ${claim.killCondition}`,
    `Files: ${claim.files.join(', ')}`,
    `Why it was flagged: ${claim.flags.join(', ') || 'manual'}`,
  ].join('\n\n');
};

const header = (ctx) =>
  [
    `Repository: ${ctx.repo.origin || '(no origin)'}`,
    `On this computer it is at: ${ctx.repo.path} (branch ${ctx.repo.branch} at ${String(ctx.repo.head ?? '').slice(0, 7)}). Work in that folder. Every path below is relative to it.`,
  ].join('\n');

/** AC 17. */
export const proposePrompt = (ctx) =>
  redactText(`${header(ctx)}\n\n${fill(readTemplate('propose.md'), { claim: describeClaim(ctx), test_cmd: ctx.config.test_cmd })}\n\n${CLOSING_SENTENCE}`).text;

/** The build prompt for a chosen approach. */
export const implementPrompt = (ctx, proposal, rejected = []) =>
  redactText(`${header(ctx)}\n\n${fill(readTemplate('implement.md'), {
    claim: describeClaim(ctx),
    proposal: [
      `Title: ${proposal.title}`,
      `Summary: ${proposal.summary}`,
      `Pros: ${proposal.pros.join('; ')}`,
      `Cons: ${proposal.cons.join('; ')}`,
      `Files it expects to touch: ${proposal.touches.join(', ')}`,
    ].join('\n'),
    rejected: rejected.length ? rejected.map((p) => `- ${p.title}: ${p.cons.join('; ')}`).join('\n') : '(none)',
    test_cmd: ctx.config.test_cmd,
    kill_condition: ctx.claim.killCondition,
  })}`).text;
